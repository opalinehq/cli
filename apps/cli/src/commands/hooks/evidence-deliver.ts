import { getLogger } from "@logtape/logtape";
import { buildCommand } from "@stricli/core";
import { loadCredentials } from "../../lib/credentials.js";
import { deliverPendingSessionEvidenceInBackground } from "../../lib/session-evidence.js";
import { disposeLogging, setupHookLogging } from "../../logging.js";

/**
 * Detached background step started by the session hooks. It delivers the
 * repository evidence captures that the hook spooled but could not deliver
 * within its own budget, so a host's hook timeout never costs a capture.
 */
async function runEvidenceDeliver(): Promise<undefined> {
	await setupHookLogging();
	const logger = getLogger(["opaline", "cli", "hook"]);
	try {
		const credentials = loadCredentials();
		if (!credentials?.user) return;
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
