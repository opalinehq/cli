import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	type FileHandle,
	mkdtemp,
	open,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IngestSessionInput } from "../contracts/index.js";
import type { FileBackedUploadRequest } from "../internal/agent-adapters/index.js";
import {
	R2_INGEST_PART_SIZE_BYTES,
	type R2IngestUploadPart,
} from "../lib/r2-ingest-contract.js";
import { buildFilePartRanges } from "../lib/r2-multipart-upload.js";
import {
	hasAdvertisedR2UploadCapability,
	rememberR2UploadCapability,
} from "../lib/r2-upload-capability.js";
import type { UploadTransferProgress } from "../lib/types.js";
import { type UploadConfig, uploadSession } from "../lib/uploader.js";

const TOKEN = "r2-flow-test-token";
const JOB_ID = "00000000-0000-4000-8000-000000000001";
const activeServers: Array<FetchStub> = [];
const temporaryDirectories: string[] = [];
const originalConfigDirectory = process.env.OPALINE_CONFIG_DIR;
const LARGE_TRANSCRIPT_MIN_BYTES = 101 * 1024 * 1024;
const LEGACY_CAP_TEST_MIN_BYTES = 33 * 1024 * 1024;
const MAX_HEAP_DELTA_BYTES = 64 * 1024 * 1024;
const MAX_RSS_DELTA_BYTES = 160 * 1024 * 1024;
const MAX_PROCESS_RSS_BYTES = 256 * 1024 * 1024;
const MAX_FAILED_INIT_RSS_DELTA_BYTES = 96 * 1024 * 1024;
const MAX_FAILED_INIT_PROCESS_RSS_BYTES = 192 * 1024 * 1024;

interface MemoryProbe {
	readonly attempts: number;
	readonly awsRedactions: number;
	readonly error: string | null;
	readonly heapDelta: number;
	readonly initByteLength: number;
	readonly initSha256: string;
	readonly requestPaths: readonly string[];
	readonly retryable: boolean | null;
	readonly rssDelta: number;
	readonly success: boolean;
	readonly uploadedBytes: number;
	readonly uploadedHash: string;
	readonly uploadedPartCount: number;
	readonly uploadedPrefix: string;
}

afterEach(async () => {
	await Promise.all(activeServers.splice(0).map((server) => server.stop(true)));
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { force: true, recursive: true })),
	);
	if (originalConfigDirectory === undefined) {
		delete process.env.OPALINE_CONFIG_DIR;
	} else {
		process.env.OPALINE_CONFIG_DIR = originalConfigDirectory;
	}
});

