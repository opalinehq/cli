import { buildCommand } from "@stricli/core";
import {
	askApiBase,
	bridgeConnectFor,
	describeAskError,
} from "../../lib/ask/bridge-connect.js";
import { detectClaude, type ProviderState } from "../../lib/ask/providers.js";
import {
	ASK_SERVICE_UNSUPPORTED_MESSAGE,
	askServicePlatform,
	installAskService,
	readAskServiceStatus,
	removeAskService,
} from "../../lib/ask/service.js";
import { loadCredentials } from "../../lib/credentials.js";
import { getAskUrl } from "../../lib/dashboard-url.js";

async function turnOn(flags: {
	workspace?: string;
}): Promise<undefined | Error> {
	if (!askServicePlatform()) {
		console.log(ASK_SERVICE_UNSUPPORTED_MESSAGE);
		return;
	}
	const credentials = loadCredentials();
	if (!credentials) return new Error("Run `opaline login` first.");
	const claudeProblem = describeClaudeProblem(await detectClaude());
	if (claudeProblem) return new Error(claudeProblem);
	const apiBaseUrl = askApiBase(credentials);
	try {
		const connect = await bridgeConnectFor({
			credentials,
			apiBaseUrl,
			workspaceSlug: flags.workspace,
		});
		const { workspace } = await connect();
		await installAskService({ slug: workspace.slug, name: workspace.name });
		console.log(`Ask is on for ${workspace.name}.`);
		console.log(
			`Ask your first question at ${getAskUrl(`${apiBaseUrl}/rpc`, workspace.slug)}`,
		);
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
	const [service, claude] = await Promise.all([
		readAskServiceStatus(),
		detectClaude(),
	]);
	console.log(`Background service: ${describeService(service)}`);
	if (service.workspace)
		console.log(
			`Workspace: ${service.workspace.name} (${service.workspace.slug})`,
		);
	console.log(`Claude Code: ${describeClaude(claude)}`);
	if (service.installed) console.log(`Log: ${service.logPath}`);
}

function describeService(
	service: Awaited<ReturnType<typeof readAskServiceStatus>>,
): string {
	if (!service.supported) return "not supported on this system";
	if (!service.installed) return "off";
	return service.running ? "on, running" : "on, not running";
}

function describeClaude(claude: ProviderState): string {
	if (!claude.version) return "not installed";
	return `${claude.version}, ${claude.ready ? "logged in" : "not logged in"}`;
}

function describeClaudeProblem(claude: ProviderState): string | undefined {
	if (!claude.version)
		return "Claude Code is not installed. Install it, run `claude` once, then `opaline ask on`.";
	if (!claude.ready)
		return "Claude Code is not logged in. Run `claude` once, then `opaline ask on`.";
	return undefined;
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
