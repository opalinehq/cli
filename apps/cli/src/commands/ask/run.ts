import { buildCommand } from "@stricli/core";
import { ConvexClient } from "convex/browser";
import pkg from "../../../package.json" with { type: "json" };
import type { AskBridgeConnection } from "../../contracts/ask.js";
import { agentFor } from "../../lib/ask/agent-selection.js";
import {
	type AnswerResult,
	answerMessage,
} from "../../lib/ask/answer-message.js";
import {
	type BridgeBackend,
	createAskBackend,
} from "../../lib/ask/ask-convex.js";
import {
	askApiBase,
	bridgeConnectFor,
	describeAskError,
} from "../../lib/ask/bridge-connect.js";
import { BridgeSession } from "../../lib/ask/bridge-session.js";
import { runClaude } from "../../lib/ask/claude-runner.js";
import { runCodex } from "../../lib/ask/codex-runner.js";
import { deviceName } from "../../lib/ask/device-name.js";
import { PendingQueue } from "../../lib/ask/pending-queue.js";
import {
	AGENT_NAMES,
	detectProviders,
	type ProviderState,
} from "../../lib/ask/providers.js";
import { type Credentials, loadCredentials } from "../../lib/credentials.js";

const HEARTBEAT_INTERVAL_MS = 15_000;
const RUNNERS = { claude: runClaude, codex: runCodex };

interface AskFlags {
	readonly workspace?: string;
}

async function runAsk(flags: AskFlags): Promise<undefined | Error> {
	const credentials = loadCredentials();
	if (!credentials) return new Error("Run `opaline login` first.");
	const apiBaseUrl = askApiBase(credentials);
	try {
		const connect = await bridgeConnectFor({
			credentials,
			apiBaseUrl,
			workspaceSlug: flags.workspace,
		});
		const session = await BridgeSession.open(connect, (error) =>
			warn(`Could not renew the Opaline connection: ${message(error)}`),
		);
		await runBridge(session, credentials);
	} catch (error) {
		return new Error(describeAskError(error, apiBaseUrl));
	}
}

async function runBridge(
	session: BridgeSession,
	credentials: Credentials,
): Promise<void> {
	const client = new ConvexClient(session.current.convexUrl);
	client.setAuth(session.fetchConvexToken);
	const backend = createAskBackend(client);
	const stop = new AbortController();
	printConnected(session.current, credentials);

	const providers = new ProviderMonitor();
	const heartbeat = startHeartbeat(backend, providers);
	const queue = new PendingQueue(
		(messageId) =>
			answerAndReport(messageId, {
				backend,
				session,
				providers,
				stopSignal: stop.signal,
			}),
		stop.signal,
		(error) => warn(`Could not take a question: ${message(error)}`),
	);
	const unwatch = backend.watchPending(
		(pending) => queue.update(pending),
		(error) => warn(`Lost the question feed: ${error.message}`),
	);
	console.log("Waiting for questions. Press Ctrl-C to stop.");

	await waitForStopSignal();
	console.log("Stopping…");
	stop.abort();
	unwatch();
	heartbeat.stop();
	await queue.settled();
	await client.close();
	console.log("Stopped.");
}

async function answerAndReport(
	messageId: string,
	bridge: {
		readonly backend: BridgeBackend;
		readonly session: BridgeSession;
		readonly providers: ProviderMonitor;
		readonly stopSignal: AbortSignal;
	},
): Promise<void> {
	const result = await answerMessage(messageId, {
		backend: bridge.backend,
		selectAgent: async (provider) =>
			agentFor(provider, await bridge.providers.current(), RUNNERS),
		mcpAccess: bridge.session.mcpAccess,
		stopSignal: bridge.stopSignal,
		onClaimed: (claimed) =>
			console.log(
				`Answering a question with ${AGENT_NAMES[claimed.provider]}…`,
			),
		onWarning: warn,
	});
	printAnswerResult(result);
}

class ProviderMonitor {
	private detected: Promise<ProviderState[]> = detectAndReport();

	current(): Promise<ProviderState[]> {
		return this.detected;
	}

	refresh(): void {
		this.detected = detectAndReport();
	}
}

async function detectAndReport(): Promise<ProviderState[]> {
	const providers = await detectProviders();
	if (!providers.some((provider) => provider.ready))
		warn(
			"Neither Claude Code nor Codex is ready. Install or log in to one of them.",
		);
	return providers;
}

function startHeartbeat(
	backend: BridgeBackend,
	providers: ProviderMonitor,
): { stop(): void } {
	const name = deviceName();
	const beat = async () => {
		try {
			await backend.heartbeat({
				name: await name,
				cliVersion: pkg.version,
				providers: await providers.current(),
			});
		} catch (error) {
			warn(`Heartbeat failed: ${message(error)}`);
		}
	};
	void beat();
	const timer = setInterval(() => void beat(), HEARTBEAT_INTERVAL_MS);
	const redetect = setInterval(
		() => providers.refresh(),
		10 * HEARTBEAT_INTERVAL_MS,
	);
	return {
		stop: () => {
			clearInterval(timer);
			clearInterval(redetect);
		},
	};
}

function waitForStopSignal(): Promise<void> {
	return new Promise((resolve) => {
		const onSignal = () => {
			process.once("SIGINT", () => process.exit(130));
			resolve();
		};
		process.once("SIGINT", onSignal);
		process.once("SIGTERM", onSignal);
	});
}

function printConnected(
	connection: AskBridgeConnection,
	credentials: Credentials,
): void {
	const who = credentials.user?.email ?? "this device";
	console.log(
		`Connected as ${who} to workspace ${connection.workspace.name} (${connection.workspace.slug}).`,
	);
}

function printAnswerResult(result: AnswerResult): void {
	if (result.status === "done") console.log("Done.");
	if (result.status === "failed") console.log(`Failed: ${result.error}`);
	if (result.status === "cancelled") console.log("Cancelled.");
}

function warn(text: string): void {
	console.error(text);
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export const askRunCommand = buildCommand({
	loader: async () => ({ default: runAsk }),
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
	docs: {
		brief: "Answer Ask questions from the Opaline web app with Claude Code",
	},
});
