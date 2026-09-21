import { describe, expect, test } from "bun:test";
import {
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
