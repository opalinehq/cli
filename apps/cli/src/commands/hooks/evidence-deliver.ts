import { getLogger } from "@logtape/logtape";
import { buildCommand } from "@stricli/core";
import { sweepClaudeTaskOutputs } from "../../lib/claude-task-output-sweep.js";
import { loadCredentials } from "../../lib/credentials.js";
import {
	captureAndUploadSessionEvidence,
	deliverPendingSessionEvidenceInBackground,
} from "../../lib/session-evidence.js";
import { deliverImageBacklog } from "../../lib/session-image-backlog.js";
import { disposeLogging, setupHookLogging } from "../../logging.js";

/**
 * Detached background step started by the session hooks. It delivers the
 * repository evidence captures that the hook spooled but could not deliver
 * within its own budget, so a host's hook timeout never costs a capture.
 * Until it is complete, it first runs the one-time capture of task outputs
 * of earlier Claude Code sessions. Last, it takes the follow-up captures of
 * sessions whose images did not fit their delivered captures.
 */
async function runEvidenceDeliver(): Promise<undefined> {
	await setupHookLogging();
	const logger = getLogger(["opaline", "cli", "hook"]);
	try {
		const credentials = loadCredentials();
		if (!credentials?.user) return;
		try {
			const sweep = await sweepClaudeTaskOutputs({
				capture: captureAndUploadSessionEvidence,
				credentials,
				onWarning: (warning) => logger.warn("{warning}", { warning }),
			});
			if (sweep.captured + sweep.failed > 0)
				logger.info(
					"Task outputs of earlier sessions: {captured} captured, {skipped} skipped, {failed} failed ({status})",
					{ ...sweep },
				);
		} catch (error) {
			logger.warn("Task output sweep failed: {error}", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
		const result = await deliverPendingSessionEvidenceInBackground(
			credentials,
			{ onWarning: (warning) => logger.warn("{warning}", { warning }) },
		);
		if (result.alreadyRunning) return;
		if (result.delivered + result.deferred + result.busy > 0)
			logger.info(
				"Background repository evidence delivery: {delivered} delivered, {deferred} deferred, {busy} in progress elsewhere",
				{
					busy: result.busy,
					deferred: result.deferred,
					delivered: result.delivered,
				},
			);
		const backlog = await deliverImageBacklog({
			capture: captureAndUploadSessionEvidence,
			credentials,
			onWarning: (warning) => logger.warn("{warning}", { warning }),
		});
		if (backlog.captured + backlog.failed > 0)
			logger.info(
				"Images left by earlier captures: {captured} follow-up captures, {waiting} waiting, {failed} failed",
				{ ...backlog },
			);
	} catch (error) {
		logger.warn("Background repository evidence delivery failed: {error}", {
			error: error instanceof Error ? error.message : String(error),
		});
	} finally {
		await disposeLogging();
	}
}

export const evidenceDeliverCommand = buildCommand({
	loader: async () => ({ default: runEvidenceDeliver }),
	parameters: {},
	docs: { brief: "Deliver spooled repository evidence in the background" },
});
