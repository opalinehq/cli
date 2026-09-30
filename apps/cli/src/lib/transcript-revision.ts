import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import {
	REPOSITORY_EVIDENCE_MAX_AGGREGATE_BYTES,
	REPOSITORY_EVIDENCE_MAX_OBJECT_BYTES,
} from "../contracts/index.js";

export const TRANSCRIPT_MAX_CHUNK_BYTES = REPOSITORY_EVIDENCE_MAX_OBJECT_BYTES;
export const TRANSCRIPT_MAX_DELIVERY_BYTES =
	REPOSITORY_EVIDENCE_MAX_AGGREGATE_BYTES;

export interface TranscriptRevisionScope {
	readonly actorId: string;
	readonly provider: "claude_code" | "codex";
	readonly providerInstanceId: string;
	readonly sessionId: string;
}

export interface TranscriptChunkReference {
	readonly endByte: number;
	readonly recordCount: number;
	readonly sha256: string;
	readonly startByte: number;
}

export interface TranscriptWatermark {
	readonly byteOffset: number;
	readonly lastOrdinal: number | undefined;
	readonly prefixSha256: string;
	readonly recordCount: number;
}

export interface TranscriptRevisionManifest {
	readonly chunks: readonly TranscriptChunkReference[];
	readonly generation: number;
	readonly parentRevisionId: string | undefined;
	readonly revisionId: string;
	readonly scope: TranscriptRevisionScope;
	readonly terminal: boolean;
	readonly version: 1;
	readonly watermark: TranscriptWatermark;
}

export interface PlannedTranscriptChunk extends TranscriptChunkReference {
	readonly bytes: Uint8Array;
}

export type TranscriptResetReason =
	| "prefix-mismatch"
	| "scope-changed"
	| "source-shrank";

export type TranscriptDeliveryState =
	| { readonly status: "complete" }
	| { readonly status: "deferred"; readonly remainingBytes: number }
	| {
			readonly status: "blocked";
			readonly recordStartByte: number;
			readonly recordBytes: number;
	  };

export interface TranscriptRevisionPlan {
	readonly delivery: TranscriptDeliveryState;
	readonly manifest: TranscriptRevisionManifest;
	readonly newChunks: readonly PlannedTranscriptChunk[];
	readonly resetReason: TranscriptResetReason | null;
}

export interface TranscriptRevisionLimits {
	readonly maxChunkBytes: number;
	readonly maxDeliveryBytes: number;
}

export interface AcceptedTranscriptPrefix {
	readonly acceptedTerminalSuffix: boolean;
	readonly bytes: Uint8Array;
	readonly lastOrdinal: number | null;
	readonly prefixSha256: string;
	readonly recordCount: number;
}

export function hasValidTranscriptRevisionIntegrity(
	manifest: TranscriptRevisionManifest,
): boolean {
	return (
		manifest.revisionId ===
		hashRevision({
			chunks: manifest.chunks,
			generation: manifest.generation,
			parentRevisionId: manifest.parentRevisionId,
			scope: manifest.scope,
			terminal: manifest.terminal,
			watermark: manifest.watermark,
		})
	);
}

