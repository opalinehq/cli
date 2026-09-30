import { describe, expect, test } from "bun:test";
import { REPOSITORY_EVIDENCE_MAX_OBJECT_BYTES } from "../contracts/index.js";
import {
	hasValidTranscriptRevisionIntegrity,
	isTranscriptRevisionManifest,
	planTranscriptRevision,
	type TranscriptRevisionScope,
} from "../lib/transcript-revision.js";

const scope: TranscriptRevisionScope = {
	actorId: "user-1",
	provider: "codex",
	providerInstanceId: "local-codex",
	sessionId: "session-1",
};

describe("transcript revision planning", () => {
	test("advances only through complete JSONL records and resumes inside the same file", async () => {
		const firstRecord = '{"ordinal":0,"text":"first"}\n';
		const partialSecondRecord = '{"ordinal":1,"text":"caf';
		const first = await planTranscriptRevision({
			content: new TextEncoder().encode(firstRecord + partialSecondRecord),
			previous: undefined,
			scope,
			terminal: false,
		});

		expect(first.newChunks).toHaveLength(1);
		expect(new TextDecoder().decode(first.newChunks[0]?.bytes)).toBe(
			firstRecord,
		);
		expect(first.manifest.watermark).toMatchObject({
			byteOffset: new TextEncoder().encode(firstRecord).byteLength,
			lastOrdinal: 0,
			recordCount: 1,
		});

		const complete = new TextEncoder().encode(
			`${firstRecord}${partialSecondRecord}é"}\n`,
		);
		const second = await planTranscriptRevision({
			content: complete,
			previous: first.manifest,
			scope,
			terminal: false,
		});

		expect(second.resetReason).toBeNull();
		expect(second.newChunks).toHaveLength(1);
		expect(new TextDecoder().decode(second.newChunks[0]?.bytes)).toBe(
			`${partialSecondRecord}é"}\n`,
		);
		expect(second.manifest.parentRevisionId).toBe(first.manifest.revisionId);
		expect(second.manifest.watermark.lastOrdinal).toBe(1);
		expect(second.manifest.chunks).toHaveLength(2);
	});

	test("withholds a terminal suffix with incomplete UTF-8 or JSON", async () => {
		const complete = new TextEncoder().encode('{"ordinal":0}\n');
		const utf8Prefix = new TextEncoder().encode('{"ordinal":1,"text":"');
		const encodedCharacter = new TextEncoder().encode("é");
		const incompleteUtf8 = new Uint8Array(
			complete.byteLength + utf8Prefix.byteLength + 1,
		);
		incompleteUtf8.set(complete);
		incompleteUtf8.set(utf8Prefix, complete.byteLength);
		incompleteUtf8.set(
			encodedCharacter.subarray(0, 1),
			complete.byteLength + utf8Prefix.byteLength,
		);

		const utf8Plan = await planTranscriptRevision({
			content: incompleteUtf8,
			previous: undefined,
			scope,
			terminal: true,
		});
		const jsonPlan = await planTranscriptRevision({
			content: new TextEncoder().encode(
				'{"ordinal":0}\n{"ordinal":1,"text":"unfinished"',
			),
			previous: undefined,
			scope,
			terminal: true,
		});

		expect(utf8Plan.manifest.watermark.byteOffset).toBe(complete.byteLength);
		expect(utf8Plan.manifest.terminal).toBe(false);
		expect(jsonPlan.manifest.watermark.byteOffset).toBe(complete.byteLength);
		expect(jsonPlan.manifest.terminal).toBe(false);
	});

	test.each([
		{
			name: "shrinks",
			nextContent: '{"ordinal":0}\n',
			expectedReason: "source-shrank",
		},
		{
			name: "rewrites an uploaded prefix",
			nextContent: '{"ordinal":9}\n{"ordinal":1}\n',
			expectedReason: "prefix-mismatch",
		},
	])(
		"starts a new generation when the source $name",
		async ({ nextContent, expectedReason }) => {
			const first = await planTranscriptRevision({
				content: new TextEncoder().encode('{"ordinal":0}\n{"ordinal":1}\n'),
				previous: undefined,
				scope,
				terminal: false,
			});

			const next = await planTranscriptRevision({
				content: new TextEncoder().encode(nextContent),
				previous: first.manifest,
				scope,
				terminal: false,
			});

			expect(next.resetReason).toBe(expectedReason);
			expect(next.manifest.generation).toBe(1);
			expect(next.manifest.parentRevisionId).toBeUndefined();
			expect(next.manifest.chunks[0]?.startByte).toBe(0);
		},
	);

	test("does not reuse a watermark across provider or actor scope", async () => {
		const content = new TextEncoder().encode('{"ordinal":0}\n');
		const first = await planTranscriptRevision({
			content,
			previous: undefined,
			scope,
			terminal: false,
		});
		const next = await planTranscriptRevision({
			content,
			previous: first.manifest,
			scope: { ...scope, actorId: "user-2" },
			terminal: false,
		});

		expect(next.resetReason).toBe("scope-changed");
		expect(next.manifest.scope.actorId).toBe("user-2");
		expect(next.manifest.generation).toBe(1);
	});
});

