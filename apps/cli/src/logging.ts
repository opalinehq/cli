import { join } from "node:path";
import { getFileSink } from "@logtape/file";
import { configure, dispose } from "@logtape/logtape";
import { ensurePrivateFile, getConfigDir } from "./lib/local-state.js";

export async function setupHookLogging(): Promise<void> {
	const configDir = getConfigDir();
	const logFile = join(configDir, "logs", "hook-upload.log");
	await ensurePrivateFile(logFile, configDir);

	await configure({
		sinks: {
			file: getFileSink(logFile),
		},
		loggers: [
			{
				category: "logtape",
				lowestLevel: "error",
				sinks: ["file"],
			},
			{
				// Hooks must not write to stdout; older LogTape releases announce
				// their configuration on the meta logger unless it is configured.
				category: ["logtape", "meta"],
				lowestLevel: "error",
				parentSinks: "override",
				sinks: ["file"],
			},
			{
				category: ["opaline", "cli"],
				lowestLevel: "debug",
				sinks: ["file"],
			},
		],
	});
}

export { dispose as disposeLogging };