export async function planTranscriptRevision(input: {
	readonly content: Uint8Array;
	readonly previous: TranscriptRevisionManifest | undefined;
	readonly limits?: Partial<TranscriptRevisionLimits>;
	readonly scope: TranscriptRevisionScope;
	readonly terminal: boolean;
}): Promise<TranscriptRevisionPlan> {
	const limits: TranscriptRevisionLimits = {
		maxChunkBytes: input.limits?.maxChunkBytes ?? TRANSCRIPT_MAX_CHUNK_BYTES,
		maxDeliveryBytes:
			input.limits?.maxDeliveryBytes ?? TRANSCRIPT_MAX_DELIVERY_BYTES,
	};
	const resetReason = getResetReason(input);
	const previous = resetReason === null ? input.previous : undefined;
	const startByte = previous?.watermark.byteOffset ?? 0;
	const stable = findStableJsonlEnd(input.content, input.terminal);
	const stableEnd = Math.max(startByte, stable.byteOffset);
	const deliverable = findDeliverableEnd(
		input.content,
		startByte,
		stableEnd,
		Math.max(0, limits.maxDeliveryBytes),
	);
	const endByte = deliverable.endByte;
	const appendedBytes = input.content.subarray(startByte, endByte);
	const newChunks = splitIntoChunks(
		input.content,
		startByte,
		endByte,
		limits.maxChunkBytes,
	);
	const newChunkReferences = newChunks.map((chunk) => ({
		endByte: chunk.endByte,
		recordCount: chunk.recordCount,
		sha256: chunk.sha256,
		startByte: chunk.startByte,
	}));
	const chunks = [...(previous?.chunks ?? []), ...newChunkReferences];
	const appendedRecords = readJsonlProgress(appendedBytes);
	const watermark: TranscriptWatermark = {
		byteOffset: endByte,
		lastOrdinal: appendedRecords.lastOrdinal ?? previous?.watermark.lastOrdinal,
		prefixSha256: sha256(input.content.subarray(0, endByte)),
		recordCount:
			(previous?.watermark.recordCount ?? 0) + appendedRecords.recordCount,
	};
	const generation = resetReason
		? (input.previous?.generation ?? 0) + 1
		: (previous?.generation ?? 0);
	const terminal =
		input.terminal && stable.acceptedTerminalSuffix && endByte === stableEnd;
	const parentRevisionId = previous?.revisionId;
	const revisionId = hashRevision({
		chunks,
		generation,
		parentRevisionId,
		scope: input.scope,
		terminal,
		watermark,
	});

	return {
		delivery: getDeliveryState(input.content, startByte, endByte, stableEnd),
		manifest: {
			chunks,
			generation,
			parentRevisionId,
			revisionId,
			scope: input.scope,
			terminal,
			version: 1,
			watermark,
		},
		newChunks,
		resetReason,
	};
}

export async function planTranscriptRevisionFile(input: {
	readonly path: string;
	readonly previous: TranscriptRevisionManifest | undefined;
	readonly limits?: Partial<TranscriptRevisionLimits>;
	readonly scope: TranscriptRevisionScope;
	readonly terminal: boolean;
}): Promise<TranscriptRevisionPlan> {
	const file = await open(input.path, "r");
	try {
		const size = (await file.stat()).size;
		const budget = Math.max(
			0,
			input.limits?.maxDeliveryBytes ?? TRANSCRIPT_MAX_DELIVERY_BYTES,
		);
		const prefix = createHash("sha256");
		const window = new Uint8Array(1024 * 1024);
		let stableEnd = 0;
		let offset = 0;
		while (offset < size) {
			const { bytesRead } = await file.read(
				window,
				0,
				Math.min(window.length, size - offset),
				offset,
			);
			if (!bytesRead)
				throw new Error("Transcript source changed during planning");
			const bytes = window.subarray(0, bytesRead);
			const newline = bytes.lastIndexOf(0x0a);
			if (newline >= 0) stableEnd = offset + newline + 1;
			const prefixBytes = Math.min(
				bytesRead,
				Math.max(0, (input.previous?.watermark.byteOffset ?? 0) - offset),
			);
			prefix.update(bytes.subarray(0, prefixBytes));
			offset += bytesRead;
		}
		const resetReason = !input.previous
			? null
			: !sameScope(input.previous.scope, input.scope)
				? "scope-changed"
				: size < input.previous.watermark.byteOffset
					? "source-shrank"
					: prefix.digest("hex") !== input.previous.watermark.prefixSha256
						? "prefix-mismatch"
						: null;
		const previous = resetReason === null ? input.previous : undefined;
		const startByte = previous?.watermark.byteOffset ?? 0;
		stableEnd = Math.max(startByte, stableEnd);
		let terminalSuffix = input.terminal && stableEnd === size;
		if (input.terminal && size - stableEnd > budget) stableEnd = size;
		if (input.terminal && size - stableEnd <= budget && stableEnd !== size) {
			const suffix = new Uint8Array(size - stableEnd);
			await file.read(suffix, 0, suffix.length, stableEnd);
			if (isCompleteJson(suffix)) {
				stableEnd = size;
				terminalSuffix = true;
			}
		}
		const bytes = new Uint8Array(
			Math.min(budget, Math.max(0, stableEnd - startByte)),
		);
		let read = 0;
		while (read < bytes.length) {
			const result = await file.read(
				bytes,
				read,
				Math.min(window.length, bytes.length - read),
				startByte + read,
			);
			if (!result.bytesRead)
				throw new Error("Transcript source changed during planning");
			read += result.bytesRead;
		}
		const end =
			stableEnd - startByte <= budget
				? bytes.length
				: Math.max(0, bytes.lastIndexOf(0x0a) + 1);
		const local = await planTranscriptRevision({
			content: bytes.slice(0, end),
			previous: undefined,
			limits: input.limits,
			scope: input.scope,
			terminal: terminalSuffix && startByte + end === stableEnd,
		});
		const newChunks = local.newChunks.map((chunk) => ({
			...chunk,
			startByte: chunk.startByte + startByte,
			endByte: chunk.endByte + startByte,
		}));
		const chunks = [
			...(previous?.chunks ?? []),
			...newChunks.map(({ bytes: _bytes, ...reference }) => reference),
		];
		const endByte = startByte + end;
		const hash = createHash("sha256");
		for (let cursor = 0; cursor < endByte; ) {
			const { bytesRead } = await file.read(
				window,
				0,
				Math.min(window.length, endByte - cursor),
				cursor,
			);
			if (!bytesRead)
				throw new Error("Transcript source changed during planning");
			hash.update(window.subarray(0, bytesRead));
			cursor += bytesRead;
		}
		const watermark = {
			...local.manifest.watermark,
			byteOffset: endByte,
			prefixSha256: hash.digest("hex"),
			recordCount:
				(previous?.watermark.recordCount ?? 0) +
				local.manifest.watermark.recordCount,
			lastOrdinal:
				local.manifest.watermark.lastOrdinal ?? previous?.watermark.lastOrdinal,
		};
		const generation = resetReason
			? (input.previous?.generation ?? 0) + 1
			: (previous?.generation ?? 0);
		const terminal = local.manifest.terminal;
		const parentRevisionId = previous?.revisionId;
		return {
			delivery:
				endByte === stableEnd
					? { status: "complete" }
					: end > 0
						? { status: "deferred", remainingBytes: stableEnd - endByte }
						: {
								status: "blocked",
								recordStartByte: startByte,
								recordBytes: Math.max(bytes.length + 1, stableEnd - startByte),
							},
			manifest: {
				chunks,
				generation,
				parentRevisionId,
				revisionId: hashRevision({
					chunks,
					generation,
					parentRevisionId,
					scope: input.scope,
					terminal,
					watermark,
				}),
				scope: input.scope,
				terminal,
				version: 1,
				watermark,
			},
			newChunks,
			resetReason,
		};
	} finally {
		await file.close();
	}
}

