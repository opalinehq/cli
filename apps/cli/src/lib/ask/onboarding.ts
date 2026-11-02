import * as p from "@clack/prompts";
import type { AskBridgeConnection } from "../../contracts/ask.js";
import { cliMessage } from "../cli-messages.js";
import type { Credentials } from "../credentials.js";
import { debugLog } from "../debug.js";
import { bridgeConnectFor, isAskUnavailable } from "./bridge-connect.js";
import {
	AGENT_NAMES,
	detectProviders,
	type ProviderState,
} from "./providers.js";
import {
	type AskServiceWorkspace,
	askServicePlatform,
	installAskService,
	isAskServiceInstalled,
} from "./service.js";

export type AgentConnectResult =
	| "not-shown"
	| "connected"
	| "later"
	| "needs-agent"
	| "install-failed";

export interface AgentConnectScreens {
	offer(): Promise<boolean>;
	connected(agents: string): void;
	needsAgent(): void;
	installFailed(error: string): void;
}

export interface AgentConnectDependencies {
	readonly interactive: boolean;
	readonly serviceSupported: boolean;
	readonly serviceInstalled: () => Promise<boolean>;
	readonly detectProviders: () => Promise<ProviderState[]>;
	readonly connect: () => Promise<AskBridgeConnection>;
	readonly install: (workspace: AskServiceWorkspace) => Promise<void>;
	readonly screens: AgentConnectScreens;
}

export async function connectAgentsAfterUpload(input: {
	readonly credentials: Credentials | undefined;
	readonly apiBaseUrl: string;
	readonly organizationId: string | undefined;
}): Promise<void> {
	const { credentials, organizationId } = input;
	if (!credentials || !organizationId) return;
	try {
		await connectAgents({
			interactive: isInteractiveTerminal(),
			serviceSupported: askServicePlatform() !== undefined,
			serviceInstalled: isAskServiceInstalled,
			detectProviders: () => detectProviders(),
			connect: async () =>
				(
					await bridgeConnectFor({
						credentials,
						apiBaseUrl: input.apiBaseUrl,
						organizationId,
					})
				)(),
			install: installAskService,
			screens: clackAgentScreens,
		});
	} catch (error) {
		debugLog("agent connect failed", {
			message: error instanceof Error ? error.message : String(error),
		});
	}
}

export async function connectAgents(
	dependencies: AgentConnectDependencies,
): Promise<AgentConnectResult> {
	if (!dependencies.interactive || !dependencies.serviceSupported)
		return "not-shown";
	if (await dependencies.serviceInstalled()) return "not-shown";
	const connection = await askConnection(dependencies);
	if (!connection) return "not-shown";
	const ready = (await dependencies.detectProviders()).filter(
		(provider) => provider.ready,
	);
	if (ready.length === 0) {
		dependencies.screens.needsAgent();
		return "needs-agent";
	}
	if (!(await dependencies.screens.offer())) return "later";
	try {
		await dependencies.install({
			slug: connection.workspace.slug,
			name: connection.workspace.name,
		});
	} catch (error) {
		dependencies.screens.installFailed(
			error instanceof Error ? error.message : String(error),
		);
		return "install-failed";
	}
	dependencies.screens.connected(describeAgents(ready));
	return "connected";
}

export function describeAgents(providers: readonly ProviderState[]): string {
	return providers
		.map((provider) =>
			[AGENT_NAMES[provider.kind], provider.version].filter(Boolean).join(" "),
		)
		.join(" and ");
}

async function askConnection(
	dependencies: AgentConnectDependencies,
): Promise<AskBridgeConnection | undefined> {
	try {
		return await dependencies.connect();
	} catch (error) {
		debugLog("agent connect skipped", {
			unavailable: isAskUnavailable(error),
			message: error instanceof Error ? error.message : String(error),
		});
		return undefined;
	}
}

function isInteractiveTerminal(): boolean {
	return Boolean(
		process.stdin.isTTY && process.stdout.isTTY && !process.env.CI,
	);
}

export const clackAgentScreens: AgentConnectScreens = {
	async offer() {
		const choice = await p.select({
			message: `${cliMessage("askConnectTitle")}\n${dim(cliMessage("askConnectSubtitle"))}`,
			options: [
				{ value: "connect", label: cliMessage("askConnect") },
				{ value: "later", label: cliMessage("askLater") },
			],
			initialValue: "connect",
		});
		return !p.isCancel(choice) && choice === "connect";
	},
	connected(agents) {
		p.log.success(cliMessage("askConnected", { agents }));
	},
	needsAgent() {
		p.log.warn(cliMessage("askNeedsAgent"));
	},
	installFailed(error) {
		p.log.warn(
			`Could not connect: ${error}. Run \`opaline connect sub\` to retry.`,
		);
	},
};

function dim(text: string): string {
	return `\u001b[2m${text}\u001b[22m`;
}
