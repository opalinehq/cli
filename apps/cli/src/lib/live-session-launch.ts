import { spawn } from "node:child_process";
import { join } from "node:path";
import { readCodexThread } from "./codex-thread-family.js";
import type { Credentials } from "./credentials.js";
import { isFileLeaseHeld } from "./file-lease.js";
import {
	getLiveSessionsDirectory,
	isLiveSessionPaused,
} from "./live-session-pause.js";
import {
	type AgentPidSource,
	type LiveSessionSource,
	writeLiveSessionRegistration,
} from "./live-session-registry.js";
import { getConfigDir } from "./local-state.js";
import {
	findAncestorProcess,
	readProcessStartIdentities,
} from "./process-identity.js";

export function getLiveSessionFollowerLeasePath(configDir: string): string {
	return join(getLiveSessionsDirectory(configDir), "follower.lease");
}

/**
 * `OPALINE_LIVE_SESSIONS=0` (or `false`/`off`) turns live session updates off
 * on this machine; uploads are unaffected.
 */
export function isLiveSessionsDisabledByEnvironment(
	environment: NodeJS.ProcessEnv = process.env,
): boolean {
	const value = environment.OPALINE_LIVE_SESSIONS?.trim().toLowerCase();
	return value === "0" || value === "false" || value === "off";
}

export interface AgentProcess {
	readonly pid: number | null;
	readonly pidSource: AgentPidSource;
	readonly identity: string | null;
}

/**
 * The Claude Code process that owns the session: `CLAUDE_PID` when Claude
 * Code provides it, otherwise the hook's parent process.
 */
export function resolveClaudeAgentPid(
	environment: NodeJS.ProcessEnv = process.env,
	parentPid: number = process.ppid,
): { readonly pid: number; readonly pidSource: "env" | "parent" } {
	const value = environment.CLAUDE_PID?.trim();
	if (value && /^\d{1,10}$/u.test(value)) {
		const pid = Number(value);
		if (Number.isSafeInteger(pid) && pid > 1) return { pid, pidSource: "env" };
	}
	return { pid: parentPid, pidSource: "parent" };
}

export async function resolveClaudeAgentProcess(): Promise<AgentProcess> {
	const { pid, pidSource } = resolveClaudeAgentPid();
	if (!(pid > 1)) return { identity: null, pid: null, pidSource: "none" };
	const identity = (await readProcessStartIdentities([pid])).get(pid) ?? null;
	return { identity, pid, pidSource };
}

/** `codex`, or `codex.exe`. */
export function isCodexExecutableName(name: string): boolean {
	return /^codex(?:\.exe)?$/iu.test(name);
}

/**
 * The Codex process that ran the notify command: the nearest ancestor whose
 * executable is `codex` (other notify tools may sit in between).
 */
export async function resolveCodexAgentProcess(): Promise<AgentProcess> {
	try {
		const ancestor = await findAncestorProcess(
			process.pid,
			isCodexExecutableName,
		);
		if (ancestor)
			return {
				identity: ancestor.identity,
				pid: ancestor.pid,
				pidSource: "ancestor",
			};
	} catch {
		// Fall through: the session then ends once its rollout is idle.
	}
	return { identity: null, pid: null, pidSource: "none" };
}

/**
 * Registers a running session with the machine-wide live session follower
 * and makes sure the follower runs. Never throws; returns once the
 * registration is written and, if needed, the launcher is spawned. The
 * launcher starts the follower detached and exits at once, so the follower
 * is not in the hook's process tree when the host ends the hook.
 */