describe("transcript revision chunk bounds", () => {
	const mebibyte = 1024 * 1024;

	test("splits an appended region just above the protocol object limit into bounded contiguous chunks", async () => {
		const content = buildJsonl(65, mebibyte);
		expect(content.byteLength).toBeGreaterThan(
			REPOSITORY_EVIDENCE_MAX_OBJECT_BYTES,
		);

		const plan = await planTranscriptRevision({
			content,
			previous: undefined,
			scope,
			terminal: false,
		});

		expect(plan.delivery).toEqual({ status: "complete" });
		expect(plan.newChunks.length).toBeGreaterThan(1);
		for (const chunk of plan.newChunks) {
			expect(chunk.bytes.byteLength).toBeLessThanOrEqual(
				REPOSITORY_EVIDENCE_MAX_OBJECT_BYTES,
			);
			expect(content[chunk.endByte - 1]).toBe(0x0a);
		}
		expect(plan.newChunks[0]?.startByte).toBe(0);
		expect(plan.newChunks.at(-1)?.endByte).toBe(content.byteLength);
		for (const [index, chunk] of plan.newChunks.entries()) {
			expect(chunk.startByte).toBe(plan.newChunks[index - 1]?.endByte ?? 0);
		}
		expect(
			plan.newChunks.reduce((total, chunk) => total + chunk.recordCount, 0),
		).toBe(65);
		expect(plan.manifest.watermark.recordCount).toBe(65);
		expect(plan.manifest.chunks).toHaveLength(plan.newChunks.length);
	});

	test("keeps a region exactly at the object limit in one chunk", async () => {
		const content = buildJsonl(64, mebibyte);
		expect(content.byteLength).toBe(REPOSITORY_EVIDENCE_MAX_OBJECT_BYTES);

		const plan = await planTranscriptRevision({
			content,
			previous: undefined,
			scope,
			terminal: false,
		});

		expect(plan.newChunks).toHaveLength(1);
		expect(plan.newChunks[0]?.bytes.byteLength).toBe(
			REPOSITORY_EVIDENCE_MAX_OBJECT_BYTES,
		);
	});

	test("splits a single record above the object limit at byte boundaries and reassembles it", async () => {
		const record = buildJsonl(1, REPOSITORY_EVIDENCE_MAX_OBJECT_BYTES + 1024);
		const content = Buffer.concat([record, buildJsonl(1, 64, 1)]);

		const plan = await planTranscriptRevision({
			content,
			previous: undefined,
			scope,
			terminal: false,
		});

		expect(plan.newChunks.length).toBeGreaterThan(1);
		for (const chunk of plan.newChunks) {
			expect(chunk.bytes.byteLength).toBeLessThanOrEqual(
				REPOSITORY_EVIDENCE_MAX_OBJECT_BYTES,
			);
		}
		expect(
			Buffer.compare(
				Buffer.concat(plan.newChunks.map((chunk) => chunk.bytes)),
				content,
			),
		).toBe(0);
		expect(
			plan.newChunks.reduce((total, chunk) => total + chunk.recordCount, 0),
		).toBe(2);
		expect(plan.manifest.watermark.recordCount).toBe(2);
	});

	test("counts only the records that begin inside each chunk when a record straddles chunks", async () => {
		const content = Buffer.concat([
			buildJsonl(1, 10),
			buildJsonl(1, 100, 1),
			buildJsonl(1, 10, 2),
		]);

		const plan = await planTranscriptRevision({
			content,
			limits: { maxChunkBytes: 48 },
			previous: undefined,
			scope,
			terminal: false,
		});

		expect(plan.newChunks.length).toBeGreaterThan(3);
		for (const chunk of plan.newChunks) {
			expect(chunk.bytes.byteLength).toBeLessThanOrEqual(48);
		}
		expect(
			Buffer.compare(
				Buffer.concat(plan.newChunks.map((chunk) => chunk.bytes)),
				content,
			),
		).toBe(0);
		expect(
			plan.newChunks.reduce((total, chunk) => total + chunk.recordCount, 0),
		).toBe(3);
	});

	test("stops a delivery on a record boundary when the byte budget is reached and resumes from the watermark", async () => {
		const content = buildJsonl(5, 100);
		const recordBytes = content.byteLength / 5;

		const first = await planTranscriptRevision({
			content,
			limits: { maxDeliveryBytes: recordBytes * 2 + 10 },
			previous: undefined,
			scope,
			terminal: true,
		});

		expect(first.delivery).toEqual({
			remainingBytes: recordBytes * 3,
			status: "deferred",
		});
		expect(first.manifest.watermark.byteOffset).toBe(recordBytes * 2);
		expect(first.manifest.watermark.recordCount).toBe(2);
		expect(first.manifest.terminal).toBe(false);

		const second = await planTranscriptRevision({
			content,
			previous: first.manifest,
			scope,
			terminal: true,
		});

		expect(second.delivery).toEqual({ status: "complete" });
		expect(second.manifest.watermark.byteOffset).toBe(content.byteLength);
		expect(second.manifest.watermark.recordCount).toBe(5);
		expect(second.manifest.terminal).toBe(true);
		expect(second.manifest.parentRevisionId).toBe(first.manifest.revisionId);
	});

	test("fails closed without advancing when the next record exceeds the delivery budget", async () => {
		const content = Buffer.concat([buildJsonl(1, 10), buildJsonl(1, 500, 1)]);
		const firstRecordBytes = buildJsonl(1, 10).byteLength;
		const first = await planTranscriptRevision({
			content: content.subarray(0, firstRecordBytes),
			previous: undefined,
			scope,
			terminal: false,
		});

		const blocked = await planTranscriptRevision({
			content,
			limits: { maxDeliveryBytes: 100 },
			previous: first.manifest,
			scope,
			terminal: true,
		});

		expect(blocked.delivery).toEqual({
			recordBytes: content.byteLength - firstRecordBytes,
			recordStartByte: firstRecordBytes,
			status: "blocked",
		});
		expect(blocked.newChunks).toEqual([]);
		expect(blocked.manifest.watermark.byteOffset).toBe(firstRecordBytes);
		expect(blocked.manifest.terminal).toBe(false);
	});
});

