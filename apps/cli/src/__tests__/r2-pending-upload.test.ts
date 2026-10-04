import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getLogger } from "@logtape/logtape";
import { type BatchUploadItem, batchUpload } from "../lib/batch-upload.js";
import {
	isRetryCandidate,
	loadFailedUploads,
	recordPendingUpload,
} from "../lib/failed-uploads.js";
import { reportHookUploadFailure } from "../lib/hook-upload-failure.js";
import { reconcilePendingUploads } from "../lib/pending-upload-reconcile.js";
import { rememberR2UploadCapability } from "../lib/r2-upload-capability.js";
import { type UploadConfig, uploadSession } from "../lib/uploader.js";
import {
	type R2IngestStub,
	startR2IngestStub,
} from "./helpers/r2-ingest-stub.js";

const TOKEN = "pending-upload-test-token";
const directories: string[] = [];
const stubs: R2IngestStub[] = [];
const originalConfigDir = process.env.OPALINE_CONFIG_DIR;
// No sinks are configured in tests, so this logger records nothing.
const silentLogger = getLogger(["opaline", "test", "pending-upload"]);

beforeEach(async () => {
	const directory = await mkdtemp(join(tmpdir(), "opaline-pending-upload-"));
	directories.push(directory);
	process.env.OPALINE_CONFIG_DIR = directory;
});

afterAll(async () => {
	await Promise.all(stubs.map((stub) => stub.stop()));
	await Promise.all(
		directories.map((directory) =>
			rm(directory, { force: true, recursive: true }),
		),
	);
	if (originalConfigDir === undefined) delete process.env.OPALINE_CONFIG_DIR;
	else process.env.OPALINE_CONFIG_DIR = originalConfigDir;
});

async function startStub(): Promise<R2IngestStub> {
	const stub = startR2IngestStub();
	stubs.push(stub);
	await rememberR2UploadCapability(
		new URL(`${stub.baseUrl}/rpc`),
		"api-key",
		TOKEN,
	);
	return stub;
}

function uploadConfig(stub: R2IngestStub, maxPolls: number): UploadConfig {
	return {
		allowInsecureEndpoint: false,
		authType: "api-key",
		endpoint: `${stub.baseUrl}/rpc`,
		r2MultipartBaseDelayMs: 0,
		r2StatusMaxPolls: maxPolls,
		r2StatusPollIntervalMs: 0,
		token: TOKEN,
	};
}

function reconcileEnvironment(stub: R2IngestStub) {
	return {
		allowInsecureEndpoint: false,
		authType: "api-key" as const,
		endpoint: `${stub.baseUrl}/rpc`,
		token: TOKEN,
	};
}

function session(sessionId: string) {
	return {
		content: JSON.stringify({
			content: "pending upload test",
			timestamp: "2026-10-04T10:00:00.000Z",
			type: "user",
		}),
		projectPath: "/test/project",
		sessionId,
		source: "claude_code" as const,
	};
}

function pendingEntry(sessionId: string, jobId: string) {
	return {
		error: "Still processing on the server",
		jobId,
		projectPath: "/test/project",
		sessionId,
		source: "claude_code" as const,
		transcriptPath: `/sessions/${sessionId}.jsonl`,
	};
}

