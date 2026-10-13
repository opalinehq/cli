import { getLogger } from "@logtape/logtape";
import { buildCommand } from "@stricli/core";
import { runLiveSessionFollower } from "../../../lib/live-session-follower.js";
import { spawnLiveFollowProcess } from "../../../lib/live-session-launch.js";
import { disposeLogging, setupHookLogging } from "../../../logging.js";

interface LiveFollowFlags {
	readonly launch?: boolean;
	readonly sessionId: string;
	readonly transcriptPath: string;
	readonly cwd: string;
	readonly organizationId: string;
	readonly agentPid: number;
	readonly startedAt?: number;
	readonly source?: string;
}

/**
 * Background follower started by the Claude Code SessionStart hook. With
 * `--launch` it only starts the detached follower and exits at once (the
 * hook's direct child must not outlive the hook, or the host may end the
 * follower along with the hook). It never writes to stdout or stderr.
 */
async function runLiveFollow(flags: LiveFollowFlags): Promise<undefined> {
	const startedAt = flags.startedAt ?? Date.now();
	if (flags.launch) {
		try {
			spawnLiveFollowProcess(
				{
					agentPid: flags.agentPid,
					cwd: flags.cwd,
					organizationId: flags.organizationId,
					sessionId: flags.sessionId,
					source: flags.source,
					startedAt,
					transcriptPath: flags.transcriptPath,
				},
				false,
			);
		} catch (error) {
			await setupHookLogging();
			getLogger(["opaline", "cli", "hook"]).warn(
				"Could not start live session updates: {error}",
				{ error: error instanceof Error ? error.message : String(error) },
			);
			await disposeLogging();
		}
		return;
	}
	try {
		await setupHookLogging();
		await runLiveSessionFollower({
			agentPid: flags.agentPid,
			cwd: flags.cwd,
			organizationId: flags.organizationId,
			sessionId: flags.sessionId,
			source: flags.source,
			startedAt,
			transcriptPath: flags.transcriptPath,
		});
	} catch {
		// Detached: there is nowhere to report this, and nothing to clean up.
	} finally {
		await disposeLogging().catch(() => undefined);
		// A stray handle (for example a pooled connection) must not keep a
		// detached follower alive after it has finished.
		setTimeout(() => process.exit(0), 2_000).unref();
	}
}

function parsePositiveInteger(value: string): number {
	if (!/^\d{1,16}$/u.test(value)) throw new SyntaxError("Expected a number");
	const number = Number(value);
	if (!Number.isSafeInteger(number) || number <= 0)
		throw new SyntaxError("Expected a positive integer");
	return number;
}

export const liveFollowCommand = buildCommand({
	loader: async () => ({ default: runLiveFollow }),
	parameters: {
		flags: {
			launch: {
				kind: "boolean",
				optional: true,
				brief: "Start the detached follower and exit",
			},
			sessionId: { kind: "parsed", parse: String, brief: "Session id" },
			transcriptPath: {
				kind: "parsed",
				parse: String,
				brief: "Transcript path",
			},
			cwd: { kind: "parsed", parse: String, brief: "Session directory" },
			organizationId: {
				kind: "parsed",
				parse: String,
				brief: "Workspace id",
			},
			agentPid: {
				kind: "parsed",
				parse: parsePositiveInteger,
				brief: "Claude Code process id",
			},
			startedAt: {
				kind: "parsed",
				parse: parsePositiveInteger,
				optional: true,
				brief: "SessionStart time (ms since epoch)",
			},
			source: {
				kind: "parsed",
				parse: String,
				optional: true,
				brief: "SessionStart source",
			},
		},
	},
	docs: { brief: "Stream a running Claude Code session (internal)" },
});