describe("capability-gated R2 upload flow", () => {
	test("filters before init and direct upload, then commits and checks status", async () => {
		await isolateCapabilityCache();
		const requests: string[] = [];
		const rpcInputs = new Map<string, Record<string, unknown>>();
		let uploadedBody = "";
		let uploadedContentLength = "";
		let statusCalls = 0;
		let server: FetchStub;
		server = serveFetchStub({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				const pathname = new URL(request.url).pathname;
				requests.push(pathname);
				if (pathname === "/r2/part/1") {
					uploadedContentLength = request.headers.get("content-length") ?? "";
					uploadedBody = await request.text();
					return new Response(null, { headers: { etag: '"etag-1"' } });
				}

				const input = await readRpcInput(request);
				rpcInputs.set(pathname, input);
				if (pathname === "/rpc/ingestSession") {
					return rpcResponse({
						success: true,
						sessionId: getRequiredString(input, "sessionId"),
						upgradeHint: { protocol: "r2_multipart_v1" },
					});
				}
				if (pathname === "/rpc/ingest/init") {
					const main = getMainObject(input);
					const byteLength = getRequiredNumber(main, "byteLength");
					return rpcResponse({
						expiresAt: "2026-08-25T12:15:00.000Z",
						jobId: JOB_ID,
						objects: [
							{
								byteLength,
								kind: "main",
								objectKey: `ingest/${JOB_ID}/main.jsonl`,
								parts: [
									{
										byteLength,
										headers: {
											"Content-Length": byteLength.toString(),
										},
										partNumber: 1,
										uploadUrl: `http://127.0.0.1:${server.port}/r2/part/1`,
									},
								],
								sha256: getRequiredString(main, "sha256"),
								uploadId: "upload-1",
							},
						],
						partSizeBytes: 8 * 1024 * 1024,
						protocol: "r2_multipart_v1",
					});
				}
				if (pathname === "/rpc/ingest/commit") {
					return rpcResponse({
						jobId: JOB_ID,
						protocol: "r2_multipart_v1",
						result: createSuccessResult("r2-secret-session"),
						status: "completed",
					});
				}
				if (pathname === "/rpc/ingest/status") {
					statusCalls += 1;
					return rpcResponse({
						attempts: 1,
						availableAt: "2026-08-25T12:00:00.000Z",
						error: null,
						jobId: JOB_ID,
						leaseExpiresAt: null,
						protocol: "r2_multipart_v1",
						result:
							statusCalls === 1
								? null
								: createSuccessResult("r2-secret-session"),
						status: statusCalls === 1 ? "pending" : "completed",
						updatedAt: "2026-08-25T12:00:01.000Z",
					});
				}
				return new Response("not found", { status: 404 });
			},
		});
		activeServers.push(server);
		const config = createUploadConfig(server);

		const warmup = await uploadSession(
			createRequest("r2-warmup", "clean"),
			config,
		);
		expect(warmup.success).toBe(true);

		const canary = `AKIA${"A".repeat(16)}`;
		const progress: UploadTransferProgress[] = [];
		config.onTransferProgress = (update) => progress.push(update);
		const dirtyContent = JSON.stringify({
			content: `Use ${canary}`,
			padding: "x".repeat(200),
			timestamp: "2026-08-25T12:00:00.000Z",
			type: "user",
		});
		const result = await uploadSession(
			createRequest("r2-secret-session", dirtyContent),
			config,
		);

		expect(result).toMatchObject({
			success: true,
			redacted: { "aws-access-key-id": 1 },
			redactedBytes: Buffer.byteLength(canary),
		});
		expect(requests).toEqual([
			"/rpc/ingestSession",
			"/rpc/ingest/init",
			"/r2/part/1",
			"/rpc/ingest/commit",
			"/rpc/ingest/status",
			"/rpc/ingest/status",
		]);
		expect(uploadedBody).not.toContain(canary);
		expect(uploadedBody).toContain("[REDACTED:aws-access-key-id]");
		expect(uploadedContentLength).toBe(
			Buffer.byteLength(uploadedBody).toString(),
		);
		expect(progress[0]).toEqual({
			phase: "uploading",
			uploadedBytes: 0,
			totalBytes: Buffer.byteLength(uploadedBody),
		});
		expect(progress.at(-1)).toEqual({
			phase: "processing",
			uploadedBytes: Buffer.byteLength(uploadedBody),
			totalBytes: Buffer.byteLength(uploadedBody),
		});
		for (const update of progress) {
			expect(update.totalBytes).toBe(Buffer.byteLength(uploadedBody));
			expect(update.uploadedBytes).toBeLessThanOrEqual(update.totalBytes);
		}

		const initInput = getRequiredMapValue(rpcInputs, "/rpc/ingest/init");
		const main = getMainObject(initInput);
		expect(getRequiredNumber(main, "byteLength")).toBe(
			Buffer.byteLength(uploadedBody),
		);
		expect(getRequiredString(main, "sha256")).toBe(
			createHash("sha256").update(uploadedBody).digest("hex"),
		);
		expect(initInput.content).toBeUndefined();
		expect(initInput.subagents).toBeUndefined();

		const commitInput = getRequiredMapValue(rpcInputs, "/rpc/ingest/commit");
		expect(commitInput).toEqual({
			jobId: JOB_ID,
			objects: [
				{
					objectKey: `ingest/${JOB_ID}/main.jsonl`,
					parts: [{ etag: '"etag-1"', partNumber: 1 }],
					uploadId: "upload-1",
				},
			],
		});
	});

	test("polls terminal status when commit retries end with a busy job", async () => {
		await isolateCapabilityCache();
		const requestPaths: string[] = [];
		let commitCalls = 0;
		let statusCalls = 0;
		let server: FetchStub;
		server = serveFetchStub({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				const pathname = new URL(request.url).pathname;
				requestPaths.push(pathname);
				if (pathname === "/r2/busy/part/1") {
					await request.arrayBuffer();
					return new Response(null, { headers: { etag: '"busy-etag"' } });
				}

				const input = await readRpcInput(request);
				if (pathname === "/rpc/ingest/init") {
					const main = getMainObject(input);
					const byteLength = getRequiredNumber(main, "byteLength");
					return rpcResponse({
						expiresAt: "2026-08-25T12:15:00.000Z",
						jobId: JOB_ID,
						objects: [
							{
								byteLength,
								kind: "main",
								objectKey: `ingest/${JOB_ID}/main.jsonl`,
								parts: [
									{
										byteLength,
										headers: {
											"Content-Length": byteLength.toString(),
										},
										partNumber: 1,
										uploadUrl: `http://127.0.0.1:${server.port}/r2/busy/part/1`,
									},
								],
								sha256: getRequiredString(main, "sha256"),
								uploadId: "busy-upload",
							},
						],
						partSizeBytes: R2_INGEST_PART_SIZE_BYTES,
						protocol: "r2_multipart_v1",
					});
				}
				if (pathname === "/rpc/ingest/commit") {
					const failures = [
						{
							message: "Language-signal scanning temporarily failed",
							reason: "language_signal_scanner_failed",
						},
						{
							message: "Ingest job is waiting for its retry window",
							reason: "R2_INGEST_JOB_RETRY_LATER",
						},
						{
							message: "Ingest job is already being processed",
							reason: "R2_INGEST_JOB_BUSY",
						},
					];
					const failure = failures[commitCalls];
					commitCalls += 1;
					if (!failure) throw new Error("unexpected commit retry");
					return Response.json(
						{
							json: {
								code: "SERVICE_UNAVAILABLE",
								data: { reason: failure.reason, retryAfterMs: 1_000 },
								defined: false,
								message: failure.message,
								status: 503,
							},
						},
						{ status: 503 },
					);
				}
				if (pathname === "/rpc/ingest/status") {
					statusCalls += 1;
					return rpcResponse({
						attempts: 2,
						availableAt: "2026-08-25T12:00:00.000Z",
						error: null,
						jobId: JOB_ID,
						leaseExpiresAt:
							statusCalls === 1 ? "2026-08-25T12:30:00.000Z" : null,
						protocol: "r2_multipart_v1",
						result:
							statusCalls === 1
								? null
								: createSuccessResult("busy-recovery-session"),
						status: statusCalls === 1 ? "running" : "completed",
						updatedAt: "2026-08-25T12:00:01.000Z",
					});
				}
				return new Response("not found", { status: 404 });
			},
		});
		activeServers.push(server);
		const config = createUploadConfig(server);
		await rememberR2UploadCapability(
			new URL(config.endpoint),
			"api-key",
			TOKEN,
		);

		const result = await uploadSession(
			createRequest("busy-recovery-session", "clean"),
			config,
		);

		expect(result).toMatchObject({ attempts: 3, success: true });
		expect(requestPaths).toEqual([
			"/rpc/ingest/init",
			"/r2/busy/part/1",
			"/rpc/ingest/commit",
			"/rpc/ingest/commit",
			"/rpc/ingest/commit",
			"/rpc/ingest/status",
			"/rpc/ingest/status",
		]);
	});

	test("rejects an over-budget streamed transcript before R2 init or PUT while a normal transcript passes", async () => {
		await isolateCapabilityCache();
		const directory = await mkdtemp(join(tmpdir(), "opaline-r2-budget-"));
		temporaryDirectories.push(directory);
		const normalPath = join(directory, "normal.jsonl");
		const overBudgetPath = join(directory, "over-budget.jsonl");
		const normalContent = JSON.stringify({ message: "clean transcript" });
		const secret = `sk_live_${"a".repeat(13)}`;
		const overBudgetContent = JSON.stringify({ message: secret });
		await Promise.all([
			writeFile(normalPath, normalContent),
			writeFile(overBudgetPath, overBudgetContent),
		]);

		const requestPaths: string[] = [];
		let uploadedBody = "";
		let server: FetchStub;
		server = serveFetchStub({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				const pathname = new URL(request.url).pathname;
				requestPaths.push(pathname);
				if (pathname === "/r2/budget/part/1") {
					uploadedBody = await request.text();
					return new Response(null, { headers: { etag: '"budget-etag"' } });
				}

				const input = await readRpcInput(request);
				if (pathname === "/rpc/ingestSession") {
					return rpcResponse({
						sessionId: getRequiredString(input, "sessionId"),
						success: true,
						upgradeHint: { protocol: "r2_multipart_v1" },
					});
				}
				if (pathname === "/rpc/ingest/init") {
					const main = getMainObject(input);
					const byteLength = getRequiredNumber(main, "byteLength");
					return rpcResponse({
						expiresAt: "2026-08-25T12:15:00.000Z",
						jobId: JOB_ID,
						objects: [
							{
								byteLength,
								kind: "main",
								objectKey: `ingest/${JOB_ID}/main.jsonl`,
								parts: [
									{
										byteLength,
										headers: {
											"Content-Length": byteLength.toString(),
										},
										partNumber: 1,
										uploadUrl: `http://127.0.0.1:${server.port}/r2/budget/part/1`,
									},
								],
								sha256: getRequiredString(main, "sha256"),
								uploadId: "budget-upload",
							},
						],
						partSizeBytes: R2_INGEST_PART_SIZE_BYTES,
						protocol: "r2_multipart_v1",
					});
				}
				if (pathname === "/rpc/ingest/commit") {
					return rpcResponse({
						jobId: JOB_ID,
						protocol: "r2_multipart_v1",
						result: createSuccessResult("normal-streamed"),
						status: "completed",
					});
				}
				if (pathname === "/rpc/ingest/status") {
					return rpcResponse({
						attempts: 1,
						availableAt: "2026-08-25T12:00:00.000Z",
						error: null,
						jobId: JOB_ID,
						leaseExpiresAt: null,
						protocol: "r2_multipart_v1",
						result: createSuccessResult("normal-streamed"),
						status: "completed",
						updatedAt: "2026-08-25T12:00:01.000Z",
					});
				}
				return new Response("not found", { status: 404 });
			},
		});
		activeServers.push(server);
		const config = createUploadConfig(server);

		const advertised = await uploadSession(
			createRequest("budget-r2-warmup", "clean"),
			config,
		);
		expect(advertised.success).toBe(true);
		requestPaths.length = 0;

		const normal = await uploadSession(
			createFileRequest("normal-streamed", normalPath),
			config,
		);
		expect(normal.success).toBe(true);
		expect(uploadedBody).toBe(normalContent);
		expect(requestPaths).toEqual([
			"/rpc/ingest/init",
			"/r2/budget/part/1",
			"/rpc/ingest/commit",
			"/rpc/ingest/status",
		]);
		requestPaths.length = 0;

		const rejected = await uploadSession(
			createFileRequest("over-budget-streamed", overBudgetPath),
			config,
		);
		expect(rejected).toEqual({
			success: false,
			error:
				"Redaction safety check stopped upload: known-pattern redaction would replace 21 B of 35 B (60.0%), above the 20% transcript budget (stripe-access-token). The unfiltered transcript was not uploaded.",
			attempts: 0,
			redactionBudgetExceeded: true,
			retryable: false,
		});
		expect(requestPaths).toEqual([]);
	});

	test("probes R2 for a first 100+ MiB adapter upload without a capability cache", async () => {
		await isolateCapabilityCache();
		const directory = await mkdtemp(join(tmpdir(), "opaline-r2-e2e-large-"));
		temporaryDirectories.push(directory);
		const transcriptPath = join(directory, "large-codex-session.jsonl");
		const canary = `AKIA${"L".repeat(16)}`;
		const transcriptBytes = await writeCodexTranscriptAtLeast(
			transcriptPath,
			canary,
			LARGE_TRANSCRIPT_MIN_BYTES,
		);
		expect(transcriptBytes).toBeGreaterThan(LARGE_TRANSCRIPT_MIN_BYTES);

		const requestPaths: string[] = [];
		let initMain: Record<string, unknown> | undefined;
		let uploadedPartCount = 0;
		const uploadedHash = createHash("sha256");
		const uploadedPrefixChunks: Buffer[] = [];
		let uploadedPrefixBytes = 0;
		let server: FetchStub;
		server = serveFetchStub({
			hostname: "127.0.0.1",
			idleTimeout: 60,
			port: 0,
			async fetch(request) {
				const pathname = new URL(request.url).pathname;
				requestPaths.push(pathname);
				if (pathname.startsWith("/r2/large/part/")) {
					uploadedPartCount += 1;
					if (request.body) {
						for await (const chunk of request.body) {
							uploadedHash.update(chunk);
							if (uploadedPrefixBytes < 4 * 1024) {
								const remaining = 4 * 1024 - uploadedPrefixBytes;
								const prefix = Buffer.from(chunk.subarray(0, remaining));
								uploadedPrefixChunks.push(prefix);
								uploadedPrefixBytes += prefix.byteLength;
							}
						}
					}
					return new Response(null, {
						headers: { etag: `"large-${uploadedPartCount}"` },
					});
				}

				const input = await readRpcInput(request);
				if (pathname === "/rpc/ingestSession") {
					return rpcResponse({
						sessionId: getRequiredString(input, "sessionId"),
						success: true,
						upgradeHint: { protocol: "r2_multipart_v1" },
					});
				}
				if (pathname === "/rpc/ingest/init") {
					initMain = getMainObject(input);
					const byteLength = getRequiredNumber(initMain, "byteLength");
					const parts: R2IngestUploadPart[] = buildFilePartRanges(
						byteLength,
						R2_INGEST_PART_SIZE_BYTES,
					).map((range) => ({
						byteLength: range.byteLength,
						headers: { "Content-Length": range.byteLength.toString() },
						partNumber: range.partNumber,
						uploadUrl: `http://127.0.0.1:${server.port}/r2/large/part/${range.partNumber}`,
					}));
					return rpcResponse({
						expiresAt: "2026-08-25T12:15:00.000Z",
						jobId: JOB_ID,
						objects: [
							{
								byteLength,
								kind: "main",
								objectKey: `ingest/${JOB_ID}/main.jsonl`,
								parts,
								sha256: getRequiredString(initMain, "sha256"),
								uploadId: "large-upload",
							},
						],
						partSizeBytes: R2_INGEST_PART_SIZE_BYTES,
						protocol: "r2_multipart_v1",
					});
				}
				if (pathname === "/rpc/ingest/commit") {
					return rpcResponse({
						jobId: JOB_ID,
						protocol: "r2_multipart_v1",
						result: createSuccessResult("large-codex-session"),
						status: "completed",
					});
				}
				if (pathname === "/rpc/ingest/status") {
					return rpcResponse({
						attempts: 1,
						availableAt: "2026-08-25T12:00:00.000Z",
						error: null,
						jobId: JOB_ID,
						leaseExpiresAt: null,
						protocol: "r2_multipart_v1",
						result: createSuccessResult("large-codex-session"),
						status: "completed",
						updatedAt: "2026-08-25T12:00:01.000Z",
					});
				}
				return new Response("not found", { status: 404 });
			},
		});
		activeServers.push(server);
		const config = createUploadConfig(server);

		const probePath = join(
			import.meta.dir,
			"helpers",
			"r2-upload-memory-probe.ts",
		);
		const probe = Bun.spawn(
			[
				"bun",
				probePath,
				transcriptPath,
				config.endpoint,
				TOKEN,
				"large-codex-session",
			],
			{
				env: { ...process.env, OPALINE_R2_PROBE_MODE: "success" },
				stderr: "pipe",
				stdout: "pipe",
			},
		);
		const [exitCode, stdout, stderr] = await Promise.all([
			probe.exited,
			new Response(probe.stdout).text(),
			new Response(probe.stderr).text(),
		]);
		const resourceUsage = probe.resourceUsage();
		const memory = parseMemoryProbe(stdout);

		expect(exitCode).toBe(0);
		expect(stderr).toBe("");
		expect(memory.success).toBe(true);
		expect(memory.awsRedactions).toBe(1);
		expect(memory.heapDelta).toBeLessThan(MAX_HEAP_DELTA_BYTES);
		expect(memory.rssDelta).toBeLessThan(MAX_RSS_DELTA_BYTES);
		expect(resourceUsage.maxRSS).toBeLessThan(MAX_PROCESS_RSS_BYTES);
		expect(memory.uploadedPartCount).toBeGreaterThan(12);
		expect(memory.uploadedBytes).toBe(memory.initByteLength);
		expect(memory.uploadedHash).toBe(memory.initSha256);
		expect(memory.uploadedPrefix).not.toContain(canary);
		expect(memory.uploadedPrefix).toContain("[REDACTED:aws-access-key-id]");
		expect(memory.requestPaths[0]).toBe("/rpc/ingest/init");
		expect(memory.requestPaths).not.toContain("/rpc/ingestSession");
	}, 120_000);

	test("finds a timestamp after a 100+ MiB record with bounded heap and RSS", async () => {
		const directory = await mkdtemp(
			join(tmpdir(), "opaline-r2-e2e-oversized-record-"),
		);
		temporaryDirectories.push(directory);
		const transcriptPath = join(
			directory,
			"oversized-record-codex-session.jsonl",
		);
		const transcriptBytes = await writeCodexTranscriptWithOversizedFirstRecord(
			transcriptPath,
			LARGE_TRANSCRIPT_MIN_BYTES,
		);
		expect(transcriptBytes).toBeGreaterThan(LARGE_TRANSCRIPT_MIN_BYTES);

		const probePath = join(
			import.meta.dir,
			"helpers",
			"r2-upload-memory-probe.ts",
		);
		const probe = Bun.spawn(
			[
				"bun",
				probePath,
				transcriptPath,
				"https://opaline.so/rpc",
				TOKEN,
				"oversized-record-codex-session",
			],
			{
				env: { ...process.env, OPALINE_R2_PROBE_MODE: "adapter-scan" },
				stderr: "pipe",
				stdout: "pipe",
			},
		);
		const [exitCode, stdout, stderr] = await Promise.all([
			probe.exited,
			new Response(probe.stdout).text(),
			new Response(probe.stderr).text(),
		]);
		const resourceUsage = probe.resourceUsage();
		const memory = parseMemoryProbe(stdout);

		expect(exitCode).toBe(0);
		expect(stderr).toBe("");
		expect(memory.success).toBe(true);
		expect(memory.heapDelta).toBeLessThan(MAX_HEAP_DELTA_BYTES);
		expect(memory.rssDelta).toBeLessThan(MAX_RSS_DELTA_BYTES);
		expect(resourceUsage.maxRSS).toBeLessThan(MAX_PROCESS_RSS_BYTES);
		expect(memory.requestPaths).toEqual([]);
	}, 120_000);

	test("keeps a first 100+ MiB transient R2 init retryable without legacy fallback", async () => {
		await isolateCapabilityCache();
		const directory = await mkdtemp(
			join(tmpdir(), "opaline-r2-failed-init-large-"),
		);
		temporaryDirectories.push(directory);
		const transcriptPath = join(directory, "failed-init-codex-session.jsonl");
		const transcriptBytes = await writeCodexTranscriptAtLeast(
			transcriptPath,
			"clean",
			LARGE_TRANSCRIPT_MIN_BYTES,
		);
		expect(transcriptBytes).toBeGreaterThan(LARGE_TRANSCRIPT_MIN_BYTES);

		const requestPaths: string[] = [];
		const server = serveFetchStub({
			hostname: "127.0.0.1",
			idleTimeout: 60,
			port: 0,
			async fetch(request) {
				const pathname = new URL(request.url).pathname;
				requestPaths.push(pathname);
				if (pathname === "/rpc/ingest/init") {
					return Response.json(
						{
							json: {
								code: "SERVICE_UNAVAILABLE",
								defined: false,
								message: "R2 initialization temporarily unavailable",
								status: 503,
							},
						},
						{ status: 503 },
					);
				}
				const input = await readRpcInput(request);
				return rpcResponse({
					sessionId: getRequiredString(input, "sessionId"),
					success: true,
					upgradeHint: { protocol: "r2_multipart_v1" },
				});
			},
		});
		activeServers.push(server);
		const config = createUploadConfig(server);

		const probePath = join(
			import.meta.dir,
			"helpers",
			"r2-upload-memory-probe.ts",
		);
		const probe = Bun.spawn(
			[
				"bun",
				probePath,
				transcriptPath,
				config.endpoint,
				TOKEN,
				"failed-init-codex-session",
			],
			{
				env: { ...process.env, OPALINE_R2_PROBE_MODE: "failed-init" },
				stderr: "pipe",
				stdout: "pipe",
			},
		);
		const [exitCode, stdout, stderr] = await Promise.all([
			probe.exited,
			new Response(probe.stdout).text(),
			new Response(probe.stderr).text(),
		]);
		const resourceUsage = probe.resourceUsage();
		const memory = parseMemoryProbe(stdout);

		expect(exitCode).toBe(0);
		expect(stderr).toBe("");
		expect(memory).toMatchObject({
			attempts: 3,
			retryable: true,
			success: false,
		});
		expect(memory.error).toContain("Could not initialize direct R2 upload");
		expect(memory.heapDelta).toBeLessThan(MAX_HEAP_DELTA_BYTES);
		expect(memory.rssDelta).toBeLessThan(MAX_FAILED_INIT_RSS_DELTA_BYTES);
		expect(resourceUsage.maxRSS).toBeLessThan(
			MAX_FAILED_INIT_PROCESS_RSS_BYTES,
		);
		expect(memory.requestPaths).toEqual([
			"/rpc/ingest/init",
			"/rpc/ingest/init",
			"/rpc/ingest/init",
		]);
		expect(memory.requestPaths).not.toContain("/rpc/ingestSession");
		expect(
			hasAdvertisedR2UploadCapability(
				new URL(config.endpoint),
				"api-key",
				TOKEN,
			),
		).toBe(false);
	}, 120_000);

	test("rejects an empty main transcript locally before any R2 request", async () => {
		await isolateCapabilityCache();
		let requestCount = 0;
		const server = serveFetchStub({
			hostname: "127.0.0.1",
			port: 0,
			fetch() {
				requestCount += 1;
				return new Response("unexpected request", { status: 500 });
			},
		});
		activeServers.push(server);
		const config = createUploadConfig(server);
		await rememberR2UploadCapability(
			new URL(config.endpoint),
			"api-key",
			TOKEN,
		);

		const result = await uploadSession(createRequest("empty-main", ""), config);

		expect(result).toEqual({
			success: false,
			error: "The main session transcript is empty. Nothing was uploaded.",
			attempts: 0,
			retryable: false,
		});
		expect(requestCount).toBe(0);
	});

	test("probes R2 for a first oversized upload and falls back on an unsupported server", async () => {
		await isolateCapabilityCache();
		const directory = await mkdtemp(join(tmpdir(), "opaline-r2-legacy-cap-"));
		temporaryDirectories.push(directory);
		const transcriptPath = join(directory, "legacy-too-large.jsonl");
		await writeCodexTranscriptAtLeast(
			transcriptPath,
			"clean",
			LEGACY_CAP_TEST_MIN_BYTES,
		);
		const requestPaths: string[] = [];
		const server = serveFetchStub({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request) {
				requestPaths.push(new URL(request.url).pathname);
				return Response.json(
					{
						json: {
							code: "NOT_FOUND",
							defined: false,
							message: "Not Found",
							status: 404,
						},
					},
					{ status: 404 },
				);
			},
		});
		activeServers.push(server);
		const config = createUploadConfig(server);

		const result = await uploadSession(
			createFileRequest("legacy-too-large", transcriptPath),
			config,
		);

		expect(result).toMatchObject({
			success: false,
			attempts: 0,
			retryable: false,
		});
		expect(result.error).toContain("Transcript too large for this server");
		expect(result.error).toContain("32.00 MiB safe limit for legacy uploads");
		expect(requestPaths).toEqual(["/rpc/ingest/init"]);
		expect(
			hasAdvertisedR2UploadCapability(
				new URL(config.endpoint),
				"api-key",
				TOKEN,
			),
		).toBe(false);
	}, 60_000);

	test("keeps using the unchanged legacy body path without an upgrade hint", async () => {
		await isolateCapabilityCache();
		const paths: string[] = [];
		const bodies: string[] = [];
		const server = serveFetchStub({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				paths.push(new URL(request.url).pathname);
				bodies.push(await request.text());
				return rpcResponse({ success: true, sessionId: "legacy-session" });
			},
		});
		activeServers.push(server);
		const config = createUploadConfig(server);

		const first = await uploadSession(
			createRequest("legacy-one", "one"),
			config,
		);
		const second = await uploadSession(
			createRequest("legacy-two", "two"),
			config,
		);

		expect(first.success).toBe(true);
		expect(second.success).toBe(true);
		expect(paths).toEqual(["/rpc/ingestSession", "/rpc/ingestSession"]);
		expect(bodies[0]).toContain('"content":"one"');
		expect(bodies[1]).toContain('"content":"two"');
	});

	test("falls back to legacy when an advertised init path is unavailable", async () => {
		await isolateCapabilityCache();
		const paths: string[] = [];
		let legacyCalls = 0;
		const server = serveFetchStub({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				const pathname = new URL(request.url).pathname;
				paths.push(pathname);
				const input = await readRpcInput(request);
				if (pathname === "/rpc/ingest/init") {
					return Response.json(
						{
							json: {
								code: "NOT_FOUND",
								defined: false,
								message: "Not Found",
								status: 404,
							},
						},
						{ status: 404 },
					);
				}
				legacyCalls += 1;
				return rpcResponse({
					success: true,
					sessionId: getRequiredString(input, "sessionId"),
					...(legacyCalls === 1
						? { upgradeHint: { protocol: "r2_multipart_v1" } }
						: {}),
				});
			},
		});
		activeServers.push(server);
		const config = createUploadConfig(server);

		const advertised = await uploadSession(
			createRequest("advertised", "clean"),
			config,
		);
		const fallback = await uploadSession(
			createRequest("fallback", "still clean"),
			config,
		);

		expect(advertised.success).toBe(true);
		expect(fallback.success).toBe(true);
		expect(paths).toEqual([
			"/rpc/ingestSession",
			"/rpc/ingest/init",
			"/rpc/ingestSession",
		]);
	});
});

