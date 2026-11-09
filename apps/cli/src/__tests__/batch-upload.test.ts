import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "@logtape/logtape";
import { MissingTranscriptTimestampError } from "../internal/agent-adapters/index.js";
import { SecretFilterJsonIntegrityError } from "../internal/secret-filter/index.js";
import { type BatchUploadItem, batchUpload } from "../lib/batch-upload.js";
import {
	type FailedUpload,
	isRetryCandidate,
	loadFailedUploads,
	recordFailedUpload,
} from "../lib/failed-uploads.js";
import { reportHookUploadFailure } from "../lib/hook-upload-failure.js";

describe("batchUpload", () => {
	let configDir: string;
	let originalConfigDir: string | undefined;

	beforeAll(async () => {
		originalConfigDir = process.env.RUDEL_CONFIG_DIR;
		configDir = await mkdtemp(join(tmpdir(), "rudel-batch-upload-test-"));
		process.env.RUDEL_CONFIG_DIR = configDir;
	});

	afterAll(async () => {
		if (originalConfigDir === undefined) {
			delete process.env.RUDEL_CONFIG_DIR;
		} else {
			process.env.RUDEL_CONFIG_DIR = originalConfigDir;
		}
		await rm(configDir, { recursive: true, force: true });
	});

	test("retains timestamp-less sessions as permanent failures", async () => {
		const items: BatchUploadItem[] = [
			{
				sessionId: "client-validation",
				label: "client-validation",
				transcriptPath: "/sessions/client-validation.jsonl",
				projectPath: "/project",
				source: "claude_code",
			},
			{
				sessionId: "server-validation",
				label: "server-validation",
				transcriptPath: "/sessions/server-validation.jsonl",
				projectPath: "/project",
				source: "codex",
			},
		];

		for (const item of items) {
			await recordFailedUpload({
				sessionId: item.sessionId,
				transcriptPath: item.transcriptPath,
				projectPath: item.projectPath,
				source: item.source,
				organizationId: item.organizationId,
				error: "stale retry entry",
			});
		}

		const summary = await batchUpload({
			items,
			upload: async (item) => {
				if (item.sessionId === "client-validation") {
					throw new MissingTranscriptTimestampError("claude_code");
				}
				return {
					success: false,
					error: "Codex transcript contains no valid timestamp",
					retryable: false,
				};
			},
		});

		expect(summary).toMatchObject({
			succeeded: 0,
			failed: 0,
			skipped: 2,
			total: 2,
			errors: [],
			skippedItems: [
				{
					label: "client-validation",
					reason: "Claude Code transcript contains no valid timestamp",
				},
				{
					label: "server-validation",
					reason: "Codex transcript contains no valid timestamp",
				},
			],
		});
		expect(await loadFailedUploads()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					sessionId: "client-validation",
					status: "permanent",
				}),
				expect.objectContaining({
					sessionId: "server-validation",
					status: "permanent",
				}),
			]),
		);
	});

	test("retains typed JSON-integrity failures as permanent", async () => {
		const item: BatchUploadItem = {
			sessionId: "json-integrity",
			label: "json-integrity",
			transcriptPath: "/sessions/json-integrity.jsonl",
			projectPath: "/project",
			source: "claude_code",
		};

		const summary = await batchUpload({
			items: [item],
			upload: async () => {
				throw new SecretFilterJsonIntegrityError();
			},
		});

		expect(summary).toMatchObject({ failed: 0, skipped: 1, succeeded: 0 });
		expect(
			(await loadFailedUploads()).find(
				(failure) => failure.sessionId === item.sessionId,
			),
		).toMatchObject({
			failureKind: "json-integrity",
			status: "permanent",
		});
	});

	test("persists the hook failure kind used by retry promotion", async () => {
		const logger = { error: () => undefined } as unknown as Logger;

		await reportHookUploadFailure(
			logger,
			{
				error: "replacement is smaller",
				failureKind: "session-shrink-rejected",
				retryable: false,
				success: false,
			},
			{
				projectPath: "/project",
				sessionId: "hook-shrink",
				transcriptPath: "/sessions/hook-shrink.jsonl",
			},
		);

		expect(
			(await loadFailedUploads()).find(
				(failure) => failure.sessionId === "hook-shrink",
			),
		).toMatchObject({
			failureKind: "session-shrink-rejected",
			status: "permanent",
		});
	});

	test("normalizes legacy failures as retryable and persists dispositions", async () => {
		const legacyTranscript = join(configDir, "legacy.jsonl");
		await writeFile(legacyTranscript, "{}\n");
		await writeFile(
			join(configDir, "failed-uploads.json"),
			JSON.stringify({
				failures: [
					{
						error: "legacy transport failure",
						failedAt: "2026-07-31T10:00:00.000Z",
						projectPath: "/project",
						sessionId: "legacy",
						transcriptPath: legacyTranscript,
					},
				],
			}),
		);

		expect((await loadFailedUploads())[0]?.status).toBe("retryable");
		await recordFailedUpload({
			error: "invalid transcript",
			projectPath: "/project",
			sessionId: "permanent",
			status: "permanent",
			transcriptPath: "/sessions/permanent.jsonl",
		});
		expect(
			(await loadFailedUploads()).find(
				(failure) => failure.sessionId === "permanent",
			)?.status,
		).toBe("permanent");
	});

	test("force replacement promotes only permanent shrink failures", () => {
		const base: FailedUpload = {
			error: "permanent failure",
			failedAt: "2026-08-03T00:00:00.000Z",
			projectPath: "/project",
			sessionId: "permanent",
			status: "permanent",
			transcriptPath: "/sessions/permanent.jsonl",
		};

		expect(
			isRetryCandidate(
				{ ...base, failureKind: "session-shrink-rejected" },
				true,
			),
		).toBe(true);
		expect(
			isRetryCandidate({ ...base, error: "retry with --force-replace" }, true),
		).toBe(true);
		expect(
			isRetryCandidate({ ...base, failureKind: "json-integrity" }, true),
		).toBe(false);
		expect(
			isRetryCandidate(
				{ ...base, failureKind: "session-shrink-rejected" },
				false,
			),
		).toBe(false);
	});
});
