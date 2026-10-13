import { getLogger } from "@logtape/logtape";
import { buildCommand } from "@stricli/core";
import { runLiveSessionFollower } from "../../lib/live-session-follower.js";
import { spawnLiveFollowProcess } from "../../lib/live-session-launch.js";
import { disposeLogging, setupHookLogging } from "../../logging.js";

/**
 * The machine-wide live session follower, started by the Claude Code
 * SessionStart and Codex notify hooks. With `--launch` it only starts the
 * detached follower and exits at once: the hook's direct child must not
 * outlive the hook, or the host may end the follower along with the hook.
 * It never writes to stdout or stderr.
 */
async function runLiveFollow(flags: {
	readonly launch?: boolean;
}): Promise<undefined> {
	if (flags.launch) {
		try {
			spawnLiveFollowProcess(false);
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
		await runLiveSessionFollower();
	} catch {
		// Detached: there is nowhere to report this, and nothing to clean up.
	} finally {
		await disposeLogging().catch(() => undefined);
		// A stray handle (for example a pooled connection) must not keep a
		// detached follower alive after it has finished.
		setTimeout(() => process.exit(0), 2_000).unref();
	}
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
		},
	},
	docs: { brief: "Stream running agent sessions (internal)" },
});