interface FetchStub {
	readonly port: number;
	stop(force?: boolean): void;
}

let nextFetchStubPort = 20_000;

function serveFetchStub(options: {
	readonly fetch: (request: Request) => Promise<Response> | Response;
	readonly hostname?: string;
	readonly idleTimeout?: number;
	readonly port: number;
}): FetchStub {
	const previousFetch = globalThis.fetch;
	let stopped = false;
	globalThis.fetch = async (input, init) =>
		options.fetch(new Request(input, init));
	return {
		port: nextFetchStubPort++,
		stop() {
			if (stopped) return;
			stopped = true;
			globalThis.fetch = previousFetch;
		},
	};
}

async function isolateCapabilityCache(): Promise<void> {
	const directory = await mkdtemp(join(tmpdir(), "opaline-r2-capabilities-"));
	temporaryDirectories.push(directory);
	process.env.OPALINE_CONFIG_DIR = directory;
}

function createUploadConfig(server: FetchStub): UploadConfig {
	return {
		allowInsecureEndpoint: false,
		authType: "api-key",
		endpoint: `http://127.0.0.1:${server.port}/rpc`,
		r2MultipartBaseDelayMs: 0,
		r2StatusPollIntervalMs: 0,
		token: TOKEN,
	};
}

function createRequest(sessionId: string, content: string): IngestSessionInput {
	return {
		content,
		projectPath: "/test/project",
		sessionId,
		source: "claude_code",
	};
}

