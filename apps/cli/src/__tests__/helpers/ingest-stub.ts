import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

/**
 * Loopback ingest stub and CLI fixture helpers, extracted from
 * upload-destination.integration.test.ts. The stub simulates degraded or
 * hostile upload destinations; anything asserting real ingest behaviour
 * belongs in the private API repository instead.
 */

const MONOREPO_ROOT = resolve(import.meta.dir, "..", "..", "..", "..", "..");
const SOURCE_CLI_PATH = resolve(import.meta.dir, "..", "..", "bin", "cli.ts");

export const INGEST_STUB_TEST_TOKEN = "endpoint-security-test-token";

/**
 * Answers `cli.authStatus` for a server that accepts slimmed transcripts, or
 * undefined for any other path (to compose inside `respond`).
 */
export function respondAsSlimmingServer(
	info: Pick<IngestStubRespondInfo, "pathname">,
): Response | undefined {
	return info.pathname === "/rpc/cli/authStatus"
		? Response.json({
				json: {
					id: "user-1",
					email: "user@example.invalid",
					name: "User",
					capabilities: { transcriptSlimming: true },
				},
			})
		: undefined;
}

export interface IngestStubRequest {
	readonly apiKey: string | null;
	readonly pathname: string;
}

export interface IngestStubRespondInfo {
	/** Zero-based index of this request in arrival order. */
	readonly requestIndex: number;
	readonly pathname: string;
	readonly body: string;
	/** Raw request body, for binary uploads such as evidence object parts. */
	readonly rawBody: Uint8Array;
	readonly bodyBytes: number;
	readonly headers: Headers;
	readonly hostname: string;
	readonly method: string;
}

export interface IngestStubOptions {
	/** Defaults to the legacy all-interfaces binding used by existing tests. */
	readonly hostname?: string;
	/** Defaults to true for suites that assert the exact request payload. */
	readonly captureBodies?: boolean;
	/**
	 * Fail the first n requests with the given status before serving the
	 * default success envelope.
	 */
	readonly failFirstN?: { readonly n: number; readonly status: number };
	/** Full custom response control. Takes precedence over failFirstN. */
	readonly respond?: (
		info: IngestStubRespondInfo,
	) => Promise<Response> | Response;
}

export interface IngestStub {
	/**
	 * One `{apiKey, pathname}` entry per request. This exact shape is pinned by
	 * `toEqual` assertions in existing suites — request bodies are captured
	 * separately in `bodies`, never added here.
	 */
	readonly requests: IngestStubRequest[];
	/** Raw request bodies in arrival order, parallel to `requests`. */
	readonly bodies: string[];
	readonly server: ReturnType<typeof Bun.serve>;
	readonly nonLoopbackBase: string;
	readonly loopbackBase: string;
}

export function startIngestStub(options: IngestStubOptions = {}): IngestStub {
	const requests: IngestStubRequest[] = [];
	const bodies: string[] = [];
	const server = Bun.serve({
		hostname: options.hostname ?? "0.0.0.0",
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			const rawBody = new Uint8Array(await request.arrayBuffer());
			const body = new TextDecoder().decode(rawBody);
			const requestIndex = requests.length;
			requests.push({
				apiKey: request.headers.get("x-api-key"),
				pathname: url.pathname,
			});
			if (options.captureBodies !== false) {
				bodies.push(body);
			}

			if (options.respond) {
				return options.respond({
					requestIndex,
					pathname: url.pathname,
					body,
					rawBody,
					bodyBytes: Buffer.byteLength(body),
					headers: request.headers,
					hostname: url.hostname,
					method: request.method,
				});
			}
			if (options.failFirstN && requestIndex < options.failFirstN.n) {
				return new Response("upstream failure", {
					status: options.failFirstN.status,
				});
			}
			if (url.pathname === "/rpc/cli/sessionUploadStatus") {
				return Response.json({
					json: {
						organizationId: "stub-organization",
						uploadedSessionIds: [],
					},
				});
			}
			return Response.json({
				json: {
					success: true,
					sessionId: "stub-session",
				},
			});
		},
	});

	return {
		requests,
		bodies,
		server,
		nonLoopbackBase: `http://0.0.0.0:${server.port}`,
		loopbackBase: `http://127.0.0.1:${server.port}`,
	};
}

