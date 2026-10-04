import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	R2IngestUploadObject,
	R2IngestUploadPart,
} from "../lib/r2-ingest-contract.js";
import {
	buildFilePartRanges,
	uploadR2MultipartObjects,
} from "../lib/r2-multipart-upload.js";

/**
 * Measures the test process's ArrayBuffer memory, so it runs in its own
 * process (`bun run test:r2-memory`, part of `bun run test`): allocations of
 * other suites in a shared process (large transcripts, staging buffers) push
 * the measured peak over the bound without any change to the uploader.
 */

const temporaryDirectories: string[] = [];
const activeIntervals: Array<ReturnType<typeof setInterval>> = [];

afterEach(async () => {
	for (const interval of activeIntervals.splice(0)) clearInterval(interval);
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { force: true, recursive: true })),
	);
});

describe("R2 multipart memory", () => {
	test("streams a file larger than 100 MiB with bounded ArrayBuffer memory", async () => {
		const directory = await createTemporaryDirectory();
		const path = join(directory, "large-transcript.jsonl");
		const byteLength = 101 * 1024 * 1024 + 17;
		const partSizeBytes = 8 * 1024 * 1024;
		await writeFile(path, "");
		await truncate(path, byteLength);
		const receivedPartBytes: number[] = [];
		const fetchMock: typeof fetch = async (input, init) => {
			const request = new Request(input, init);
			let received = 0;
			if (request.body) {
				for await (const chunk of request.body) {
					received += chunk.byteLength;
				}
			}
			receivedPartBytes.push(received);
			return new Response(null, {
				headers: { etag: `"part-${receivedPartBytes.length}"` },
			});
		};
		const ranges = buildFilePartRanges(byteLength, partSizeBytes);
		const parts: R2IngestUploadPart[] = ranges.map((range) => ({
			byteLength: range.byteLength,
			headers: { "Content-Length": range.byteLength.toString() },
			partNumber: range.partNumber,
			uploadUrl: `https://r2.test/part/${range.partNumber}`,
		}));
		const upload: R2IngestUploadObject = {
			byteLength,
			kind: "main",
			objectKey: "ingest/large/main.jsonl",
			parts,
			sha256: "a".repeat(64),
			uploadId: "large-upload",
		};
		Bun.gc(true);
		const baseline = process.memoryUsage().arrayBuffers;
		let peak = baseline;
		const sampleMemory = () => {
			peak = Math.max(peak, process.memoryUsage().arrayBuffers);
		};
		const interval = setInterval(sampleMemory, 2);
		activeIntervals.push(interval);

		const result = await uploadR2MultipartObjects({
			baseDelayMs: 50,
			fetch: fetchMock,
			maxAttempts: 3,
			onProgress: sampleMemory,
			onRetry: undefined,
			sources: [{ path, upload }],
		});
		clearInterval(interval);
		activeIntervals.splice(activeIntervals.indexOf(interval), 1);

		expect(receivedPartBytes).toEqual(ranges.map((range) => range.byteLength));
		expect(result.objects[0]?.parts).toHaveLength(ranges.length);
		expect(peak - baseline).toBeLessThan(64 * 1024 * 1024);
	}, 60_000);
});

async function createTemporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "opaline-r2-memory-test-"));
	temporaryDirectories.push(directory);
	return directory;
}
