import { createHash } from "node:crypto";

/**
 * Transcript slimming runs on every Claude Code and Codex record before secret
 * filtering and upload. It removes bytes Opaline never reads while keeping
 * every record, every line and everything its parsers use:
 *
 * 1. Inline images become one marker string that keeps the fact of the image:
 *    `opaline-image-omitted:v1;sha256=<hex of decoded bytes>;bytes=<decoded
 *    length>;type=<media type>`. Covered: Codex `image_url` data URLs (string
 *    or `image_url.url`), the Claude `{ type: "base64", media_type, data }`
 *    source, MCP `{ type: "image", mimeType, data }` content and Claude Read
 *    results `{ type: "image/...", base64 }`, also inside JSON-encoded tool
 *    output. Only strict, padded image base64 is replaced; data URLs in
 *    ordinary text or code stay. The output is byte-identical to the API's
 *    own stripping pass.
 * 2. Codex command completions keep one copy of the output:
 *    `aggregated_output` stays, `stdout` is dropped only when it equals it, and
 *    `formatted_output` is dropped only when it equals it or is Codex's
 *    truncated rendering of it.
 * 3. A Codex `compacted` record drops `replacement_history` or
 *    `guardian_history` only when every item already appears verbatim earlier
 *    in the same stream (or is the summary carried in `message`); an optional
 *    field written as `null` in one copy and omitted in the other still
 *    matches. No Opaline parser reads either field.
 *
 * The result is deterministic and idempotent. Structural edits are applied
 * only when re-serializing the record reproduces its original bytes, so no
 * number or escape outside the removed fields can change; anything that does
 * not parse is passed through untouched.
 */

/** Bump whenever the slimmed bytes for some input change. */
export const TRANSCRIPT_SLIM_VERSION = 1;
export const INLINE_IMAGE_MARKER_PREFIX = "opaline-image-omitted:v1;";

const DATA_URL_PATTERN =
	/^data:(image\/[A-Za-z0-9.+-]+);base64,([A-Za-z0-9+/]+={0,2})$/u;
const STRICT_BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/u;
const IMAGE_MEDIA_TYPE_PATTERN = /^image\/[A-Za-z0-9.+-]+$/u;
const CODEX_TRUNCATED_OUTPUT_HEADER =
	/^Warning: truncated output \(original token count: \d+\)\nTotal output lines: \d+\n\n/u;
const CODEX_TRUNCATION_SEPARATOR = /…\d+ (?:tokens|chars) truncated…/u;
const LINE_TERMINATOR_PATTERN = /\r?\n?$/u;
const COMPACTION_HISTORY_FIELDS = [
	"replacement_history",
	"guardian_history",
] as const;
const MAX_WALK_DEPTH = 128;

export interface TranscriptSlimmer {
	/**
	 * Slims one JSONL record of this stream. A trailing `\n` or `\r\n` is kept
	 * as is. Records must be passed in stream order.
	 */
	readonly slimRecord: (record: string) => string;
}

interface StreamState {
	/** Hashes of items that already appeared verbatim in this stream. */
	readonly presentItems: Set<string>;
}

type JsonRecord = Record<string, unknown>;

export function createTranscriptSlimmer(): TranscriptSlimmer {
	const state: StreamState = { presentItems: new Set() };
	return { slimRecord: (record) => slimRecord(record, state) };
}

/** Slims a whole JSONL stream held in memory. */
export function slimTranscriptText(content: string): string {
	const slimmer = createTranscriptSlimmer();
	return content
		.split("\n")
		.map((line) => slimmer.slimRecord(line))
		.join("\n");
}

export function formatInlineImageMarker(
	payload: Uint8Array,
	mediaType: string,
): string {
	const sha256 = createHash("sha256").update(payload).digest("hex");
	return `${INLINE_IMAGE_MARKER_PREFIX}sha256=${sha256};bytes=${payload.byteLength};type=${mediaType}`;
}

function slimRecord(record: string, state: StreamState): string {
	const terminator = LINE_TERMINATOR_PATTERN.exec(record)?.[0] ?? "";
	const body = record.slice(0, record.length - terminator.length);
	let text = stripInlineImagesFromLine(body);
	const parsed = mayNeedStructuralSlimming(text)
		? parseRecord(text)
		: undefined;
	const removals = parsed ? planStructuralRemovals(parsed, state) : [];
	if (parsed && removals.length > 0 && JSON.stringify(parsed) === text) {
		for (const { holder, key } of removals) delete holder[key];
		text = JSON.stringify(parsed);
	}
	return text === body ? record : `${text}${terminator}`;
}

function mayNeedStructuralSlimming(text: string): boolean {
	return (
		text.includes("response_item") ||
		text.includes("CommandExecution") ||
		text.includes("exec_command_end") ||
		text.includes("compacted")
	);
}

