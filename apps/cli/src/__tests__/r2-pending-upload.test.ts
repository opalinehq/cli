import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getLogger } from "@logtape/logtape";
import {
	findAnalysisMarkers,
	recordAnalysisMarker,
} from "../lib/analysis-markers.js";
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
			["job-done", { kind: "completed" as const, sessionId: "session-done" }],
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
			linkFailures: [],
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

describe("pending analysis uploads and inaccessible jobs", () => {
	const destination = { account: "user:test", endpoint: "https://x/rpc" };

	test("a completed analysis job without the echoed link is a link failure and drops the marker", async () => {
		const stub = await startStub();
		stub.status = (jobId) =>
			jobId === "job-linked"
				? {
						analysisId: "analysis-1",
						kind: "completed",
						sessionId: "session-linked",
					}
				: { kind: "completed", sessionId: "session-unlinked" };
		for (const sessionId of ["session-linked", "session-unlinked"]) {
			await recordAnalysisMarker({
				analysisId: "analysis-1",
				destination,
				memberIds: [],
				related: false,
				sessionId,
				source: "codex",
			});
			await recordPendingUpload({
				...pendingEntry(sessionId, sessionId.replace("session", "job")),
				analysisDestination: destination,
				analysisId: "analysis-1",
			});
		}

		const summary = await reconcilePendingUploads(
			{ maxEntries: 5 },
			reconcileEnvironment(stub),
		);

		expect(summary).toMatchObject({ completed: 1, failed: 1 });
		expect(summary.linkFailures).toEqual([
			expect.stringContaining(
				"session-unlinked: Opaline stored this session without its link to analysis analysis-1",
			),
		]);
		expect(await loadFailedUploads()).toMatchObject([
			{ sessionId: "session-unlinked", status: "permanent" },
		]);
		expect(await findAnalysisMarkers("codex", "session-unlinked")).toEqual([]);
		expect(await findAnalysisMarkers("codex", "session-linked")).toHaveLength(
			1,
		);
	});

	test("a completed job naming another session is not cleared", async () => {
		const stub = await startStub();
		stub.status = () => ({ kind: "completed", sessionId: "someone-else" });
		await recordPendingUpload(pendingEntry("session-a", "job-a"));

		await reconcilePendingUploads(
			{ maxEntries: 5 },
			reconcileEnvironment(stub),
		);

		expect(await loadFailedUploads()).toMatchObject([
			{ sessionId: "session-a", status: "retryable" },
		]);
	});

	test("a job-specific refusal settles that job and the pass continues", async () => {
		const stub = await startStub();
		stub.status = (jobId) =>
			jobId === "job-forbidden"
				? {
						code: "FORBIDDEN",
						kind: "http-error",
						message: "Not your job",
						status: 403,
					}
				: { kind: "completed", sessionId: "session-done" };
		await recordPendingUpload(
			pendingEntry("session-forbidden", "job-forbidden"),
		);
		await recordPendingUpload(pendingEntry("session-done", "job-done"));

		const summary = await reconcilePendingUploads(
			{ maxEntries: 5 },
			reconcileEnvironment(stub),
		);

		expect(summary).toMatchObject({ checked: 2, completed: 1, requeued: 1 });
		expect(await loadFailedUploads()).toMatchObject([
			{
				error: expect.stringContaining("403 Not your job"),
				sessionId: "session-forbidden",
				status: "retryable",
			},
		]);
	});

	test("an invalid key stops the pass without touching entries", async () => {
		const stub = await startStub();
		stub.status = () => ({
			code: "UNAUTHORIZED",
			kind: "http-error",
			message: "Invalid API key",
			status: 401,
		});
		await recordPendingUpload(pendingEntry("session-a", "job-a"));
		await recordPendingUpload(pendingEntry("session-b", "job-b"));

		const summary = await reconcilePendingUploads(
			{ maxEntries: 5 },
			reconcileEnvironment(stub),
		);

		expect(summary.checked).toBe(0);
		expect(stub.calls).toHaveLength(1);
		expect((await loadFailedUploads()).map((entry) => entry.status)).toEqual([
			"pending",
			"pending",
		]);
	});
});

