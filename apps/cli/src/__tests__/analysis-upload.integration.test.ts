import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	appendCodexAssistantMessage,
	codexThreadId,
	writeCodexRollout,
} from "./helpers/codex-rollouts.js";
import { type CliResult, runCli } from "./helpers/ingest-stub.js";
import { startR2IngestStub } from "./helpers/r2-ingest-stub.js";

const TOKEN = "analysis-upload-test-token";
const homes: string[] = [];
const servers: Array<{ stop: () => Promise<void> }> = [];

afterAll(async () => {
	await Promise.all(servers.map((server) => server.stop()));
	await Promise.all(
		homes.map((home) => rm(home, { force: true, recursive: true })),
	);
});

interface ApiStubOptions {
	capability: boolean;
	echo: boolean;
	rejectAnalysis: boolean;
}

interface ApiStub {
	readonly baseUrl: string;
	readonly ingests: Array<Record<string, unknown>>;
	readonly paths: string[];
	readonly options: ApiStubOptions;
}

/** Minimal Opaline API: CLI auth status and legacy ingestSession. */
function startApiStub(overrides: Partial<ApiStubOptions> = {}): ApiStub {
	const ingests: Array<Record<string, unknown>> = [];
	const paths: string[] = [];
	const options: ApiStubOptions = {
		capability: true,
		echo: true,
		rejectAnalysis: false,
		...overrides,
	};
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const { pathname } = new URL(request.url);
			paths.push(pathname);
			const body = await request.text();
			const input = readRpcInput(body);
			if (pathname === "/rpc/cli/authStatus") {
				return Response.json({
					json: {
						email: "analyst@example.com",
						id: "user-1",
						name: "Analyst",
						...(options.capability
							? { capabilities: { analysisLinkedUploads: true } }
							: {}),
					},
				});
			}
			if (pathname === "/rpc/ingestSession") {
				ingests.push(input);
				if (options.rejectAnalysis && input.analysisId !== undefined) {
					return Response.json(
						{
							json: {
								code: "NOT_FOUND",
								defined: false,
								message: "Analysis not found",
								status: 404,
							},
						},
						{ status: 404 },
					);
				}
				return Response.json({
					json: {
						sessionId: input.sessionId,
						success: true,
						...(options.echo && typeof input.analysisId === "string"
							? { analysisId: input.analysisId }
							: {}),
					},
				});
			}
			if (pathname === "/rpc/ingest/status") {
				return Response.json({
					json: {
						attempts: 1,
						availableAt: new Date().toISOString(),
						error: null,
						jobId: input.jobId,
						leaseExpiresAt: null,
						protocol: "r2_multipart_v1",
						result: { sessionId: "done", success: true },
						status: "completed",
						updatedAt: new Date().toISOString(),
					},
				});
			}
			return new Response("not found", { status: 404 });
		},
	});
	servers.push({ stop: () => server.stop(true) });
	return {
		baseUrl: `http://127.0.0.1:${server.port}`,
		ingests,
		options,
		paths,
	};
}

interface Fixture {
	readonly home: string;
	readonly codexHome: string;
	readonly chatPath: string;
	readonly env: Record<string, string>;
}

async function createFixture(
	apiBaseUrl: string,
	options: { autoUploadOff: boolean } = { autoUploadOff: true },
): Promise<Fixture> {
	const home = await mkdtemp(join(tmpdir(), "opaline-analysis-upload-"));
	homes.push(home);
	const configDir = join(home, ".rudel");
	// A custom CODEX_HOME proves the analysis path honours it; the regular hook
	// path still reads ~/.codex, so the auto-upload fixture uses that.
	const codexHome = options.autoUploadOff
		? join(home, "codex-home")
		: join(home, ".codex");
	const chatPath = join(home, "Documents", "Codex", "chat");
	await mkdir(configDir, { recursive: true });
	await mkdir(chatPath, { recursive: true });
	await writeFile(
		join(configDir, "credentials.json"),
		JSON.stringify({ apiBaseUrl, authType: "api-key", token: TOKEN }),
	);
	if (options.autoUploadOff)
		await writeFile(
			join(configDir, "auto-upload.json"),
			JSON.stringify({ repositories: {}, version: 1 }),
		);
	return { chatPath, codexHome, env: { CODEX_HOME: codexHome }, home };
}

function cli(
	fixture: Fixture,
	args: readonly string[],
	stdin?: string,
): Promise<CliResult> {
	return runCli(
		args,
		{ home: fixture.home, projectPath: "", sessionId: "", transcriptPath: "" },
		{ env: fixture.env, stdin },
	);
}

