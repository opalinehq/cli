import { buildCommand } from "@stricli/core";
import {
	askApiBase,
	bridgeConnectFor,
	describeAskError,
} from "../../lib/ask/bridge-connect.js";
import { describeAgents } from "../../lib/ask/onboarding.js";
import {
	AGENT_NAMES,
	detectClaude,
	detectCodex,
	detectProviders,
	type ProviderState,
} from "../../lib/ask/providers.js";
import {
	ASK_SERVICE_UNSUPPORTED_MESSAGE,
	askServicePlatform,
	installAskService,
	readAskServiceStatus,
	removeAskService,
} from "../../lib/ask/service.js";
import { cliMessage } from "../../lib/cli-messages.js";
import { loadCredentials } from "../../lib/credentials.js";

async function turnOn(flags: {
	workspace?: string;
}): Promise<undefined | Error> {
	if (!askServicePlatform()) {
		console.log(ASK_SERVICE_UNSUPPORTED_MESSAGE);
		return;
	}
	const credentials = loadCredentials();
	if (!credentials) return new Error("Run `opaline login` first.");
	const ready = (await detectProviders()).filter((provider) => provider.ready);
	if (ready.length === 0) return new Error(cliMessage("askNeedsAgent"));
	const apiBaseUrl = askApiBase(credentials);
	try {
		const connect = await bridgeConnectFor({
			credentials,
			apiBaseUrl,
			workspaceSlug: flags.workspace,
		});
		const { workspace, askUrl } = await connect();
		await installAskService({ slug: workspace.slug, name: workspace.name });
		console.log(cliMessage("askConnected", { agents: describeAgents(ready) }));
		console.log(`Ask is on for ${workspace.name}: ${askUrl}`);
	} catch (error) {
		return new Error(describeAskError(error, apiBaseUrl));
	}
}

async function turnOff(): Promise<undefined> {
	const removed = await removeAskService();
	console.log(
		removed ? "Ask is off." : "Ask was not running in the background.",
	);
}

async function printStatus(): Promise<undefined> {
	const [service, claude, codex] = await Promise.all([
		readAskServiceStatus(),
		detectClaude(),
		detectCodex(),
	]);
	console.log(`Background service: ${describeService(service)}`);
	if (service.workspace)
		console.log(
			`Workspace: ${service.workspace.name} (${service.workspace.slug})`,
		);
	for (const agent of [claude, codex])
		console.log(`${AGENT_NAMES[agent.kind]}: ${describeAgentState(agent)}`);
	if (service.installed) console.log(`Log: ${service.logPath}`);
}

function describeService(
	service: Awaited<ReturnType<typeof readAskServiceStatus>>,
): string {
	if (!service.supported) return "not supported on this system";
	if (!service.installed) return "off";
	return service.running ? "on, running" : "on, not running";
}

function describeAgentState(agent: ProviderState): string {
	if (!agent.version) return "not installed";
	return `${agent.version}, ${agent.ready ? "logged in" : "not logged in"}`;
}

export const askOnCommand = buildCommand({
	loader: async () => ({ default: turnOn }),
	parameters: {
		flags: {
			workspace: {
				kind: "parsed",
				parse: String,
				brief: "Workspace slug to answer questions for",
				optional: true,
			},
		},
	},
	docs: { brief: "Answer Ask questions in the background on this computer" },
});

export const askOffCommand = buildCommand({
	loader: async () => ({ default: turnOff }),
	parameters: {},
	docs: { brief: "Stop answering Ask questions on this computer" },
});

export const askStatusCommand = buildCommand({
	loader: async () => ({ default: printStatus }),
	parameters: {},
	docs: { brief: "Show whether Ask runs on this computer" },
});