describe("analysis markers across processes", () => {
	test("concurrent hook processes keep every update and a removal", async () => {
		const destination = { account: "user:test", endpoint: "https://x/rpc" };
		const kept = await recordAnalysisMarker({
			analysisId: "analysis-kept",
			destination,
			memberIds: [],
			related: true,
			sessionId: "thread-kept",
			source: "codex",
		});
		const removed = await recordAnalysisMarker({
			analysisId: "analysis-removed",
			destination,
			memberIds: [],
			related: true,
			sessionId: "thread-removed",
			source: "codex",
		});
		const worker = join(
			import.meta.dir,
			"helpers",
			"analysis-marker-worker.ts",
		);
		const members = Array.from({ length: 8 }, (_, index) => `child-${index}`);
		const runs = [
			["remove", removed.markerId],
			...members.map((member) => ["merge", kept.markerId, member]),
			["merge", removed.markerId, "late-child"],
		].map((args) =>
			Bun.spawn(["bun", worker, ...args], {
				env: { ...process.env },
				stderr: "pipe",
			}),
		);
		const exitCodes = await Promise.all(runs.map((run) => run.exited));

		expect(exitCodes.every((code) => code === 0)).toBe(true);
		const [marker] = await findAnalysisMarkers("codex", "thread-kept");
		expect(marker?.memberIds.slice().sort()).toEqual(
			["thread-kept", ...members].sort(),
		);
		expect(Object.keys(marker?.uploaded ?? {}).sort()).toEqual(members);
		expect(await findAnalysisMarkers("codex", "thread-removed")).toEqual([]);
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

	test("orders by the slimmed size an earlier attempt measured, else the raw size, and keeps the measurement", async () => {
		const directory = await mkdtemp(join(tmpdir(), "opaline-slim-order-"));
		directories.push(directory);
		const write = async (name: string, size: number) => {
			const transcriptPath = join(directory, `${name}.jsonl`);
			await Bun.write(transcriptPath, "x".repeat(size));
			return transcriptPath;
		};
		const items: BatchUploadItem[] = [
			{
				label: "screenshots",
				projectPath: directory,
				sessionId: "screenshots",
				// Raw 9,000 bytes, but only 30 bytes once images are slimmed.
				transcriptPath: await write("screenshots", 9_000),
				uploadBytes: 30,
			},
			{
				label: "plain",
				projectPath: directory,
				sessionId: "plain",
				transcriptPath: await write("plain", 500),
			},
			{
				label: "measured-large",
				projectPath: directory,
				sessionId: "measured-large",
				transcriptPath: await write("measured-large", 50),
				uploadBytes: 5_000,
			},
		];
		const order: string[] = [];

		await batchUpload({
			concurrency: 1,
			items,
			upload: async (item) => {
				order.push(item.sessionId);
				if (item.sessionId === "screenshots")
					return {
						error: "server busy",
						retryable: true,
						success: false,
						uploadBytes: 31,
					};
				if (item.sessionId === "measured-large")
					return { error: "server busy", retryable: true, success: false };
				return { success: true };
			},
		});

		expect(order).toEqual(["screenshots", "plain", "measured-large"]);
		const failures = await loadFailedUploads();
		expect(
			failures.map(({ sessionId, uploadBytes }) => ({
				sessionId,
				uploadBytes,
			})),
		).toEqual([
			{ sessionId: "screenshots", uploadBytes: 31 },
			{ sessionId: "measured-large", uploadBytes: 5_000 },
		]);
	});
});

describe("failed uploads recorded by 0.11", () => {
	test("size skips this version can upload become retryable; other permanent failures stay", async () => {
		const entry = (sessionId: string, error: string) => ({
			error,
			failedAt: "2026-09-30T10:00:00.000Z",
			projectPath: "/repo",
			sessionId,
			source: "claude_code",
			status: "permanent",
			transcriptPath: `/repo/${sessionId}.jsonl`,
		});
		await writeFile(
			join(process.env.OPALINE_CONFIG_DIR ?? "", "failed-uploads.json"),
			JSON.stringify({
				failures: [
					entry(
						"raw-skip",
						"Skipped: session files total 212.40 MiB, above the 128.00 MiB per-session limit. No upload attempted.",
					),
					entry(
						"filtered-skip",
						"Session transcript payload is 140.25 MiB, above the 128.00 MiB per-session limit. Reduce the transcript/subagent payload before retrying.",
					),
					entry(
						"legacy-skip",
						"Transcript too large for this server: the 40.00 MiB transcript/subagent payload exceeds the CLI's 32.00 MiB safe limit for legacy uploads. Upgrade the Opaline server to one that supports direct R2 uploads, or upload a smaller transcript.",
					),
					entry(
						"huge-skip",
						"Skipped: session files total 2048.00 MiB, above the 128.00 MiB per-session limit. No upload attempted.",
					),
					entry(
						"no-timestamps",
						"This transcript has no timestamped user/assistant messages.",
					),
				],
			}),
		);

		const statuses = Object.fromEntries(
			(await loadFailedUploads()).map((failure) => [
				failure.sessionId,
				failure.status,
			]),
		);

		expect(statuses).toEqual({
			"raw-skip": "retryable",
			"filtered-skip": "retryable",
			"legacy-skip": "retryable",
			"huge-skip": "permanent",
			"no-timestamps": "permanent",
		});
	});
});
