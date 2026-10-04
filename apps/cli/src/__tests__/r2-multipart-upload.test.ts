import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { R2IngestUploadObject } from "../lib/r2-ingest-contract.js";
import {
	buildFilePartRanges,
	inspectUploadFile,
	uploadR2MultipartObjects,
} from "../lib/r2-multipart-upload.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { force: true, recursive: true })),
	);
});

describe("R2 multipart file handling", () => {
	test("splits files into exact byte ranges", () => {
		expect(buildFilePartRanges(18, 8)).toEqual([
			{ byteLength: 8, end: 7, partNumber: 1, start: 0 },
			{ byteLength: 8, end: 15, partNumber: 2, start: 8 },
			{ byteLength: 2, end: 17, partNumber: 3, start: 16 },
		]);
	});

	test("computes SHA-256 and byte length without changing the file", async () => {
		const directory = await createTemporaryDirectory();
		const path = join(directory, "digest.jsonl");
		const content = "abc\n€\n";
		await writeFile(path, content);

		expect(await inspectUploadFile(path)).toEqual({
			byteLength: Buffer.byteLength(content),
			sha256: createHash("sha256").update(content).digest("hex"),
		});
	});

	test("retries a transient PUT with the same signed Content-Length", async () => {
		const directory = await createTemporaryDirectory();
		const path = join(directory, "retry.jsonl");
		const content = "retry-body";
		await writeFile(path, content);
		const receivedLengths: string[] = [];
		const receivedBodies: string[] = [];
		const retries: number[] = [];
		const uploadedSnapshots: number[] = [];
		const fetchMock: typeof fetch = async (input, init) => {
			const request = new Request(input, init);
			receivedLengths.push(request.headers.get("content-length") ?? "");
			receivedBodies.push(await request.text());
			if (receivedBodies.length === 1) {
				return new Response("try again", { status: 503 });
			}
			return new Response(null, { headers: { etag: '"retry-etag"' } });
		};
		const upload = createUploadObject(content.length, "https://r2.test/part/1");

		const result = await uploadR2MultipartObjects({
			baseDelayMs: 0,
			fetch: fetchMock,
			maxAttempts: 3,
			onProgress: (progress) =>
				uploadedSnapshots.push(progress.objectBytesUploaded),
			onRetry: (retry) => retries.push(retry.attempt),
			sources: [{ path, upload }],
		});
		expect(uploadedSnapshots.filter((bytes) => bytes === 0)).toHaveLength(2);
		expect(
			uploadedSnapshots.reduce(
				(sum, bytes, index) =>
					sum + Math.max(0, bytes - (uploadedSnapshots[index - 1] ?? 0)),
				0,
			),
		).toBe(content.length * 2);

		expect(receivedBodies).toEqual([content, content]);
		expect(receivedLengths).toEqual(
			Array.from({ length: 2 }, () => content.length.toString()),
		);
		expect(retries).toEqual([1]);
		expect(result).toEqual({
			attempts: 2,
			objects: [
				{
					objectKey: upload.objectKey,
					parts: [{ etag: '"retry-etag"', partNumber: 1 }],
					uploadId: upload.uploadId,
				},
			],
		});
	});
});

async function createTemporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "opaline-r2-test-"));
	temporaryDirectories.push(directory);
	return directory;
}

function createUploadObject(
	byteLength: number,
	uploadUrl: string,
): R2IngestUploadObject {
	return {
		byteLength,
		kind: "main",
		objectKey: "ingest/test/main.jsonl",
		parts: [
			{
				byteLength,
				headers: { "Content-Length": byteLength.toString() },
				partNumber: 1,
				uploadUrl,
			},
		],
		sha256: "a".repeat(64),
		uploadId: "test-upload",
	};
}