export interface HookCase {
	readonly name: string;
	readonly source: "claude_code" | "codex";
	buildInvocation(options: {
		sessionId: string;
		transcriptPath: string;
		projectPath: string;
	}): {
		readonly command: readonly string[];
		readonly stdin?: string;
	};
}

export const HOOK_CASES: readonly HookCase[] = [
	{
		name: "Claude Code SessionEnd",
		source: "claude_code",
		buildInvocation: ({ sessionId, transcriptPath, projectPath }) => ({
			command: ["hooks", "claude", "session-end"],
			stdin: JSON.stringify({
				session_id: sessionId,
				transcript_path: transcriptPath,
				cwd: projectPath,
				hook_event_name: "SessionEnd",
				reason: "other",
			}),
		}),
	},
	{
		name: "Codex turn-complete",
		source: "codex",
		buildInvocation: ({ sessionId, projectPath }) => ({
			command: [
				"hooks",
				"codex",
				"turn-complete",
				JSON.stringify({
					type: "agent-turn-complete",
					"thread-id": sessionId,
					"turn-id": "test-turn",
					cwd: projectPath,
					"input-messages": ["test"],
					"last-assistant-message": "done",
				}),
			],
		}),
	},
];

export interface CliFixture {
	readonly home: string;
	readonly projectPath: string;
	readonly sessionId: string;
	readonly transcriptPath: string;
}

export interface CliResult {
	readonly exitCode: number;
	readonly stderr: string;
	readonly stdout: string;
}

/**
 * Codex rollout transcripts live under dated subdirectories of
 * ~/.codex/sessions, where findActiveRolloutFile discovers them by session ID.
 */
export function codexRolloutPath(home: string, sessionId: string): string {
	return join(
		home,
		".codex",
		"sessions",
		"2026",
		"08",
		"12",
		`${sessionId}.jsonl`,
	);
}

export async function createCliFixture(
	source: HookCase["source"],
): Promise<CliFixture> {
	const home = await mkdtemp(join(tmpdir(), "rudel-endpoint-security-"));
	const configDir = join(home, ".rudel");
	const projectPath = join(home, "project");
	const sessionId = `${source}-endpoint-security-session`;
	const transcriptPath =
		source === "codex"
			? codexRolloutPath(home, sessionId)
			: join(projectPath, `${sessionId}.jsonl`);
	await Promise.all([
		mkdir(configDir, { recursive: true }),
		mkdir(projectPath, { recursive: true }),
		mkdir(dirname(transcriptPath), { recursive: true }),
	]);
	await Promise.all([
		writeFile(
			join(configDir, "credentials.json"),
			JSON.stringify({
				token: INGEST_STUB_TEST_TOKEN,
				apiBaseUrl: "https://stored.example",
				authType: "api-key",
			}),
		),
		writeFile(
			transcriptPath,
			[
				JSON.stringify({
					type: source === "codex" ? "session_meta" : "summary",
					sessionId,
					payload: { id: sessionId, cwd: projectPath },
				}),
				JSON.stringify(
					source === "codex"
						? {
								timestamp: "2026-07-29T10:00:01.000Z",
								type: "response_item",
								payload: {
									content: [
										{
											text: "endpoint security integration test",
											type: "input_text",
										},
									],
									role: "user",
									type: "message",
								},
							}
						: {
								content: "endpoint security integration test",
								role: "human",
								timestamp: "2026-07-29T10:00:01.000Z",
								type: "user",
							},
				),
			].join("\n"),
		),
	]);

	return { home, projectPath, sessionId, transcriptPath };
}

export async function runCli(
	args: readonly string[],
	fixture: CliFixture,
	options: {
		readonly stdin?: string;
		readonly env?: Readonly<Record<string, string>>;
		readonly preload?: string;
	} = {},
): Promise<CliResult> {
	const command = ["bun"];
	if (options.preload) command.push("--preload", options.preload);
	command.push(SOURCE_CLI_PATH, ...args);
	const proc = Bun.spawn(command, {
		cwd: MONOREPO_ROOT,
		env: {
			...process.env,
			HOME: fixture.home,
			OPALINE_CONFIG_DIR: join(fixture.home, ".rudel"),
			USERPROFILE: fixture.home,
			RUDEL_CONFIG_DIR: join(fixture.home, ".rudel"),
			POSTHOG_ENABLED: "false",
			...options.env,
		},
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	proc.stdin.write(options.stdin ?? "");
	proc.stdin.end();

	const [exitCode, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	return { exitCode, stdout, stderr };
}