export async function scheduleLiveSessionFollower(input: {
	readonly source: LiveSessionSource;
	readonly sessionId: string;
	readonly transcriptPath: string;
	readonly cwd: string;
	readonly organizationId: string;
	readonly credentials: Credentials;
	readonly resolveAgent: () => Promise<AgentProcess>;
	readonly hookSource?: string;
	readonly onInfo?: (message: string) => void;
	readonly onWarning?: (message: string) => void;
}): Promise<void> {
	try {
		if (isLiveSessionsDisabledByEnvironment()) return;
		if (input.credentials.authType !== "api-key") {
			input.onInfo?.(
				"Live session updates need an ingest API key; run `opaline login` to refresh your credentials.",
			);
			return;
		}
		const configDir = getConfigDir();
		if (isLiveSessionPaused(configDir, input.organizationId)) return;
		const agent = await input.resolveAgent();
		await writeLiveSessionRegistration(
			configDir,
			{
				agentPid: agent.pid,
				agentPidSource: agent.pidSource,
				agentStartIdentity: agent.identity,
				cwd: input.cwd,
				...(input.hookSource ? { hookSource: input.hookSource } : {}),
				organizationId: input.organizationId,
				sessionId: input.sessionId,
				source: input.source,
				startedAt: Date.now(),
				transcriptPath: input.transcriptPath,
				version: 1,
			},
			{ onlyIfChanged: input.source === "codex" },
		);
		// The follower reads registrations every second; a running one (or one
		// about to exit, which re-checks registrations after releasing its
		// lease) picks this one up.
		if (await isFileLeaseHeld(getLiveSessionFollowerLeasePath(configDir)))
			return;
		spawnLiveFollowProcess(true);
	} catch (error) {
		input.onWarning?.(
			`Could not start live session updates: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

/**
 * Registers a Codex thread from the notify hook. Only a user's own top-level
 * threads are registered: sub-agent threads are streams of their parent, and
 * internal threads (guardian reviews; title generation, which has no rollout)
 * are not sessions.
 */
export async function scheduleCodexLiveSession(input: {
	readonly threadId: string;
	readonly transcriptPath: string;
	readonly cwd: string;
	readonly organizationId: string;
	readonly credentials: Credentials;
	readonly onInfo?: (message: string) => void;
	readonly onWarning?: (message: string) => void;
}): Promise<void> {
	try {
		if (isLiveSessionsDisabledByEnvironment()) return;
		const thread = await readCodexThread(input.transcriptPath);
		if (thread?.threadId !== input.threadId || thread.kind !== "root") return;
		await scheduleLiveSessionFollower({
			credentials: input.credentials,
			cwd: input.cwd,
			onInfo: input.onInfo,
			onWarning: input.onWarning,
			organizationId: input.organizationId,
			resolveAgent: resolveCodexAgentProcess,
			sessionId: input.threadId,
			source: "codex",
			transcriptPath: input.transcriptPath,
		});
	} catch (error) {
		input.onWarning?.(
			`Could not start live session updates: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

/**
 * Spawns `opaline hooks live-follow` with the same runtime and entry point
 * as this process, detached (also on Windows: a non-detached child there is
 * ended with its parent's job), with no stdio.
 */
export function spawnLiveFollowProcess(launch: boolean): void {
	const entrypoint = process.argv[1];
	if (!entrypoint) throw new Error("The CLI entrypoint is unknown.");
	const child = spawn(
		process.execPath,
		[
			...process.execArgv,
			...followerRuntimeFlags(),
			entrypoint,
			"hooks",
			"live-follow",
			...(launch ? ["--launch"] : []),
		],
		{
			detached: true,
			env: process.env,
			stdio: "ignore",
			windowsHide: true,
		},
	);
	child.on("error", () => undefined);
	child.unref();
}

/**
 * The follower reads transcripts in bursts (catching up a long session) and
 * then idles for hours. A small V8 young generation keeps its resident memory
 * close to its live heap; Bun takes no such flag.
 */
function followerRuntimeFlags(): string[] {
	if (process.versions.bun !== undefined) return [];
	if (process.execArgv.some((flag) => flag.startsWith("--max-semi-space-size")))
		return [];
	return ["--max-semi-space-size=2"];
}
