import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

/**
 * Shared machinery for driving the built CLI end-to-end against a real API
 * server. Extracted from api-upload.integration.ts so the release-pressure and
 * version-skew suites exercise the same artifact the same way.
 *
 * This file must not match Bun's default test glob (`*.test.ts`), because
 * importing a test file executes its tests.
 */

export const MONOREPO_ROOT = resolve(
	import.meta.dir,
	"..",
	"..",
	"..",
	"..",
	"..",
);
export const BUILT_CLI_PATH = join(
	MONOREPO_ROOT,
	"apps",
	"cli",
	"dist",
	"cli.js",
);
export const REDACTION_FIXTURE_DIR = resolve(
	import.meta.dir,
	"..",
	"fixtures",
	"redaction",
);
export const EXPECTED_CLAUDE_REDACTION_SUMMARY =
	"4 values matching known secret patterns were redacted (aws-access-key-id ×1, github-pat ×1, openai-api-key ×1, slack-webhook-url ×1, 187 B).";

export interface FixtureSecret {
	readonly placeholder: string;
	readonly ruleId: string;
	readonly value: string;
}

export interface BoundaryObservation {
	readonly leakedRuleIds: readonly string[];
	readonly markerCounts: Readonly<Record<string, number>>;
	readonly requestCount: number;
}

export interface BoundaryRelay {
	readonly baseUrl: string;
	readonly rpcUrl: string;
	readonly getObservation: () => BoundaryObservation;
	readonly stop: () => Promise<void>;
}

export interface BoundaryRelayOptions {
	/**
	 * Chaos mode: answer the first `n` body-bearing requests with `status`
	 * instead of forwarding them upstream. The request body is still observed
	 * (counted and scanned for canaries/markers) before the synthetic failure,
	 * so retry tests can prove every attempt crossed the boundary clean.
	 */
	readonly failFirstN?: { readonly n: number; readonly status: number };
}

export interface BuiltCliOptions {
	readonly configDir: string;
	readonly env?: Readonly<Record<string, string>>;
	readonly home: string;
	readonly stdin?: string;
	/** Absolute path to the CLI entry to run. Defaults to the built artifact. */
	readonly cliPath?: string;
}

export interface BuiltCliResult {
	readonly exitCode: number;
	readonly stderr: string;
	readonly stdout: string;
}

export interface RedactionTemplates {
	readonly claudeSession: string;
	readonly claudeSubagent: string;
	readonly codexSession: string;
}

export function createClaudeFixtureSecrets(): readonly FixtureSecret[] {
	return [
		{
			placeholder: "{{OPENAI_CANARY}}",
			ruleId: "openai-api-key",
			value: `sk-${"CANARY".padEnd(20, "A")}T3BlbkFJ${"CANARY".padEnd(20, "B")}`,
		},
		{
			placeholder: "{{GITHUB_CANARY}}",
			ruleId: "github-pat",
			value: `ghp_${"CANARY".padEnd(36, "G")}`,
		},
		{
			placeholder: "{{SLACK_WEBHOOK_CANARY}}",
			ruleId: "slack-webhook-url",
			value: `https://hooks.slack.com/services/${"CANARY".padEnd(43, "S")}`,
		},
		{
			placeholder: "{{AWS_CANARY}}",
			ruleId: "aws-access-key-id",
			value: "AKIACANARY234567ABCD",
		},
	];
}

export function createCodexFixtureSecrets(): readonly FixtureSecret[] {
	return [
		{
			placeholder: "{{ANTHROPIC_CANARY}}",
			ruleId: "anthropic-api-key",
			value: `sk-ant-api03-${"CANARY".padEnd(93, "A")}AA`,
		},
		{
			placeholder: "{{STRIPE_CANARY}}",
			ruleId: "stripe-access-token",
			value: `sk_live_${"CANARY".padEnd(24, "S")}`,
		},
		{
			placeholder: "{{SENDGRID_CANARY}}",
			ruleId: "sendgrid-api-token",
			value: `SG.${"CANARY".padEnd(66, "G")}`,
		},
	];
}

export async function readRedactionTemplates(): Promise<RedactionTemplates> {
	const [claudeSession, claudeSubagent, codexSession] = await Promise.all([
		readFile(
			join(REDACTION_FIXTURE_DIR, "claude-session.jsonl.template"),
			"utf8",
		),
		readFile(
			join(REDACTION_FIXTURE_DIR, "claude-subagent.jsonl.template"),
			"utf8",
		),
		readFile(
			join(REDACTION_FIXTURE_DIR, "codex-session.jsonl.template"),
			"utf8",
		),
	]);
	return { claudeSession, claudeSubagent, codexSession };
}

