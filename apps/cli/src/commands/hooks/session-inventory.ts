import { getLogger } from "@logtape/logtape";
import { buildCommand } from "@stricli/core";
import {
	isSessionInventoryForced,
	runSessionInventory,
} from "../../lib/session-inventory.js";
import { disposeLogging, setupHookLogging } from "../../logging.js";

async function runSessionInventoryHook(): Promise<undefined> {
	await setupHookLogging();
	const logger = getLogger(["opaline", "cli", "hook"]);
	try {
		const outcome = await runSessionInventory({
			force: isSessionInventoryForced(),
			onWarning: (warning) => logger.warn("{warning}", { warning }),
		});
		logger.info("Session inventory: {outcome}", { outcome });
	} finally {
		await disposeLogging();
	}
}

export const sessionInventoryCommand = buildCommand({
	loader: async () => ({ default: runSessionInventoryHook }),
	parameters: {},
	docs: {
		brief:
			"Report which sessions on this machine Opaline may upload (ids, line counts, sizes, times; no content)",
	},
});