export function describeAcceptedTranscriptPrefix(
	content: Uint8Array,
	terminal: boolean,
): AcceptedTranscriptPrefix {
	const stable = findStableJsonlEnd(content, terminal);
	const bytes = content.slice(0, stable.byteOffset);
	const progress = readJsonlProgress(bytes);
	return {
		acceptedTerminalSuffix: stable.acceptedTerminalSuffix,
		bytes,
		lastOrdinal: progress.lastOrdinal ?? null,
		prefixSha256: sha256(bytes),
		recordCount: progress.recordCount,
	};
}

function getResetReason(input: {
	readonly content: Uint8Array;
	readonly previous: TranscriptRevisionManifest | undefined;
	readonly scope: TranscriptRevisionScope;
}): TranscriptResetReason | null {
	const { previous } = input;
	if (!previous) {
		return null;
	}
	if (!sameScope(previous.scope, input.scope)) {
		return "scope-changed";
	}
	if (input.content.byteLength < previous.watermark.byteOffset) {
		return "source-shrank";
	}
	const currentPrefix = input.content.subarray(
		0,
		previous.watermark.byteOffset,
	);
	return sha256(currentPrefix) === previous.watermark.prefixSha256
		? null
		: "prefix-mismatch";
}

function sameScope(
	left: TranscriptRevisionScope,
	right: TranscriptRevisionScope,
) {
	return (
		left.actorId === right.actorId &&
		left.provider === right.provider &&
		left.providerInstanceId === right.providerInstanceId &&
		left.sessionId === right.sessionId
	);
}

function findStableJsonlEnd(content: Uint8Array, terminal: boolean) {
	let byteOffset = 0;
	for (let index = content.byteLength - 1; index >= 0; index--) {
		if (content[index] === 0x0a) {
			byteOffset = index + 1;
			break;
		}
	}
	if (byteOffset === content.byteLength) {
		return { acceptedTerminalSuffix: terminal, byteOffset };
	}
	if (!terminal || !isCompleteJson(content.subarray(byteOffset))) {
		return { acceptedTerminalSuffix: false, byteOffset };
	}
	return { acceptedTerminalSuffix: true, byteOffset: content.byteLength };
}

function isCompleteJson(bytes: Uint8Array) {
	if (bytes.byteLength === 0) {
		return true;
	}
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return false;
	}
	try {
		JSON.parse(text);
		return true;
	} catch {
		return false;
	}
}

