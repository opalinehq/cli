import { createHash } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import { LIVE_SESSION_MAX_LINE_BYTES } from "../contracts/index.js";
import {
	filterSessionTextFields,
	type RedactionCounts,
} from "../internal/secret-filter/index.js";
import type { TranscriptSlimmer } from "./transcript-slim.js";

/**
 * Raw transcript lines above this size are not buffered: they are sent as an
 * omission marker. Inline images are slimmed away after the read, so a raw
 * line may be much larger than what is finally sent, but a background
 * process must keep a hard memory bound.
 */
export const LIVE_SESSION_MAX_RAW_LINE_BYTES = 8 * 1024 * 1024;
const READ_CHUNK_BYTES = 1024 * 1024;
const NEWLINE = 0x0a;

/**
 * One request's lines may expand when JSON-escaped (control characters become
 * `\u00XX`); requests are also split by this serialized size, and a line that
 * alone exceeds it is omitted.
 */
export const LIVE_SESSION_MAX_WIRE_BYTES = 3_500_000;

export interface LiveSessionLine {
	/** The line exactly as sent (filtered and slimmed, without `\n`). */
	readonly text: string;
	/** UTF-8 bytes of `text`. */
	readonly bytes: number;
	/** UTF-8 bytes of `text` as a JSON string. */
	readonly wireBytes: number;
	readonly sha256: string;
}

export interface ProcessedLiveSessionLine extends LiveSessionLine {
	readonly inputBytes: number;
	readonly redactedBytes: number;
	readonly redactions: RedactionCounts;
}

/** A raw line, or the byte length of a line too large to buffer. */
export type RawLiveSessionLine =
	| { readonly kind: "line"; readonly bytes: Buffer }
	| { readonly kind: "oversized"; readonly byteLength: number };

export function hashLiveSessionLine(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * The deterministic per-line pipeline: known-secret filtering, then the
 * stream's transcript slimming (the order of the session upload). A line that
 * is too large or cannot be filtered safely is replaced by a marker, so the
 * line numbering always matches the local file.
 */
export function processLiveSessionLine(
	raw: RawLiveSessionLine,
	slimmer: TranscriptSlimmer,
): ProcessedLiveSessionLine {
	if (raw.kind === "oversized") return omittedLine("too-large", raw.byteLength);
	const inputBytes = raw.bytes.byteLength;
	let filtered: ReturnType<typeof filterSessionTextFields>;
	try {
		filtered = filterSessionTextFields({
			content: `${raw.bytes.toString("utf8")}\n`,
			subagents: undefined,
		});
	} catch {
		return omittedLine("filter", inputBytes);
	}
	const slimmed = slimmer.slimRecord(filtered.content);
	const text = slimmed.endsWith("\n") ? slimmed.slice(0, -1) : slimmed;
	if (text.includes("\n")) return omittedLine("filter", inputBytes);
	const bytes = Buffer.byteLength(text, "utf8");
	if (bytes > LIVE_SESSION_MAX_LINE_BYTES)
		return omittedLine("too-large", inputBytes);
	const wireBytes = wireLength(text);
	if (wireBytes > LIVE_SESSION_MAX_WIRE_BYTES)
		return omittedLine("too-large", inputBytes);
	return {
		bytes,
		wireBytes,
		inputBytes,
		redactedBytes: filtered.redactedBytes,
		redactions: filtered.counts,
		sha256: hashLiveSessionLine(text),
		text,
	};
}

function omittedLine(
	reason: "filter" | "too-large",
	originalBytes: number,
): ProcessedLiveSessionLine {
	const text = JSON.stringify({
		type: "opaline-live-omitted",
		reason,
		originalBytes,
	});
	return {
		bytes: Buffer.byteLength(text, "utf8"),
		wireBytes: wireLength(text),
		inputBytes: originalBytes,
		redactedBytes: 0,
		redactions: {},
		sha256: hashLiveSessionLine(text),
		text,
	};
}

function wireLength(text: string): number {
	return Buffer.byteLength(JSON.stringify(text), "utf8");
}

export interface ReadLinesResult {
	/** File offset just after the last complete line delivered. */
	readonly endOffset: number;
	/** Number of complete lines delivered. */
	readonly lineCount: number;
	/** True when the read stopped because `onLine` returned false. */
	readonly stopped: boolean;
}

/** A reusable read buffer for `readCompleteLines`. */
export function createLineReadBuffer(): Buffer {
	return Buffer.allocUnsafe(READ_CHUNK_BYTES);
}

/**
 * Reads complete `\n`-terminated lines from `startOffset` up to `endOffset`
 * with bounded memory. An unterminated tail is not delivered; the caller
 * resumes at `endOffset` of the result. `onLine` returns false to stop after
 * the current line. A line's bytes may alias `buffer` and are only valid
 * during the `onLine` call.
 */
export async function readCompleteLines(
	handle: FileHandle,
	startOffset: number,
	endOffset: number,
	onLine: (line: RawLiveSessionLine) => boolean,
	buffer: Buffer = createLineReadBuffer(),
): Promise<ReadLinesResult> {
	let position = startOffset;
	let consumed = startOffset;
	let lineCount = 0;
	// Earlier chunks of a line that spans reads (copied: the buffer is reused).
	let parts: Buffer[] = [];
	let partBytes = 0;
	let oversized = false;
	while (position < endOffset) {
		const { bytesRead } = await handle.read(
			buffer,
			0,
			Math.min(buffer.byteLength, endOffset - position),
			position,
		);
		if (bytesRead === 0) break;
		let start = 0;
		while (start < bytesRead) {
			const newline = buffer.indexOf(NEWLINE, start);
			const complete = newline !== -1 && newline < bytesRead;
			const end = complete ? newline : bytesRead;
			const segment = buffer.subarray(start, end);
			if (partBytes + segment.byteLength > LIVE_SESSION_MAX_RAW_LINE_BYTES) {
				oversized = true;
				parts = [];
			}
			partBytes += segment.byteLength;
			if (!complete) {
				if (!oversized && segment.byteLength > 0)
					parts.push(Buffer.from(segment));
				break;
			}
			const line: RawLiveSessionLine = oversized
				? { byteLength: partBytes, kind: "oversized" }
				: {
						bytes:
							parts.length === 0 ? segment : Buffer.concat([...parts, segment]),
						kind: "line",
					};
			lineCount += 1;
			consumed = position + end + 1;
			parts = [];
			partBytes = 0;
			oversized = false;
			if (!onLine(line))
				return { endOffset: consumed, lineCount, stopped: true };
			start = end + 1;
		}
		position += bytesRead;
	}
	return { endOffset: consumed, lineCount, stopped: false };
}

/**
 * Reads the unterminated tail after `startOffset`, if it is at most the raw
 * line limit. Used once the agent has exited, when the tail is final.
 */
export async function readTail(
	handle: FileHandle,
	startOffset: number,
	endOffset: number,
): Promise<Buffer | undefined> {
	const length = endOffset - startOffset;
	if (length <= 0 || length > LIVE_SESSION_MAX_RAW_LINE_BYTES) return undefined;
	const buffer = Buffer.alloc(length);
	let offset = 0;
	while (offset < length) {
		const { bytesRead } = await handle.read(
			buffer,
			offset,
			length - offset,
			startOffset + offset,
		);
		if (bytesRead === 0) break;
		offset += bytesRead;
	}
	return buffer.subarray(0, offset);
}
