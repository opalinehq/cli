import { spawn } from "node:child_process";
import type { Credentials } from "./credentials.js";
import { isLiveSessionPaused } from "./live-session-pause.js";
import { getConfigDir } from "./local-state.js";

export interface LiveSessionFollowerTarget {
	readonly agentPid: number;
	readonly cwd: string;
	readonly organizationId: string;
	readonly sessionId: string;
	/** When the SessionStart hook ran (ms since epoch). */
	readonly startedAt: number;
	/** The SessionStart `source` (`startup`, `resume`, `clear`, `compact`). */
	readonly source?: string;
	readonly transcriptPath: string;
}

/**
 * `OPALINE_LIVE_SESSIONS=0` (or `false`/`off`) turns live session updates off
 * on this machine; the upload at session end is unaffected.
 */
export function isLiveSessionsDisabledByEnvironment(
	environment: NodeJS.ProcessEnv = process.env,
): boolean {
	const value = environment.OPALINE_LIVE_SESSIONS?.trim().toLowerCase();
	return value === "0" || value === "false" || value === "off";
}

/**
 * The Claude Code process that owns the session: `CLAUDE_PID` when Claude
 * Code provides it, otherwise the hook's parent process.
 */
export function resolveAgentPid(
	environment: NodeJS.ProcessEnv = process.env,
	parentPid: number = process.ppid,
): number {
	const value = environment.CLAUDE_PID?.trim();
	if (value && /^\d{1,10}$/u.test(value)) {
		const pid = Number(value);
		if (Number.isSafeInteger(pid) && pid > 0) return pid;
	}
	return parentPid;
}

/**
 * Starts the background follower that streams this session's transcript
 * while Claude Code runs. Never throws and returns as soon as the launcher
 * process is spawned: the launcher starts the follower detached and exits at
 * once, so the follower is no longer in the hook's process tree when the
 * host ends the hook.
 */
export function scheduleLiveSessionFollower(
	input: Omit<LiveSessionFollowerTarget, "agentPid" | "startedAt"> & {
		readonly credentials: Credentials;
		readonly onInfo?: (message: string) => void;
		readonly onWarning?: (message: string) => void;
	},
): void {
	try {
		if (isLiveSessionsDisabledByEnvironment()) return;
		if (input.credentials.authType !== "api-key") {
			input.onInfo?.(
				"Live session updates need an ingest API key; run `opaline login` to refresh your credentials.",
			);
			return;
		}
		if (isLiveSessionPaused(getConfigDir(), input.organizationId)) return;
		const agentPid = resolveAgentPid();
		if (!(agentPid > 1)) return;
		spawnLiveFollowProcess(
			{
				agentPid,
				cwd: input.cwd,
				organizationId: input.organizationId,
				sessionId: input.sessionId,
				source: input.source,
				startedAt: Date.now(),
				transcriptPath: input.transcriptPath,
			},
			true,
		);
	} catch (error) {
		input.onWarning?.(
			`Could not start live session updates: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

/**
 * Spawns `opaline hooks claude live-follow` with the same runtime and entry
 * point as this process, detached from it, with no stdio.
 */
export function spawnLiveFollowProcess(
	target: LiveSessionFollowerTarget,
	launch: boolean,
): void {
	const entrypoint = process.argv[1];
	if (!entrypoint) throw new Error("The CLI entrypoint is unknown.");
	const args = [
		...process.execArgv,
		...followerRuntimeFlags(),
		entrypoint,
		"hooks",
		"claude",
		"live-follow",
		...(launch ? ["--launch"] : []),
		`--session-id=${target.sessionId}`,
		`--transcript-path=${target.transcriptPath}`,
		`--cwd=${target.cwd}`,
		`--organization-id=${target.organizationId}`,
		`--agent-pid=${target.agentPid}`,
		`--started-at=${target.startedAt}`,
		...(target.source ? [`--source=${target.source}`] : []),
	];
	// Windows does not end children with their parent, and DETACHED_PROCESS
	// interferes with console-less launches; POSIX detaches into its own
	// session so the host's process-group signals do not reach it.
	const child = spawn(process.execPath, args, {
		detached: process.platform !== "win32",
		env: process.env,
		stdio: "ignore",
		windowsHide: true,
	});
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