describe("R2 uploads the server is still processing", () => {
	test("a queued commit is not repeated and ends as pending, not failed", async () => {
		const stub = await startStub();
		stub.commit = () => ({
			kind: "unavailable",
			reason: "R2_INGEST_GATE_QUEUE_TIMEOUT",
		});
		stub.status = () => ({ kind: "pending" });

		const result = await uploadSession(
			session("queued-session"),
			uploadConfig(stub, 3),
		);

		expect(result).toMatchObject({
			success: false,
			pendingJobId: stub.nextJobId,
			retryable: true,
		});
		expect(stub.calls.map((call) => call.pathname)).toEqual([
			"/rpc/ingest/init",
			"/rpc/ingest/commit",
			"/rpc/ingest/status",
			"/rpc/ingest/status",
			"/rpc/ingest/status",
		]);
	});

	test("a commit queued by the current API (retry-later, queued) polls and completes", async () => {
		const stub = await startStub();
		let polls = 0;
		stub.commit = () => ({
			kind: "unavailable",
			queued: true,
			reason: "R2_INGEST_JOB_RETRY_LATER",
		});
		stub.status = () => {
			polls += 1;
			return polls < 2
				? { errorCode: "R2_INGEST_COMMIT_QUEUED", kind: "pending" }
				: { kind: "completed" };
		};

		const result = await uploadSession(
			session("queued-then-done"),
			uploadConfig(stub, 5),
		);

		expect(result).toMatchObject({ success: true });
	});

	test("polling-window exhaustion records pending in the hook without an error line", async () => {
		const stub = await startStub();
		stub.status = () => ({ kind: "running" });

		const result = await uploadSession(
			session("slow-session"),
			uploadConfig(stub, 2),
		);
		const hookError = await reportHookUploadFailure(silentLogger, result, {
			projectPath: "/test/project",
			sessionId: "slow-session",
			source: "claude_code",
			transcriptPath: "/sessions/slow-session.jsonl",
		});

		expect(hookError).toBeUndefined();
		expect(await loadFailedUploads()).toMatchObject([
			{ jobId: stub.nextJobId, sessionId: "slow-session", status: "pending" },
		]);
		expect(isRetryCandidate((await loadFailedUploads())[0], true)).toBe(false);
	});

	test("a server job that fails while polling is a real, permanent failure", async () => {
		const stub = await startStub();
		stub.status = () => ({
			code: "R2_INGEST_PROCESSING_FAILED",
			kind: "failed",
			message: "Transcript could not be parsed",
		});

		const result = await uploadSession(
			session("broken-session"),
			uploadConfig(stub, 5),
		);

		expect(result).toMatchObject({
			error:
				"R2 ingest job failed after upload: Transcript could not be parsed",
			retryable: false,
			success: false,
		});
		expect(result.pendingJobId).toBeUndefined();
	});
});

