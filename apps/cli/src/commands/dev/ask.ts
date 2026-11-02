import { hostname } from "node:os";
import { ORPCError } from "@orpc/client";
import { buildCommand } from "@stricli/core";
import { ConvexClient } from "convex/browser";
import pkg from "../../../package.json" with { type: "json" };
import type { AskBridgeConnection } from "../../contracts/ask.js";
import { createApiClient } from "../../lib/api-client.js";
import { getApiBaseOverride } from "../../lib/api-target.js";
import {
	type AnswerResult,
	answerMessage,
} from "../../lib/ask/answer-message.js";
import {
	type BridgeBackend,
	createAskBackend,
} from "../../lib/ask/ask-convex.js";
import { BridgeSession } from "../../lib/ask/bridge-session.js";
import { resolveBridgeOrganizationId } from "../../lib/ask/bridge-workspace.js";
import { runClaude } from "../../lib/ask/claude-runner.js";
import { loadDeviceId } from "../../lib/ask/device-id.js";
import { PendingQueue } from "../../lib/ask/pending-queue.js";
import { detectClaude, type ProviderState } from "../../lib/ask/providers.js";
import { type Credentials, loadCredentials } from "../../lib/credentials.js";

const HEARTBEAT_INTERVAL_MS = 15_000;

interface AskFlags {
	readonly workspace?: string;
}

async function runAsk(flags: AskFlags): Promise<undefined | Error> {
	const credentials = loadCredentials();
	if (!credentials) return new Error("Run `opaline login` first.");
	const apiBaseUrl = getApiBaseOverride() ?? credentials.apiBaseUrl;
	try {
		const session = await openSession(credentials, apiBaseUrl, flags.workspace);
		await runBridge(session, credentials);
	} catch (error) {
		return new Error(describeStartupError(error, apiBaseUrl));
	}
}

async function openSession(
	credentials: Credentials,
	apiBaseUrl: string,
	workspaceSlug: string | undefined,
): Promise<BridgeSession> {
	const api = createApiClient({ ...credentials, apiBaseUrl });
	const organizationId = await resolveBridgeOrganizationId({
		slug: workspaceSlug,
		credentials,
		listOrganizations: () => api.listMyOrganizations(),
	});
	const deviceId = await loadDeviceId();
	return BridgeSession.open(
		() => api.ask.bridgeConnect({ organizationId, deviceId }),
		(error) =>
			warn(`Could not renew the Opaline connection: ${message(error)}`),
	);
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

	const heartbeat = startHeartbeat(backend);
	const queue = new PendingQueue(
		(messageId) => answerAndReport(messageId, backend, session, stop.signal),
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
	backend: BridgeBackend,
	session: BridgeSession,
	stopSignal: AbortSignal,
): Promise<void> {
	const result = await answerMessage(messageId, {
		backend,
		runAgent: runClaude,
		mcpAccess: session.mcpAccess,
		stopSignal,
		onClaimed: () => console.log("Answering a question…"),
		onWarning: warn,
	});
	printAnswerResult(result);
}

function startHeartbeat(backend: BridgeBackend): { stop(): void } {
	let providers: Promise<ProviderState[]> = detectProviders();
	const beat = async () => {
		try {
			await backend.heartbeat({
				name: hostname(),
				cliVersion: pkg.version,
				providers: await providers,
			});
		} catch (error) {
			warn(`Heartbeat failed: ${message(error)}`);
		}
	};
	void beat();
	const timer = setInterval(() => void beat(), HEARTBEAT_INTERVAL_MS);
	const redetect = setInterval(() => {
		providers = detectProviders();
	}, 10 * HEARTBEAT_INTERVAL_MS);
	return {
		stop: () => {
			clearInterval(timer);
			clearInterval(redetect);
		},
	};
}

async function detectProviders(): Promise<ProviderState[]> {
	const claude = await detectClaude();
	if (!claude.version) warn("Claude Code is not installed.");
	else if (!claude.ready)
		warn("Claude Code is not logged in — run `claude` once.");
	return [claude];
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

function describeStartupError(error: unknown, apiBaseUrl: string): string {
	if (error instanceof ORPCError && error.code === "FORBIDDEN")
		return "Ask is not turned on for this workspace, or you are not a member of it.";
	if (error instanceof ORPCError && error.code === "PRECONDITION_FAILED")
		return "Ask is not available on this Opaline server yet.";
	if (error instanceof TypeError && error.message === "fetch failed")
		return `Could not reach Opaline at ${apiBaseUrl}.`;
	return message(error);
}

function warn(text: string): void {
	console.error(text);
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export const askCommand = buildCommand({
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