function createFileRequest(
	sessionId: string,
	transcriptPath: string,
): FileBackedUploadRequest {
	return {
		kind: "file",
		metadata: {
			projectPath: "/test/project",
			sessionId,
			source: "codex",
		},
		subagents: [],
		transcriptPath,
	};
}

function createSuccessResult(sessionId: string) {
	return {
		redacted: {},
		redactedBytes: 0,
		sessionId,
		success: true,
	};
}

function rpcResponse(value: unknown): Response {
	return Response.json({ json: value });
}

async function readRpcInput(
	request: Request,
): Promise<Record<string, unknown>> {
	const parsed: unknown = JSON.parse(await request.text());
	if (!isRecord(parsed) || !isRecord(parsed.json)) {
		throw new Error("invalid oRPC test request");
	}
	return parsed.json;
}

function getMainObject(
	input: Record<string, unknown>,
): Record<string, unknown> {
	if (!Array.isArray(input.objects)) throw new Error("missing R2 objects");
	const main = input.objects.find(
		(object) => isRecord(object) && object.kind === "main",
	);
	if (!isRecord(main)) throw new Error("missing R2 main object");
	return main;
}

function getRequiredMapValue(
	values: ReadonlyMap<string, Record<string, unknown>>,
	key: string,
): Record<string, unknown> {
	const value = values.get(key);
	if (!value) throw new Error(`missing captured RPC input for ${key}`);
	return value;
}

