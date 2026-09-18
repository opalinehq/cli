import { run } from "@stricli/core";
import pkg from "../package.json" with { type: "json" };
import { app } from "./app.js";
import { offerCliUpdate, shouldOfferCliUpdate } from "./lib/cli-update.js";
import { getCommandArgs } from "./lib/command-args.js";
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
	const commandArgs = getCommandArgs(args);
	const commandName = getTopLevelCommandName(commandArgs);
	if (
		commandArgs.some((arg) => ["--version", "-v", "--help", "-h"].includes(arg))
	) {
		await run(app, commandArgs, { process });
		return;
	}
	if (
		shouldOfferCliUpdate(
			commandArgs,
			Boolean(process.stdin.isTTY && process.stdout.isTTY),
			Boolean(process.env.CI),
		)
	) {
		try {
			if (await offerCliUpdate(args)) return;
		} catch (error) {
			debugLog("update check failed", {
				message: error instanceof Error ? error.message : String(error),
			});
		}
	}
	debugLog("starting command", { command: commandName, version: pkg.version });
	await initializeR2StagingCleanup();
	try {
		if (
			commandName !== "doctor" &&
			commandName !== "hooks" &&
			commandName !== "update"
		) {
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
	if (!args.length || args[0] === "import") return "upload";
	const commandName = args.find((argument) => !argument.startsWith("-"));
	switch (commandName) {
		case "connect":
		case "login":
		case "logout":
		case "whoami":
		case "upload":
		case "update":
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