// Images ---------------------------------------------------------------------
//
// A port of the API's `stripInlineImages` (`@rudel/api-routes/inline-images`):
// identical input lines must produce identical bytes, so the API's own pass is
// a no-op on CLI-slimmed uploads. Keep the two in lockstep.

interface ImageReplacements {
	/** Whole data URLs, replaced before bare payloads that they may contain. */
	readonly dataUrls: Map<string, string>;
	readonly payloads: Map<string, string>;
}

/**
 * Replaces inline base64 image payloads in one JSONL line. Payloads are found
 * by parsing the line (including JSON-encoded tool-output strings) and swapped
 * textually in the raw line, so every other byte stays as it was. Lines that
 * do not parse, or would not parse afterwards, are returned unchanged.
 */
export function stripInlineImagesFromLine(line: string): string {
	if (!mayContainInlineImage(line)) return line;
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return line;
	}
	const replacements: ImageReplacements = {
		dataUrls: new Map(),
		payloads: new Map(),
	};
	collectImageReplacements(parsed, replacements, 0);
	let text = line;
	for (const group of [replacements.dataUrls, replacements.payloads]) {
		for (const [payload, marker] of group) {
			text = replaceDelimitedOccurrences(text, payload, marker);
		}
	}
	if (text === line) return line;
	try {
		JSON.parse(text);
	} catch {
		return line;
	}
	return text;
}

function collectImageReplacements(
	value: unknown,
	replacements: ImageReplacements,
	depth: number,
): void {
	if (depth > MAX_WALK_DEPTH) return;
	if (typeof value === "string") {
		collectFromEncodedJson(value, replacements, depth);
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) {
			collectImageReplacements(item, replacements, depth + 1);
		}
		return;
	}
	if (!isRecord(value)) return;
	collectFromImageRecord(value, replacements);
	for (const child of Object.values(value)) {
		collectImageReplacements(child, replacements, depth + 1);
	}
}

function collectFromImageRecord(
	record: JsonRecord,
	replacements: ImageReplacements,
): void {
	const imageUrl = record.image_url;
	if (typeof imageUrl === "string") {
		addDataUrl(imageUrl, replacements);
	} else if (isRecord(imageUrl) && typeof imageUrl.url === "string") {
		addDataUrl(imageUrl.url, replacements);
	}
	if (record.type === "base64") {
		addImagePayload(record.data, record.media_type, replacements);
	}
	if (record.type === "image") {
		addImagePayload(record.data, record.mimeType, replacements);
	}
	addImagePayload(record.base64, record.type, replacements);
}

/** Tool outputs often carry JSON (with image blocks) encoded in a string. */
function collectFromEncodedJson(
	value: string,
	replacements: ImageReplacements,
	depth: number,
): void {
	if (!mayContainInlineImage(value)) return;
	const trimmed = value.trimStart();
	if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return;
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		return;
	}
	collectImageReplacements(parsed, replacements, depth + 1);
}

function addDataUrl(value: string, replacements: ImageReplacements): void {
	if (replacements.dataUrls.has(value)) return;
	const match = DATA_URL_PATTERN.exec(value);
	const mediaType = match?.[1];
	const payload = match?.[2];
	if (!mediaType || !payload || payload.length % 4 !== 0) return;
	replacements.dataUrls.set(value, createImageMarker(payload, mediaType));
}

function addImagePayload(
	payload: unknown,
	mediaType: unknown,
	replacements: ImageReplacements,
): void {
	if (
		typeof payload !== "string" ||
		typeof mediaType !== "string" ||
		replacements.payloads.has(payload) ||
		payload.length % 4 !== 0 ||
		!IMAGE_MEDIA_TYPE_PATTERN.test(mediaType) ||
		!STRICT_BASE64_PATTERN.test(payload)
	) {
		return;
	}
	replacements.payloads.set(payload, createImageMarker(payload, mediaType));
}

function createImageMarker(payload: string, mediaType: string): string {
	return formatInlineImageMarker(Buffer.from(payload, "base64"), mediaType);
}

/**
 * Replaces occurrences of `payload` that are not part of a longer base64 run,
 * wherever they appear in the raw line, including inside JSON-encoded strings.
 */
function replaceDelimitedOccurrences(
	text: string,
	payload: string,
	marker: string,
): string {
	const pieces: string[] = [];
	let cursor = 0;
	let index = text.indexOf(payload);
	while (index !== -1) {
		const end = index + payload.length;
		if (
			!isBase64Character(text.charCodeAt(index - 1)) &&
			!isBase64Character(text.charCodeAt(end))
		) {
			pieces.push(text.slice(cursor, index), marker);
			cursor = end;
			index = text.indexOf(payload, end);
		} else {
			index = text.indexOf(payload, index + 1);
		}
	}
	if (pieces.length === 0) return text;
	pieces.push(text.slice(cursor));
	return pieces.join("");
}