function getRequiredString(
	record: Record<string, unknown>,
	key: string,
): string {
	const value = record[key];
	if (typeof value !== "string") throw new Error(`missing string ${key}`);
	return value;
}

function getRequiredNumber(
	record: Record<string, unknown>,
	key: string,
): number {
	const value = record[key];
	if (typeof value !== "number") throw new Error(`missing number ${key}`);
	return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

async function writeCodexTranscriptAtLeast(
	path: string,
	canary: string,
	minimumBytes: number,
): Promise<number> {
	const file = await open(path, "wx", 0o600);
	try {
		const firstRecord = Buffer.from(
			`${JSON.stringify({
				message: `Use ${canary}`,
				padding: "x".repeat(200),
				timestamp: "2026-08-25T12:00:00.000Z",
				type: "event_msg",
			})}\n`,
		);
		const paddingRecord = Buffer.from(
			`${JSON.stringify({
				message: "x".repeat(64 * 1024 - 200),
				timestamp: "2026-08-25T12:00:01.000Z",
				type: "response_item",
			})}\n`,
		);
		let byteLength = await writeCompleteBuffer(file, firstRecord);
		while (byteLength <= minimumBytes) {
			byteLength += await writeCompleteBuffer(file, paddingRecord);
		}
	} finally {
		await file.close();
	}
	return (await stat(path)).size;
}

async function writeCodexTranscriptWithOversizedFirstRecord(
	path: string,
	minimumRecordBytes: number,
): Promise<number> {
	const file = await open(path, "wx", 0o600);
	try {
		let recordBytes = await writeCompleteBuffer(
			file,
			Buffer.from('{"type":"response_item","message":"'),
		);
		const padding = Buffer.alloc(64 * 1024, "x");
		while (recordBytes < minimumRecordBytes) {
			recordBytes += await writeCompleteBuffer(file, padding);
		}
		await writeCompleteBuffer(file, Buffer.from('"}\n'));
		await writeCompleteBuffer(
			file,
			Buffer.from(
				`${JSON.stringify({
					timestamp: "2026-08-25T12:00:00.000Z",
					type: "event_msg",
				})}\n`,
			),
		);
	} finally {
		await file.close();
	}
	return (await stat(path)).size;
}

async function writeCompleteBuffer(
	file: FileHandle,
	buffer: Uint8Array,
): Promise<number> {
	let offset = 0;
	while (offset < buffer.byteLength) {
		const { bytesWritten } = await file.write(
			buffer,
			offset,
			buffer.byteLength - offset,
		);
		if (bytesWritten === 0) throw new Error("Large fixture write stalled");
		offset += bytesWritten;
	}
	return offset;
}

function parseMemoryProbe(raw: string): MemoryProbe {
	const value: unknown = JSON.parse(raw);
	if (
		!isRecord(value) ||
		typeof value.attempts !== "number" ||
		typeof value.awsRedactions !== "number" ||
		(value.error !== null && typeof value.error !== "string") ||
		typeof value.heapDelta !== "number" ||
		typeof value.initByteLength !== "number" ||
		typeof value.initSha256 !== "string" ||
		!Array.isArray(value.requestPaths) ||
		!value.requestPaths.every((path) => typeof path === "string") ||
		(value.retryable !== null && typeof value.retryable !== "boolean") ||
		typeof value.rssDelta !== "number" ||
		typeof value.success !== "boolean" ||
		typeof value.uploadedBytes !== "number" ||
		typeof value.uploadedHash !== "string" ||
		typeof value.uploadedPartCount !== "number" ||
		typeof value.uploadedPrefix !== "string"
	) {
		throw new Error(`Invalid memory probe output: ${raw}`);
	}
	return {
		attempts: value.attempts,
		awsRedactions: value.awsRedactions,
		error: value.error,
		heapDelta: value.heapDelta,
		initByteLength: value.initByteLength,
		initSha256: value.initSha256,
		requestPaths: value.requestPaths,
		retryable: value.retryable,
		rssDelta: value.rssDelta,
		success: value.success,
		uploadedBytes: value.uploadedBytes,
		uploadedHash: value.uploadedHash,
		uploadedPartCount: value.uploadedPartCount,
		uploadedPrefix: value.uploadedPrefix,
	};
}