function turnComplete(fixture: Fixture, threadId: string): Promise<CliResult> {
	return cli(fixture, [
		"hooks",
		"codex",
		"turn-complete",
		JSON.stringify({
			cwd: fixture.chatPath,
			"input-messages": ["question"],
			"last-assistant-message": "answer",
			"thread-id": threadId,
			type: "agent-turn-complete",
		}),
	]);
}

async function writeConversation(fixture: Fixture) {
	const base = Date.now() - 60 * 60 * 1_000;
	const root = codexThreadId(base);
	const child = codexThreadId(base + 10_000);
	const guardian = codexThreadId(base + 20_000);
	const stranger = codexThreadId(base + 30_000);
	const options = { cwd: fixture.chatPath };
	const rootPath = await writeCodexRollout(fixture.codexHome, {
		...options,
		threadId: root,
		userText: "Which repositories had the most failed sessions?",
	});
	const childPath = await writeCodexRollout(fixture.codexHome, {
		...options,
		spawnedBy: root,
		threadId: child,
		userText: "Run the Opaline queries for failed sessions.",
	});
	await writeCodexRollout(fixture.codexHome, {
		...options,
		guardianOf: root,
		threadId: guardian,
	});
	const strangerPath = await writeCodexRollout(fixture.codexHome, {
		...options,
		threadId: stranger,
	});
	return { child, childPath, root, rootPath, stranger, strangerPath };
}

async function readMarkers(fixture: Fixture): Promise<unknown> {
	return JSON.parse(
		await readFile(
			join(fixture.home, ".rudel", "analysis-markers.json"),
			"utf8",
		),
	);
}