function isBase64Character(code: number): boolean {
	return (
		(code >= 0x41 && code <= 0x5a) ||
		(code >= 0x61 && code <= 0x7a) ||
		(code >= 0x30 && code <= 0x39) ||
		code === 0x2b ||
		code === 0x2f ||
		code === 0x3d
	);
}

function mayContainInlineImage(text: string): boolean {
	return text.includes("base64") || text.includes("mimeType");
}

// Structural removals ----------------------------------------------------------

interface Removal {
	readonly holder: JsonRecord;
	readonly key: string;
}

function planStructuralRemovals(
	record: JsonRecord,
	state: StreamState,
): readonly Removal[] {
	const payload = isRecord(record.payload) ? record.payload : undefined;
	if (record.type === "response_item") {
		if (payload) state.presentItems.add(hashJson(payload));
		return [];
	}
	if (record.type === "event_msg" && payload) {
		return planCommandOutputRemovals(payload);
	}
	if (record.type === "compacted" && payload) {
		return planCompactionRemovals(payload, state);
	}
	return [];
}

/**
 * Codex records each command's output up to three times. For commands run
 * inside code-mode scripts these events are the only record, so the
 * `aggregated_output` copy always stays.
 */
function planCommandOutputRemovals(payload: JsonRecord): readonly Removal[] {
	const holder =
		payload.type === "exec_command_end"
			? payload
			: isRecord(payload.item) && payload.item.type === "CommandExecution"
				? payload.item
				: undefined;
	const aggregated = holder?.aggregated_output;
	if (!holder || typeof aggregated !== "string") return [];
	const removals: Removal[] = [];
	if (holder.stdout === aggregated) removals.push({ holder, key: "stdout" });
	if (
		typeof holder.formatted_output === "string" &&
		isDerivedFormattedOutput(holder.formatted_output, aggregated)
	) {
		removals.push({ holder, key: "formatted_output" });
	}
	return removals;
}

/**
 * `formatted_output` is either the aggregated output itself or Codex's
 * truncated rendering: a token-count header, then head and tail excerpts of
 * the aggregated output around `…N chars truncated…` separators.
 */
function isDerivedFormattedOutput(
	formatted: string,
	aggregated: string,
): boolean {
	if (formatted === aggregated) return true;
	const header = CODEX_TRUNCATED_OUTPUT_HEADER.exec(formatted);
	if (!header) return false;
	return formatted
		.slice(header[0].length)
		.split(CODEX_TRUNCATION_SEPARATOR)
		.every((excerpt) => aggregated.includes(excerpt));
}

function planCompactionRemovals(
	payload: JsonRecord,
	state: StreamState,
): readonly Removal[] {
	const removals: Removal[] = [];
	const retainedItems: string[] = [];
	for (const key of COMPACTION_HISTORY_FIELDS) {
		const history = payload[key];
		if (!Array.isArray(history) || history.length === 0) continue;
		const hashes = history.map(hashJson);
		const isDuplicate = history.every(
			(item, index) =>
				state.presentItems.has(hashes[index] ?? "") ||
				isCarriedSummary(item, payload.message),
		);
		if (isDuplicate) removals.push({ holder: payload, key });
		else retainedItems.push(...hashes);
	}
	// Retained history is itself part of the stream that later compactions
	// replay. Registering it only after both checks keeps each decision about
	// earlier records alone.
	for (const hash of retainedItems) state.presentItems.add(hash);
	return removals;
}

function isCarriedSummary(item: unknown, message: unknown): boolean {
	if (typeof message !== "string" || message.trim() === "") return false;
	if (!isRecord(item) || item.type !== "message") return false;
	if (!Array.isArray(item.content)) return false;
	const text = item.content
		.map((block) =>
			isRecord(block) && typeof block.text === "string" ? block.text : "",
		)
		.join("");
	return text === message;
}

// Utilities --------------------------------------------------------------------

function parseRecord(text: string): JsonRecord | undefined {
	try {
		const parsed: unknown = JSON.parse(text);
		return isRecord(parsed) && !Array.isArray(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Identity of a history item. Codex writes an unset optional field as `null`
 * in one copy and omits it in the other, so null-valued properties do not
 * count; every other value must match exactly.
 */
function hashJson(value: unknown): string {
	return createHash("sha256")
		.update(JSON.stringify(value, omitNullProperty))
		.digest("base64");
}

function omitNullProperty(
	this: unknown,
	_key: string,
	value: unknown,
): unknown {
	return value === null && !Array.isArray(this) ? undefined : value;
}

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null;
}