function findDeliverableEnd(
	content: Uint8Array,
	startByte: number,
	stableEnd: number,
	maxDeliveryBytes: number,
): { readonly endByte: number } {
	if (stableEnd - startByte <= maxDeliveryBytes) return { endByte: stableEnd };
	const limit = startByte + maxDeliveryBytes;
	if (limit <= startByte) return { endByte: startByte };
	const lastNewline = content.lastIndexOf(0x0a, limit - 1);
	return { endByte: lastNewline >= startByte ? lastNewline + 1 : startByte };
}

function getDeliveryState(
	content: Uint8Array,
	startByte: number,
	endByte: number,
	stableEnd: number,
): TranscriptDeliveryState {
	if (endByte === stableEnd) return { status: "complete" };
	if (endByte > startByte) {
		return { status: "deferred", remainingBytes: stableEnd - endByte };
	}
	const nextNewline = content.indexOf(0x0a, startByte);
	const recordEnd =
		nextNewline < 0 || nextNewline >= stableEnd ? stableEnd : nextNewline + 1;
	return {
		status: "blocked",
		recordBytes: recordEnd - startByte,
		recordStartByte: startByte,
	};
}

function splitIntoChunks(
	content: Uint8Array,
	startByte: number,
	endByte: number,
	maxChunkBytes: number,
): readonly PlannedTranscriptChunk[] {
	const chunks: PlannedTranscriptChunk[] = [];
	let cursor = startByte;
	while (cursor < endByte) {
		const hardEnd = Math.min(cursor + maxChunkBytes, endByte);
		let chunkEnd = hardEnd;
		if (hardEnd < endByte) {
			const lastNewline = content.lastIndexOf(0x0a, hardEnd - 1);
			if (lastNewline >= cursor) chunkEnd = lastNewline + 1;
		}
		chunks.push(createChunk(content, cursor, chunkEnd));
		cursor = chunkEnd;
	}
	return chunks;
}

function createChunk(
	content: Uint8Array,
	startByte: number,
	endByte: number,
): PlannedTranscriptChunk {
	const bytes = content.slice(startByte, endByte);
	const continuation = startByte > 0 && content[startByte - 1] !== 0x0a;
	return {
		bytes,
		endByte,
		recordCount: countRecordStarts(bytes, continuation),
		sha256: sha256(bytes),
		startByte,
	};
}

function countRecordStarts(bytes: Uint8Array, continuation: boolean): number {
	let records = 0;
	let cursor = continuation ? bytes.indexOf(0x0a) + 1 : 0;
	if (continuation && cursor === 0) return 0;
	while (cursor < bytes.length) {
		const newline = bytes.indexOf(0x0a, cursor);
		const end = newline < 0 ? bytes.length : newline + 1;
		if (new TextDecoder().decode(bytes.subarray(cursor, end)).trim()) records++;
		cursor = end;
	}
	return records;
}

function readJsonlProgress(bytes: Uint8Array) {
	let lastOrdinal: number | undefined;
	let recordCount = 0;
	for (let cursor = 0; cursor < bytes.length; ) {
		const newline = bytes.indexOf(0x0a, cursor);
		const end = newline < 0 ? bytes.length : newline + 1;
		const line = new TextDecoder().decode(bytes.subarray(cursor, end));
		cursor = end;
		if (!line.trim()) {
			continue;
		}
		recordCount += 1;
		try {
			const value: unknown = JSON.parse(line);
			if (
				typeof value === "object" &&
				value !== null &&
				"ordinal" in value &&
				typeof value.ordinal === "number" &&
				Number.isSafeInteger(value.ordinal)
			) {
				lastOrdinal = value.ordinal;
			}
		} catch {
			// Newline-delimited malformed records remain raw evidence, but do not
			// contribute an ordinal to the verified byte watermark.
		}
	}
	return { lastOrdinal, recordCount };
}

function hashRevision(input: {
	readonly chunks: readonly TranscriptChunkReference[];
	readonly generation: number;
	readonly parentRevisionId: string | undefined;
	readonly scope: TranscriptRevisionScope;
	readonly terminal: boolean;
	readonly watermark: TranscriptWatermark;
}) {
	return sha256(
		new TextEncoder().encode(
			JSON.stringify({
				chunks: input.chunks,
				generation: input.generation,
				parentRevisionId: input.parentRevisionId ?? null,
				scope: input.scope,
				terminal: input.terminal,
				version: 1,
				watermark: input.watermark,
			}),
		),
	);
}

function sha256(bytes: Uint8Array) {
	return createHash("sha256").update(bytes).digest("hex");
}