describe("pending upload reconciliation", () => {
	test("completed jobs are cleared, failed jobs carry the server error, pending jobs stay", async () => {
		const stub = await startStub();
		const answers = new Map([
			["job-done", { kind: "completed" as const }],
			[
				"job-broken",
				{
					code: "R2_INGEST_PROCESSING_FAILED",
					kind: "failed" as const,
					message: "Transcript could not be parsed",
				},
			],
			[
				"job-expired",
				{
					code: "R2_INGEST_JOB_EXPIRED",
					kind: "failed" as const,
					message: "Ingest job expired before processing could start",
				},
			],
			[
				"job-busy",
				{ errorCode: "R2_INGEST_COMMIT_QUEUED", kind: "pending" as const },
			],
			["job-gone", { kind: "not-found" as const }],
		]);
		stub.status = (jobId) => answers.get(jobId) ?? { kind: "not-found" };
		for (const [jobId] of answers)
			await recordPendingUpload(
				pendingEntry(jobId.replace("job", "session"), jobId),
			);

		const summary = await reconcilePendingUploads(
			{ maxEntries: 10 },
			reconcileEnvironment(stub),
		);

		expect(summary).toEqual({
			checked: 5,
			completed: 1,
			failed: 1,
			requeued: 2,
			stillPending: 1,
		});
		const entries = await loadFailedUploads();
		expect(entries.map((entry) => entry.sessionId).sort()).toEqual([
			"session-broken",
			"session-busy",
			"session-expired",
			"session-gone",
		]);
		expect(
			entries.find((entry) => entry.sessionId === "session-broken"),
		).toMatchObject({
			error:
				"R2 ingest job failed after upload: Transcript could not be parsed",
			status: "permanent",
		});
		expect(
			entries.find((entry) => entry.sessionId === "session-expired"),
		).toMatchObject({
			status: "retryable",
		});
		expect(
			entries.find((entry) => entry.sessionId === "session-gone"),
		).toMatchObject({
			status: "retryable",
		});
		const busy = entries.find((entry) => entry.sessionId === "session-busy");
		expect(busy).toMatchObject({ jobId: "job-busy", status: "pending" });
		expect(busy?.checkedAt).toBeString();
	});

	test("checks at most the requested number of entries, least recently checked first", async () => {
		const stub = await startStub();
		stub.status = () => ({ kind: "pending" });
		await recordPendingUpload(pendingEntry("session-a", "job-a"));
		await recordPendingUpload(pendingEntry("session-b", "job-b"));
		await recordPendingUpload(pendingEntry("session-c", "job-c"));

		await reconcilePendingUploads(
			{ maxEntries: 2 },
			reconcileEnvironment(stub),
		);
		await reconcilePendingUploads(
			{ maxEntries: 1 },
			reconcileEnvironment(stub),
		);

		expect(stub.calls.map((call) => String(call.input.jobId))).toEqual([
			"job-a",
			"job-b",
			"job-c",
		]);
	});

	test("an unreachable server leaves entries untouched after one attempt", async () => {
		await recordPendingUpload(pendingEntry("session-a", "job-a"));
		await recordPendingUpload(pendingEntry("session-b", "job-b"));

		const summary = await reconcilePendingUploads(
			{ maxEntries: 5 },
			{
				allowInsecureEndpoint: false,
				authType: "api-key",
				endpoint: "http://127.0.0.1:9/rpc",
				token: TOKEN,
			},
		);

		expect(summary.checked).toBe(0);
		expect((await loadFailedUploads()).map((entry) => entry.status)).toEqual([
			"pending",
			"pending",
		]);
	});

	test("a pending entry past the server's job lifetime is re-uploaded", async () => {
		const stub = await startStub();
		stub.status = () => ({ kind: "pending" });
		await recordPendingUpload(pendingEntry("session-old", "job-old"));

		await reconcilePendingUploads(
			{ maxEntries: 5, now: new Date(Date.now() + 49 * 60 * 60 * 1_000) },
			reconcileEnvironment(stub),
		);

		expect(await loadFailedUploads()).toMatchObject([
			{ sessionId: "session-old", status: "retryable" },
		]);
	});
});

describe("batch upload ordering and pending results", () => {
	test("uploads smaller sessions first and counts pending jobs separately", async () => {
		const directory = await mkdtemp(join(tmpdir(), "opaline-batch-order-"));
		directories.push(directory);
		const sizes = { huge: 4_000, medium: 400, small: 40 };
		const items: BatchUploadItem[] = [];
		for (const [name, size] of Object.entries(sizes)) {
			const transcriptPath = join(directory, `${name}.jsonl`);
			await Bun.write(transcriptPath, "x".repeat(size));
			items.push({
				label: name,
				projectPath: directory,
				sessionId: name,
				transcriptPath,
			});
		}
		items.push({
			label: "missing",
			projectPath: directory,
			sessionId: "missing",
			transcriptPath: join(directory, "missing.jsonl"),
		});
		const order: string[] = [];

		const summary = await batchUpload({
			concurrency: 1,
			items,
			upload: async (item) => {
				order.push(item.sessionId);
				return item.sessionId === "medium"
					? { pendingJobId: "job-medium", retryable: true, success: false }
					: { success: true };
			},
		});

		expect(order).toEqual(["small", "medium", "huge", "missing"]);
		expect(summary).toMatchObject({ failed: 0, pending: 1, succeeded: 3 });
		expect(await loadFailedUploads()).toMatchObject([
			{ jobId: "job-medium", sessionId: "medium", status: "pending" },
		]);
	});
});