function buildJsonl(
	count: number,
	recordBytes: number,
	firstOrdinal = 0,
): Buffer {
	const records: Buffer[] = [];
	for (let index = 0; index < count; index += 1) {
		const prefix = `{"ordinal":${String(firstOrdinal + index).padStart(6, "0")},"text":"`;
		const suffix = '"}\n';
		const padding = recordBytes - prefix.length - suffix.length;
		records.push(
			Buffer.from(`${prefix}${"x".repeat(Math.max(0, padding))}${suffix}`),
		);
	}
	return Buffer.concat(records);
}

describe("transcript revision manifest validation", () => {
	// biome-ignore lint/suspicious/noExplicitAny: tests corrupt stored JSON.
	async function planStored(planScope: unknown): Promise<any> {
		const plan = await planTranscriptRevision({
			content: new TextEncoder().encode('{"ordinal":0}\n{"ordinal":1}\n'),
			previous: undefined,
			scope: planScope as TranscriptRevisionScope,
			terminal: false,
		});
		return JSON.parse(JSON.stringify(plan.manifest));
	}

	test("accepts a stored manifest", async () => {
		expect(isTranscriptRevisionManifest(await planStored(scope))).toBe(true);
	});

	test.each([
		["an unknown provider", { ...scope, provider: "cursor" }],
		["a missing session id", { ...scope, sessionId: undefined }],
		["a numeric actor id", { ...scope, actorId: 1 }],
	])(
		"rejects a hash-consistent manifest with %s in the scope",
		async (_name, badScope) => {
			const stored = await planStored(badScope);

			expect(hasValidTranscriptRevisionIntegrity(stored)).toBe(true);
			expect(isTranscriptRevisionManifest(stored)).toBe(false);
		},
	);

	test.each([
		["a chunk without a hash", { sha256: undefined }],
		["a chunk with a string offset", { startByte: "0" }],
	])("rejects a manifest with %s", async (_name, chunkPatch) => {
		const stored = await planStored(scope);
		stored.chunks[0] = { ...stored.chunks[0], ...chunkPatch };

		expect(isTranscriptRevisionManifest(stored)).toBe(false);
	});

	test("rejects a manifest with a malformed watermark", async () => {
		const stored = await planStored(scope);
		stored.watermark = { byteOffset: 0, recordCount: 0 };

		expect(isTranscriptRevisionManifest(stored)).toBe(false);
	});
});
