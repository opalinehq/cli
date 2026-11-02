import * as p from "@clack/prompts";
import type { AskBridgeConnection } from "../../contracts/ask.js";
import { cliMessage } from "../cli-messages.js";
import type { Credentials } from "../credentials.js";
import { debugLog } from "../debug.js";
import { bridgeConnectFor, isAskUnavailable } from "./bridge-connect.js";
import { detectClaude, type ProviderState } from "./providers.js";
import {
	type AskServiceWorkspace,
	askServicePlatform,
	installAskService,
	isAskServiceInstalled,
} from "./service.js";

export type AskOfferResult =
	| "not-shown"
	| "claude-login"
	| "declined"
	| "turned-on"
	| "install-failed";

export interface AskOfferScreens {
	offer(version: string): Promise<boolean>;
	askOn(url: string): void;
	claudeLogin(version: string): void;
	installFailed(error: string): void;
}

export interface AskOfferDependencies {
	readonly interactive: boolean;
	readonly serviceSupported: boolean;
	readonly serviceInstalled: () => Promise<boolean>;
	readonly detectClaude: () => Promise<ProviderState>;
	readonly connect: () => Promise<AskBridgeConnection>;
	readonly install: (workspace: AskServiceWorkspace) => Promise<void>;
	readonly screens: AskOfferScreens;
}

export async function offerAskAfterUpload(input: {
	readonly credentials: Credentials | undefined;
	readonly apiBaseUrl: string;
	readonly organizationId: string | undefined;
}): Promise<void> {
	const { credentials, organizationId } = input;
	if (!credentials || !organizationId) return;
	try {
		await offerAsk({
			interactive: isInteractiveTerminal(),
			serviceSupported: askServicePlatform() !== undefined,
			serviceInstalled: isAskServiceInstalled,
			detectClaude: () => detectClaude(),
			connect: async () =>
				(
					await bridgeConnectFor({
						credentials,
						apiBaseUrl: input.apiBaseUrl,
						organizationId,
					})
				)(),
			install: installAskService,
			screens: clackAskScreens,
		});
	} catch (error) {
		debugLog("ask offer failed", {
			message: error instanceof Error ? error.message : String(error),
		});
	}
}

function isInteractiveTerminal(): boolean {
	return Boolean(
		process.stdin.isTTY && process.stdout.isTTY && !process.env.CI,
	);
}

export async function offerAsk(
	dependencies: AskOfferDependencies,
): Promise<AskOfferResult> {
	if (!dependencies.interactive || !dependencies.serviceSupported)
		return "not-shown";
	if (await dependencies.serviceInstalled()) return "not-shown";
	const claude = await dependencies.detectClaude();
	if (!claude.version) return "not-shown";
	const connection = await askConnection(dependencies);
	if (!connection) return "not-shown";
	const workspace = {
		slug: connection.workspace.slug,
		name: connection.workspace.name,
	};
	if (!claude.ready) {
		dependencies.screens.claudeLogin(claude.version);
		return "claude-login";
	}
	if (!(await dependencies.screens.offer(claude.version))) return "declined";
	try {
		await dependencies.install(workspace);
	} catch (error) {
		dependencies.screens.installFailed(
			error instanceof Error ? error.message : String(error),
		);
		return "install-failed";
	}
	dependencies.screens.askOn(connection.askUrl);
	return "turned-on";
}

async function askConnection(
	dependencies: AskOfferDependencies,
): Promise<AskBridgeConnection | undefined> {
	try {
		return await dependencies.connect();
	} catch (error) {
		debugLog("ask offer skipped", {
			unavailable: isAskUnavailable(error),
			message: error instanceof Error ? error.message : String(error),
		});
		return undefined;
	}
}

export const clackAskScreens: AskOfferScreens = {
	async offer(version) {
		const choice = await p.select({
			message: [
				cliMessage("askOfferTitle"),
				dim(cliMessage("askOfferBody", { version })),
				dim(cliMessage("askOfferOff")),
			].join("\n"),
			options: [
				{ value: "on", label: cliMessage("askTurnOn") },
				{ value: "later", label: cliMessage("askNotNow") },
			],
			initialValue: "on",
		});
		return !p.isCancel(choice) && choice === "on";
	},
	askOn(url) {
		p.log.success(cliMessage("askOn"));
		p.log.info(cliMessage("askFirstQuestion", { url }));
	},
	claudeLogin(version) {
		p.log.warn(
			[
				cliMessage("askClaudeLogin", { version }),
				cliMessage("askClaudeLoginNext"),
			].join("\n"),
		);
	},
	installFailed(error) {
		p.log.warn(
			`Could not turn on Ask: ${error}\nTry again with \`opaline ask on\`.`,
		);
	},
};

function dim(text: string): string {
	return `\u001b[2m${text}\u001b[22m`;
}