export function renderFixture(
	template: string,
	sessionId: string,
	secrets: readonly FixtureSecret[],
	redacted: boolean,
): string {
	let rendered = template.replaceAll("{{SESSION_ID}}", sessionId);
	for (const secret of secrets) {
		if (!rendered.includes(secret.placeholder)) {
			continue;
		}
		rendered = rendered.replaceAll(
			secret.placeholder,
			redacted ? `[REDACTED:${secret.ruleId}]` : secret.value,
		);
	}

	const unresolvedPlaceholder = rendered.match(/\{\{[A-Z_]+\}\}/u)?.[0];
	if (unresolvedPlaceholder) {
		throw new Error(
			`Unresolved redaction fixture placeholder: ${unresolvedPlaceholder}`,
		);
	}
	return rendered;
}

export async function buildCliArtifact(): Promise<void> {
	const proc = Bun.spawn(["bun", "run", "--cwd", "apps/cli", "build"], {
		cwd: MONOREPO_ROOT,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	if (exitCode !== 0) {
		throw new Error(
			`Failed to build the CLI artifact (${exitCode}).\nstdout: ${stdout}\nstderr: ${stderr}`,
		);
	}
}

export async function getNodeMajorVersion(): Promise<number> {
	const proc = Bun.spawn(["node", "--version"], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	if (exitCode !== 0) {
		throw new Error(
			"The Node.js runtime required for the built CLI smoke test is unavailable",
		);
	}
	return Number.parseInt(
		stdout.trim().replace(/^v/u, "").split(".")[0] ?? "",
		10,
	);
}

export async function writeCliCredentials(
	configDir: string,
	token: string,
	apiBaseUrl: string,
	authType: "bearer" | "api-key" = "bearer",
): Promise<void> {
	await writeFile(
		join(configDir, "credentials.json"),
		JSON.stringify({
			token,
			apiBaseUrl,
			authType,
		}),
	);
}

export async function runBuiltCli(
	args: readonly string[],
	options: BuiltCliOptions,
): Promise<BuiltCliResult> {
	const proc = Bun.spawn(["node", options.cliPath ?? BUILT_CLI_PATH, ...args], {
		cwd: MONOREPO_ROOT,
		env: {
			...process.env,
			HOME: options.home,
			USERPROFILE: options.home,
			OPALINE_CONFIG_DIR: options.configDir,
			OPALINE_SESSION_INVENTORY: "0",
			POSTHOG_ENABLED: "false",
			...options.env,
		},
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	proc.stdin.write(options.stdin ?? "");
	proc.stdin.end();

	const timeout = setTimeout(() => proc.kill(), 45_000);
	const [exitCode, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	clearTimeout(timeout);
	return { exitCode, stdout, stderr };
}

const activeBoundaryRelays: BoundaryRelay[] = [];

/**
 * Starts an observing relay in front of the real integration server: every
 * byte is forwarded unmodified, while only safe counts and booleans are
 * retained. Relays register themselves; call stopAllBoundaryRelays() from an
 * afterAll instead of tracking each one by hand.
 */
export function startBoundaryRelay(
	getTargetBaseUrl: () => string,
	ensureTargetAlive: () => Promise<void>,
	secrets: readonly FixtureSecret[],
	options: BoundaryRelayOptions = {},
): BoundaryRelay {
	let requestCount = 0;
	const leakedRuleIds = new Set<string>();
	const markerCounts: Record<string, number> = {};

	const relayServer = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const incomingUrl = new URL(request.url);
			const requestBody =
				request.method === "GET" || request.method === "HEAD"
					? undefined
					: await request.arrayBuffer();
			const bodyText =
				requestBody === undefined ? "" : new TextDecoder().decode(requestBody);

			if (requestBody !== undefined) {
				requestCount += 1;
				for (const secret of secrets) {
					if (bodyText.includes(secret.value)) {
						leakedRuleIds.add(secret.ruleId);
					}
					const marker = `[REDACTED:${secret.ruleId}]`;
					markerCounts[secret.ruleId] =
						(markerCounts[secret.ruleId] ?? 0) +
						countOccurrences(bodyText, marker);
				}
				const failFirstN = options.failFirstN;
				if (failFirstN && requestCount <= failFirstN.n) {
					return new Response("Simulated upstream failure (boundary relay)", {
						status: failFirstN.status,
					});
				}
			}

			await ensureTargetAlive();
			const targetUrl = new URL(
				`${incomingUrl.pathname}${incomingUrl.search}`,
				getTargetBaseUrl(),
			);
			const headers = new Headers(request.headers);
			headers.delete("host");
			headers.delete("content-length");
			return fetch(targetUrl, {
				method: request.method,
				headers,
				body: requestBody,
				redirect: "manual",
			});
		},
	});

	const baseUrl = `http://127.0.0.1:${relayServer.port}`;
	const relay: BoundaryRelay = {
		baseUrl,
		rpcUrl: `${baseUrl}/rpc`,
		getObservation: () => ({
			leakedRuleIds: Array.from(leakedRuleIds).sort(),
			markerCounts: { ...markerCounts },
			requestCount,
		}),
		async stop() {
			await relayServer.stop(true);
		},
	};
	activeBoundaryRelays.push(relay);
	return relay;
}

export async function stopAllBoundaryRelays(): Promise<void> {
	const relays = activeBoundaryRelays.splice(0, activeBoundaryRelays.length);
	await Promise.all(relays.map((relay) => relay.stop()));
}

export function containsAnyCanary(
	text: string,
	secrets: readonly FixtureSecret[],
): boolean {
	return secrets.some((secret) => text.includes(secret.value));
}

export function hashText(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

export function parseJsonl(content: string): readonly unknown[] {
	return content
		.trimEnd()
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => {
			const value: unknown = JSON.parse(line);
			return value;
		});
}

export function hasRealisticClaudeShape(entries: readonly unknown[]): boolean {
	const hasSummary = entries.some(
		(entry) => isRecord(entry) && entry.type === "summary",
	);
	const hasUserContentArray = entries.some((entry) => {
		if (!isRecord(entry) || entry.type !== "user") {
			return false;
		}
		const message = entry.message;
		return (
			isRecord(message) &&
			message.role === "user" &&
			Array.isArray(message.content)
		);
	});
	const hasNestedToolUse = entries.some((entry) => {
		if (!isRecord(entry) || entry.type !== "assistant") {
			return false;
		}
		const message = entry.message;
		if (!isRecord(message) || !Array.isArray(message.content)) {
			return false;
		}
		return message.content.some(
			(block) =>
				isRecord(block) && block.type === "tool_use" && isRecord(block.input),
		);
	});
	const hasNestedToolResultAndSubagent = entries.some((entry) => {
		if (!isRecord(entry) || entry.type !== "user") {
			return false;
		}
		const message = entry.message;
		const toolUseResult = entry.toolUseResult;
		return (
			isRecord(message) &&
			Array.isArray(message.content) &&
			message.content.some(
				(block) => isRecord(block) && block.type === "tool_result",
			) &&
			isRecord(toolUseResult) &&
			toolUseResult.agentId === "nested-agent-001"
		);
	});

	return (
		hasSummary &&
		hasUserContentArray &&
		hasNestedToolUse &&
		hasNestedToolResultAndSubagent
	);
}

export function hasRealisticClaudeSubagentShape(
	entries: readonly unknown[],
): boolean {
	const hasUser = entries.some(
		(entry) =>
			isRecord(entry) &&
			entry.isSidechain === true &&
			entry.agentId === "nested-agent-001" &&
			entry.type === "user" &&
			hasMessageContentArray(entry),
	);
	const hasAssistant = entries.some(
		(entry) =>
			isRecord(entry) &&
			entry.isSidechain === true &&
			entry.agentId === "nested-agent-001" &&
			entry.type === "assistant" &&
			hasMessageContentArray(entry),
	);
	return hasUser && hasAssistant;
}

export function hasRealisticCodexShape(entries: readonly unknown[]): boolean {
	const requiredEntryTypes = [
		"session_meta",
		"turn_context",
		"response_item",
		"event_msg",
	];
	const hasRequiredEntryTypes = requiredEntryTypes.every((type) =>
		entries.some((entry) => isRecord(entry) && entry.type === type),
	);
	const hasMessageContent = entries.some((entry) => {
		if (!isRecord(entry) || entry.type !== "response_item") {
			return false;
		}
		const payload = entry.payload;
		return (
			isRecord(payload) &&
			payload.type === "message" &&
			Array.isArray(payload.content)
		);
	});
	const hasFunctionCall = entries.some(
		(entry) =>
			isRecord(entry) &&
			entry.type === "response_item" &&
			isRecord(entry.payload) &&
			entry.payload.type === "function_call" &&
			typeof entry.payload.arguments === "string",
	);
	const hasFunctionCallOutput = entries.some(
		(entry) =>
			isRecord(entry) &&
			entry.type === "response_item" &&
			isRecord(entry.payload) &&
			entry.payload.type === "function_call_output" &&
			typeof entry.payload.output === "string",
	);

	return (
		hasRequiredEntryTypes &&
		hasMessageContent &&
		hasFunctionCall &&
		hasFunctionCallOutput
	);
}

function countOccurrences(text: string, value: string): number {
	let count = 0;
	let cursor = 0;
	while (cursor < text.length) {
		const matchIndex = text.indexOf(value, cursor);
		if (matchIndex === -1) {
			break;
		}
		count += 1;
		cursor = matchIndex + value.length;
	}
	return count;
}

function hasMessageContentArray(entry: Record<string, unknown>): boolean {
	const message = entry.message;
	return isRecord(message) && Array.isArray(message.content);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
