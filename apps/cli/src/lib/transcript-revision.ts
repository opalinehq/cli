import { createHash } from "node:crypto";

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

export interface TranscriptRevisionPlan {
	readonly manifest: TranscriptRevisionManifest;
	readonly newChunks: readonly PlannedTranscriptChunk[];
	readonly resetReason: TranscriptResetReason | null;
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
	readonly scope: TranscriptRevisionScope;
	readonly terminal: boolean;
}): Promise<TranscriptRevisionPlan> {
	const resetReason = getResetReason(input);
	const previous = resetReason === null ? input.previous : undefined;
	const startByte = previous?.watermark.byteOffset ?? 0;
	const accepted = describeAcceptedTranscriptPrefix(
		input.content,
		input.terminal,
	);
	const endByte = Math.max(startByte, accepted.bytes.byteLength);
	const appendedBytes = input.content.slice(startByte, endByte);
	const newChunks =
		appendedBytes.byteLength === 0
			? []
			: [createChunk(appendedBytes, startByte, endByte)];
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
	const terminal = input.terminal && accepted.acceptedTerminalSuffix;
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

export function describeAcceptedTranscriptPrefix(
	content: Uint8Array,
	terminal: boolean,
): AcceptedTranscriptPrefix {
	const stable = findStableJsonlEnd(content, terminal);
	const bytes = content.subarray(0, stable.byteOffset);
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

function createChunk(
	bytes: Uint8Array,
	startByte: number,
	endByte: number,
): PlannedTranscriptChunk {
	return {
		bytes,
		endByte,
		recordCount: readJsonlProgress(bytes).recordCount,
		sha256: sha256(bytes),
		startByte,
	};
}

function readJsonlProgress(bytes: Uint8Array) {
	const text = new TextDecoder().decode(bytes);
	let lastOrdinal: number | undefined;
	let recordCount = 0;
	for (const line of text.split("\n")) {
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