describe("opaline import --analysis", () => {
	test("links the chat and its parent, then the turn hook uploads the final answer", async () => {
		const api = startApiStub();
		const fixture = await createFixture(api.baseUrl);
		const chat = await writeConversation(fixture);

		const imported = await cli(fixture, [
			"import",
			chat.child,
			"--analysis",
			"analysis-1",
		]);

		expect(imported.stderr).toBe("");
		expect(imported.exitCode).toBe(0);
		expect(imported.stdout.trim().split("\n")).toHaveLength(1);
		expect(imported.stdout).toStartWith(
			`Opaline: linked thread ${chat.child} and 1 related thread(s) to analysis analysis-1 (2 uploaded)`,
		);
		expect(
			api.paths.filter((path) => path === "/rpc/cli/authStatus"),
		).toHaveLength(1);
		expect(api.ingests.map((input) => input.sessionId).sort()).toEqual(
			[chat.child, chat.root].sort(),
		);
		for (const input of api.ingests) {
			expect(input.analysisId).toBe("analysis-1");
			expect(input.organizationId).toBeUndefined();
		}
		expect(await readMarkers(fixture)).toMatchObject({
			markers: [
				{
					analysisId: "analysis-1",
					memberIds: expect.arrayContaining([chat.child, chat.root]),
					sessionId: chat.child,
					source: "codex",
				},
			],
		});

		// The agent writes its final answer after the import call returns.
		await appendCodexAssistantMessage(
			chat.rootPath,
			"Final answer: repository opaline had 12 failed sessions.",
		);
		const hook = await turnComplete(fixture, chat.root);

		expect(hook.exitCode).toBe(0);
		expect(hook.stderr).toBe("");
		const afterTurn = api.ingests.slice(2);
		expect(afterTurn.map((input) => input.sessionId)).toEqual([chat.root]);
		expect(afterTurn[0]?.analysisId).toBe("analysis-1");
		expect(String(afterTurn[0]?.content)).toContain(
			"Final answer: repository opaline had 12 failed sessions.",
		);
	});

	test("unmarked desktop chats stay skipped and expired markers stop uploads", async () => {
		const api = startApiStub();
		const fixture = await createFixture(api.baseUrl);
		const chat = await writeConversation(fixture);
		expect(
			(await cli(fixture, ["import", chat.root, "--analysis", "analysis-2"]))
				.exitCode,
		).toBe(0);
		const ingestsAfterImport = api.ingests.length;

		const unmarked = await turnComplete(fixture, chat.stranger);
		expect(unmarked.exitCode).toBe(0);
		expect(api.ingests).toHaveLength(ingestsAfterImport);

		const markersPath = join(fixture.home, ".rudel", "analysis-markers.json");
		const markers = JSON.parse(await readFile(markersPath, "utf8"));
		markers.markers[0].expiresAt = new Date(Date.now() - 1_000).toISOString();
		await writeFile(markersPath, JSON.stringify(markers));
		await appendCodexAssistantMessage(chat.rootPath, "A later answer.");

		const expired = await turnComplete(fixture, chat.root);
		expect(expired.exitCode).toBe(0);
		expect(api.ingests).toHaveLength(ingestsAfterImport);
	});

	test("a server without analysis uploads gets nothing and the command fails", async () => {
		const api = startApiStub({ capability: false });
		const fixture = await createFixture(api.baseUrl);
		const chat = await writeConversation(fixture);

		const result = await cli(fixture, [
			"import",
			chat.child,
			"--analysis",
			"analysis-3",
		]);

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain(
			"This Opaline server does not support analysis uploads yet",
		);
		expect(api.ingests).toEqual([]);
		expect(await readMarkers(fixture)).toEqual({ markers: [], version: 1 });
	});

	test("an upload the server stores without echoing the link fails and drops the marker", async () => {
		const api = startApiStub({ echo: false });
		const fixture = await createFixture(api.baseUrl);
		const chat = await writeConversation(fixture);

		const result = await cli(fixture, [
			"import",
			chat.child,
			"--analysis",
			"analysis-4",
		]);

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("stored without its analysis link");
		expect(api.ingests).toHaveLength(1);
		expect(await readMarkers(fixture)).toEqual({ markers: [], version: 1 });
	});

	test("an unknown analysis surfaces the server's refusal", async () => {
		const api = startApiStub({ rejectAnalysis: true });
		const fixture = await createFixture(api.baseUrl);
		const chat = await writeConversation(fixture);

		const result = await cli(fixture, [
			"import",
			chat.child,
			"--analysis",
			"missing-analysis",
		]);

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("404 Analysis not found");
		expect(await readMarkers(fixture)).toEqual({ markers: [], version: 1 });
	});

	test("--json prints one object and --no-related uploads only the thread", async () => {
		const api = startApiStub();
		const fixture = await createFixture(api.baseUrl);
		const chat = await writeConversation(fixture);

		const result = await cli(fixture, [
			"import",
			chat.child,
			"--analysis",
			"analysis-5",
			"--no-related",
			"--json",
		]);

		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.stdout)).toMatchObject({
			analysisId: "analysis-5",
			sessions: [
				{ relation: "marked", sessionId: chat.child, status: "uploaded" },
			],
		});
		expect(api.ingests.map((input) => input.sessionId)).toEqual([chat.child]);
	});

	test("a plain import never sends analysisId", async () => {
		const api = startApiStub();
		const fixture = await createFixture(api.baseUrl);
		const chat = await writeConversation(fixture);

		const result = await cli(fixture, ["import", chat.rootPath]);

		expect(result.exitCode).toBe(0);
		expect(api.ingests).toHaveLength(1);
		expect(Object.hasOwn(api.ingests[0] ?? {}, "analysisId")).toBe(false);
		expect(api.paths).not.toContain("/rpc/cli/authStatus");
	});

	test("--retry confirms finished server jobs and keeps the analysis link", async () => {
		const api = startApiStub();
		const fixture = await createFixture(api.baseUrl);
		const chat = await writeConversation(fixture);
		await writeFile(
			join(fixture.home, ".rudel", "failed-uploads.json"),
			JSON.stringify({
				failures: [
					{
						error: "Still processing on the server",
						failedAt: new Date().toISOString(),
						jobId: "00000000-0000-4000-8000-0000000000aa",
						projectPath: fixture.chatPath,
						sessionId: chat.child,
						source: "codex",
						status: "pending",
						transcriptPath: chat.childPath,
					},
					{
						analysisId: "analysis-7",
						error: "Temporary Opaline server/proxy error",
						failedAt: new Date().toISOString(),
						organizationId: "org-from-before",
						projectPath: fixture.chatPath,
						sessionId: chat.root,
						source: "codex",
						status: "retryable",
						transcriptPath: chat.rootPath,
					},
				],
			}),
		);

		const result = await cli(fixture, ["import", "--retry", "--yes"]);

		expect(result.exitCode).toBe(0);
		expect(api.paths).toContain("/rpc/ingest/status");
		expect(api.ingests).toHaveLength(1);
		expect(api.ingests[0]).toMatchObject({
			analysisId: "analysis-7",
			sessionId: chat.root,
		});
		expect(api.ingests[0]?.organizationId).toBeUndefined();
		expect(await readFailedUploads(fixture)).toEqual([]);
	});

	test("a marked Claude Code session uploads at session end with its analysis", async () => {
		const api = startApiStub();
		const fixture = await createFixture(api.baseUrl);
		const sessionId = "5b0c9a52-2d0e-4b8f-9a51-6f2f3c1d7e10";
		const projectDir = join(fixture.home, ".claude", "projects", "-tmp-chat");
		await mkdir(projectDir, { recursive: true });
		const transcriptPath = join(projectDir, `${sessionId}.jsonl`);
		await writeFile(
			transcriptPath,
			`${JSON.stringify({
				message: { content: "How many sessions failed?", role: "user" },
				sessionId,
				timestamp: "2026-10-04T10:00:00.000Z",
				type: "user",
			})}\n`,
		);

		const imported = await cli(fixture, [
			"import",
			sessionId,
			"--analysis",
			"analysis-6",
		]);
		expect(imported.exitCode).toBe(0);
		await writeFile(
			transcriptPath,
			`${JSON.stringify({
				message: {
					content: [{ text: "Final answer: 3 failed.", type: "text" }],
					role: "assistant",
				},
				sessionId,
				timestamp: "2026-10-04T10:01:00.000Z",
				type: "assistant",
			})}\n`,
			{ flag: "a" },
		);
		const hook = await cli(
			fixture,
			["hooks", "claude", "session-end"],
			JSON.stringify({
				cwd: fixture.chatPath,
				hook_event_name: "SessionEnd",
				session_id: sessionId,
				transcript_path: transcriptPath,
			}),
		);

		expect(hook.exitCode).toBe(0);
		expect(hook.stderr).toBe("");
		expect(api.ingests).toHaveLength(2);
		expect(api.ingests[1]).toMatchObject({
			analysisId: "analysis-6",
			sessionId,
			source: "claude_code",
		});
		expect(String(api.ingests[1]?.content)).toContain(
			"Final answer: 3 failed.",
		);
	});
});

