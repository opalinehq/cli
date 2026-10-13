import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { codexThreadFromFirstRecord } from "./codex-thread-family.js";
import type { Credentials } from "./credentials.js";
import { type FileLeaseOptions, isFileLeaseHeld } from "./file-lease.js";
import {
	getLiveTranscriptRoots,
	isAllowedTranscriptPath,
	readFirstJsonLine,
} from "./live-session-paths.js";
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
	isValidPid,
	readLinuxStartIdentitySync,
	STARTUP_PARENT_PID,
} from "./process-identity.js";

export function getLiveSessionFollowerLeasePath(configDir: string): string {
	return join(getLiveSessionsDirectory(configDir), "follower.lease");
}

/**
 * The follower renews its lease every 5 s; a lease not renewed for a minute
 * (a stopped or replaced owner, or an unrelated process that reused its
 * PID) is taken over.
 */
export const LIVE_FOLLOWER_LEASE_OPTIONS: FileLeaseOptions = {
	hardStaleMs: 60_000,
	heartbeatMs: 5_000,
	ownerlessGraceMs: 10_000,
};

const FOLLOWER_MARKER = "follower.json";

/**
 * Written by the follower into its lease: which process holds it, so a lease
 * whose owner PID now belongs to an unrelated process is not trusted.
 */
export async function writeFollowerMarker(configDir: string): Promise<void> {
	await writeFile(
		join(getLiveSessionFollowerLeasePath(configDir), FOLLOWER_MARKER),
		JSON.stringify({
			identity: readLinuxStartIdentitySync(process.pid),
			pid: process.pid,
		}),
		{ mode: 0o600 },
	);
}

/**
 * Whether a working follower holds the lease: renewed recently by its main
 * loop, and owned by the process its marker names (on Linux also with the
 * same start time). A lease without a marker gets two seconds to show one.
 */
export async function isHealthyFollowerRunning(
	configDir: string,
): Promise<boolean> {
	const lease = getLiveSessionFollowerLeasePath(configDir);
	if (!(await isFileLeaseHeld(lease, LIVE_FOLLOWER_LEASE_OPTIONS)))
		return false;
	const deadline = performance.now() + 2_000;
	while (true) {
		const [owner, marker] = await Promise.all([
			readFile(join(lease, "owner"), "utf8").catch(() => undefined),
			readFile(join(lease, FOLLOWER_MARKER), "utf8").catch(() => undefined),
		]);
		if (owner !== undefined && marker !== undefined) {
			try {
				const parsed = JSON.parse(marker) as {
					pid?: unknown;
					identity?: unknown;
				};
				const ownerPid = Number(owner.split(":", 1)[0]);
				if (parsed.pid !== ownerPid) return false;
				if (typeof parsed.identity === "string") {
					const current = readLinuxStartIdentitySync(ownerPid);
					if (current !== null && current !== parsed.identity) return false;
				}
				return true;
			} catch {
				return false;
			}
		}
		if (performance.now() >= deadline) return false;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

/** Moves an untrustworthy follower lease aside so a new follower can start. */
export async function discardFollowerLease(configDir: string): Promise<void> {
	const lease = getLiveSessionFollowerLeasePath(configDir);
	const aside = `${lease}.stale.${randomUUID()}`;
	try {
		await rename(lease, aside);
	} catch {
		return;
	}
	await rm(aside, { force: true, recursive: true }).catch(() => undefined);
}

/**
 * Inside a Codex sandbox (no network, restricted files) a follower could hold
 * the machine-wide lease without being able to do its work, so hooks there
 * only register their session.
 */
export function isSandboxedEnvironment(
	environment: NodeJS.ProcessEnv = process.env,
): boolean {
	return Boolean(
		environment.CODEX_SANDBOX?.trim() ||
			environment.CODEX_SANDBOX_NETWORK_DISABLED?.trim(),
	);
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
		if (isValidPid(pid)) return { pid, pidSource: "env" };
	}
	return { pid: parentPid, pidSource: "parent" };
}

/**
 * No `ps` in the hook: on Linux the start identity is read from `/proc`; on
 * macOS the follower records it when it first sees the registration.
 */
export async function resolveClaudeAgentProcess(): Promise<AgentProcess> {
	const { pid, pidSource } = resolveClaudeAgentPid();
	if (!isValidPid(pid)) return { identity: null, pid: null, pidSource: "none" };
	return { identity: readLinuxStartIdentitySync(pid), pid, pidSource };
}

/** `codex`, or `codex.exe`. */
export function isCodexExecutableName(name: string): boolean {
	return /^codex(?:\.exe)?$/iu.test(name);
}

/**
 * The Codex process that ran the notify command: the nearest ancestor whose
 * executable is `codex` (other notify tools may sit in between). Start this
 * at the very beginning of the hook: `codex exec` may exit right after
 * spawning the notify command. If the hook's parent is already gone, the
 * session is registered as exited and ends once flushed.
 */
export function startCodexAgentLookup(): Promise<AgentProcess> {
	const none: AgentProcess = { identity: null, pid: null, pidSource: "none" };
	if (isLiveSessionsDisabledByEnvironment()) return Promise.resolve(none);
	return findAncestorProcess(isCodexExecutableName, STARTUP_PARENT_PID, 500)
		.then((lookup): AgentProcess => {
			if (lookup.kind === "found")
				return {
					identity: lookup.identity,
					pid: lookup.pid,
					pidSource: "ancestor",
				};
			if (lookup.kind === "exited")
				return { identity: null, pid: null, pidSource: "exited" };
			return none;
		})
		.catch(() => none);
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
		if (
			!(await isAllowedTranscriptPath(
				input.source,
				input.transcriptPath,
				getLiveTranscriptRoots(),
			))
		) {
			input.onInfo?.(
				"Live session updates skipped: the transcript is outside the agent's transcript directory.",
			);
			return;
		}
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
		if (isSandboxedEnvironment()) return;
		// The follower reads registrations every second; a running one (or one
		// about to exit, which re-checks registrations after releasing its
		// lease) picks this one up.
		if (await isHealthyFollowerRunning(configDir)) return;
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
	/** From `startCodexAgentLookup()`, started when the hook began. */
	readonly agent: Promise<AgentProcess>;
	readonly onInfo?: (message: string) => void;
	readonly onWarning?: (message: string) => void;
}): Promise<void> {
	try {
		if (isLiveSessionsDisabledByEnvironment()) return;
		const thread = codexThreadFromFirstRecord(
			await readFirstJsonLine(input.transcriptPath),
			input.transcriptPath,
		);
		if (thread?.threadId !== input.threadId || thread.kind !== "root") return;
		await scheduleLiveSessionFollower({
			credentials: input.credentials,
			cwd: input.cwd,
			onInfo: input.onInfo,
			onWarning: input.onWarning,
			organizationId: input.organizationId,
			resolveAgent: () => input.agent,
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
export function spawnLiveFollowProcess(
	launch: boolean,
	environment: NodeJS.ProcessEnv = process.env,
): void {
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
			env: environment,
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
