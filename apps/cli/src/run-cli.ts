import { run } from "@stricli/core";
import pkg from "../package.json" with { type: "json" };
import { app } from "./app.js";
import { loadCredentials } from "./lib/credentials.js";
import { debugLog } from "./lib/debug.js";
import {
	shutdownCliProductAnalytics,
	trackCliFirstRun,
} from "./lib/product-analytics.js";
import { initializeR2StagingCleanup } from "./lib/r2-staging-cleanup.js";

export async function runCli(
	args: readonly string[] = process.argv.slice(2),
): Promise<void> {
	const commandArgs =
		args.length === 0 ||
		(args[0]?.startsWith("--") &&
			args.some((arg) => arg === "--code" || arg.startsWith("--code=")))
			? ["connect", ...args]
			: args;
	const commandName = getTopLevelCommandName(commandArgs);
	debugLog("starting command", { command: commandName, version: pkg.version });
	await initializeR2StagingCleanup();
	try {
		if (commandName !== "doctor" && commandName !== "hooks") {
			try {
				const credentials = loadCredentials();
				trackCliFirstRun({
					commandName,
					isAuthenticated: credentials !== null,
					userId: credentials?.user?.id,
				});
			} catch {
				debugLog("analytics startup failed");
			}
		}
		await run(app, commandArgs, { process });
	} finally {
		await shutdownCliProductAnalytics();
		debugLog("command finished", {
			command: commandName,
			exitCode: process.exitCode ?? 0,
		});
	}
}

function getTopLevelCommandName(args: readonly string[]) {
	const commandName = args.find((argument) => !argument.startsWith("-"));
	switch (commandName) {
		case "connect":
		case "login":
		case "logout":
		case "whoami":
		case "upload":
		case "enable":
		case "disable":
		case "set-org":
		case "doctor":
		case "hooks":
		case "dev":
			return commandName;
		default:
			return "help";
	}
}