describe("hook uploads the server is still processing", () => {
	test("a queued commit is recorded as pending and cleared by the next hook once completed", async () => {
		const r2 = startR2IngestStub();
		servers.push(r2);
		const fixture = await createFixture(r2.baseUrl, { autoUploadOff: false });
		await rememberCapability(fixture, `${r2.baseUrl}/rpc`);
		const firstId = codexThreadId(Date.now() - 60_000);
		const secondId = codexThreadId(Date.now() - 30_000);
		for (const threadId of [firstId, secondId])
			await writeCodexRollout(fixture.codexHome, {
				cwd: fixture.chatPath,
				threadId,
			});
		const firstJob = "00000000-0000-4000-8000-00000000000a";
		let firstJobDone = false;
		r2.nextJobId = firstJob;
		r2.commit = (jobId) =>
			jobId === firstJob
				? {
						kind: "unavailable",
						queued: true,
						reason: "R2_INGEST_JOB_RETRY_LATER",
					}
				: { kind: "completed" };
		r2.status = (jobId) =>
			jobId === firstJob && !firstJobDone
				? { errorCode: "R2_INGEST_COMMIT_QUEUED", kind: "pending" }
				: { kind: "completed" };

		const started = performance.now();
		const queued = await cli(fixture, [
			"hooks",
			"codex",
			"turn-complete",
			hookPayload(fixture, firstId),
		]);
		const elapsedMs = performance.now() - started;

		expect(queued.exitCode).toBe(0);
		expect(queued.stderr).toBe("");
		expect(elapsedMs).toBeLessThan(30_000);
		expect(
			r2.calls.filter((call) => call.pathname === "/rpc/ingest/commit"),
		).toHaveLength(1);
		expect(await readFailedUploads(fixture)).toMatchObject([
			{ jobId: firstJob, sessionId: firstId, status: "pending" },
		]);

		firstJobDone = true;
		r2.nextJobId = "00000000-0000-4000-8000-00000000000b";
		const next = await cli(fixture, [
			"hooks",
			"codex",
			"turn-complete",
			hookPayload(fixture, secondId),
		]);

		expect(next.exitCode).toBe(0);
		expect(next.stderr).toBe("");
		expect(await readFailedUploads(fixture)).toEqual([]);
	}, 60_000);
});

function hookPayload(fixture: Fixture, threadId: string): string {
	return JSON.stringify({
		cwd: fixture.chatPath,
		"input-messages": ["question"],
		"last-assistant-message": "answer",
		"thread-id": threadId,
		type: "agent-turn-complete",
	});
}

async function rememberCapability(fixture: Fixture, rpcUrl: string) {
	const key = createHash("sha256")
		.update(`${new URL(rpcUrl).href}\u0000api-key\u0000${TOKEN}`, "utf8")
		.digest("hex");
	const directory = join(fixture.home, ".rudel", "upload-capabilities");
	await mkdir(directory, { recursive: true });
	await writeFile(join(directory, `${key}.txt`), "r2_multipart_v1\n");
}

async function readFailedUploads(fixture: Fixture): Promise<unknown[]> {
	const parsed = JSON.parse(
		await readFile(join(fixture.home, ".rudel", "failed-uploads.json"), "utf8"),
	);
	return parsed.failures;
}

function readRpcInput(body: string): Record<string, unknown> {
	if (!body) return {};
	const parsed: unknown = JSON.parse(body);
	return typeof parsed === "object" &&
		parsed !== null &&
		"json" in parsed &&
		typeof parsed.json === "object" &&
		parsed.json !== null
		? { ...parsed.json }
		: {};
}
