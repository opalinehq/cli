import { GENERATED_SECRET_RULES } from "./generated-rules.js";
import type {
	FilterableSubagent,
	RedactionBudgetAnomaly,
	RedactionCounts,
	SecretFilterResult,
	SecretRule,
	SessionTextFilterResult,
} from "./types.js";

export interface CompiledSecretRule {
	readonly definition: SecretRule;
	readonly matcher: RegExp;
	readonly allowlistMatchers: readonly RegExp[];
	/** Matches text that contains one of the rule's keywords. */
	readonly keywordMatcher?: RegExp;
}

type SecretRedactor = (ruleId: string, original: string) => string;

const COMPILED_SECRET_RULES = GENERATED_SECRET_RULES.map(compileSecretRule);
const UTF8_ENCODER = new TextEncoder();

export const FILTER_VERSION = 7;
export const MAX_FILTER_PASSES = 4;
export const OVERLONG_MATCH_THRESHOLD_BYTES = 8192;
export const MAX_REDACTION_RATIO = 0.2;
export const OVERLONG_REDACTION_RULE_ID = "overlong-match";
export const SECRET_FILTER_CONVERGENCE_MESSAGE =
	"Known-pattern redaction did not converge within the safety limit.";
export const FILTERED_TRANSCRIPT_PATHS: readonly string[] = [
	"content",
	"subagents[].content",
];

export class SecretFilterConvergenceError extends Error {
	readonly maxPasses: number;

	constructor(maxPasses = MAX_FILTER_PASSES) {
		super(SECRET_FILTER_CONVERGENCE_MESSAGE);
		this.name = "SecretFilterConvergenceError";
		this.maxPasses = maxPasses;
	}
}

export class SecretFilterJsonIntegrityError extends Error {
	constructor() {
		super(
			"Secret filtering changed valid JSON transcript text into invalid JSON.",
		);
		this.name = "SecretFilterJsonIntegrityError";
	}
}

export function filterKnownSecrets(
	text: string,
	redactSecret?: SecretRedactor,
): SecretFilterResult {
	return filterKnownSecretsWithCompiledRules(
		text,
		COMPILED_SECRET_RULES,
		redactSecret,
	);
}

export function filterKnownSecretsWithCompiledRules(
	text: string,
	rules: readonly CompiledSecretRule[],
	redactSecret?: SecretRedactor,
): SecretFilterResult {
	let filteredText = text;
	let counts: RedactionCounts = {};
	let redactedBytes = 0;

	// Redacting one secret can expose another. Rules are folded in array order
	// over already-filtered text, and eight of them are anchored on a leading
	// \b. When two secrets are concatenated with no delimiter, the leading one
	// has no word boundary to match against -- until a later rule replaces its
	// neighbour with a marker whose brackets supply that boundary. By then the
	// earlier rule has already run.
	//
	// Re-running until a pass redacts nothing makes one call equivalent to
	// repeated calls. That matters because the number of passes a transcript
	// gets is not fixed: a current CLI filters client-side and the API filters
	// again, but an older CLI uploads raw text and gets exactly one server-side
	// pass. Without this loop those two paths store different bytes.
	for (let pass = 0; pass < MAX_FILTER_PASSES; pass += 1) {
		const passResult = applyCompiledSecretRules(
			filteredText,
			rules,
			redactSecret,
		);
		// A clean pass means the text is a fixpoint; nothing was rewritten, so
		// there is nothing to merge.
		if (getRedactionCount(passResult.counts) === 0) {
			return { text: filteredText, counts, redactedBytes };
		}

		// Markers never re-match, so each pass redacts a disjoint set of the
		// original bytes and these totals cannot double-count.
		filteredText = passResult.text;
		counts = mergeRedactionCounts(counts, passResult.counts);
		redactedBytes += passResult.redactedBytes;
	}

	// Four changing passes are allowed, but their output is not trusted until a
	// clean pass confirms that it is a fixpoint. Never return partially filtered
	// text when the bounded loop cannot establish that invariant.
	const confirmation = applyCompiledSecretRules(
		filteredText,
		rules,
		redactSecret,
	);
	if (getRedactionCount(confirmation.counts) > 0) {
		throw new SecretFilterConvergenceError();
	}

	return { text: filteredText, counts, redactedBytes };
}

export function filterSessionTextFields<
	TSubagent extends FilterableSubagent,
>(fields: {
	readonly content: string;
	readonly subagents: readonly TSubagent[] | undefined;
}): SessionTextFilterResult<TSubagent> {
	const contentResult = filterKnownSecretsPreservingJson(fields.content);
	let counts = contentResult.counts;
	let redactedBytes = contentResult.redactedBytes;
	const subagents = fields.subagents?.map((subagent) => {
		const result = filterKnownSecretsPreservingJson(subagent.content);
		counts = mergeRedactionCounts(counts, result.counts);
		redactedBytes += result.redactedBytes;
		return { ...subagent, content: result.text };
	});

	return {
		content: contentResult.text,
		subagents,
		counts,
		redactedBytes,
	};
}

function filterKnownSecretsPreservingJson(text: string) {
	const result = filterKnownSecrets(text);
	assertFilteredJsonValidity(text, result.text);
	return result;
}

export function assertFilteredJsonValidity(input: string, output: string) {
	const inputMode = getJsonValidationMode(input);

	if (inputMode === "unchecked") {
		return;
	}

	if (inputMode === "document") {
		if (!isValidJson(output)) {
			throw new SecretFilterJsonIntegrityError();
		}
		return;
	}

	const inputLines = getNonEmptyLines(input);
	const outputLines = getNonEmptyLines(output);
	if (
		inputLines.length !== outputLines.length ||
		outputLines.some((line) => !isValidJson(line))
	) {
		throw new SecretFilterJsonIntegrityError();
	}
}

function getJsonValidationMode(
	text: string,
): "document" | "jsonl" | "unchecked" {
	if (isValidJson(text)) {
		return "document";
	}

	const lines = getNonEmptyLines(text);
	return lines.length > 0 && lines.every(isValidJson) ? "jsonl" : "unchecked";
}

function getNonEmptyLines(text: string) {
	return text.split("\n").filter((line) => line.trim().length > 0);
}

function isValidJson(text: string) {
	try {
		JSON.parse(text);
		return true;
	} catch {
		return false;
	}
}

export function mergeRedactionCounts(
	...countSets: readonly RedactionCounts[]
): RedactionCounts {
	const merged: Record<string, number> = {};
	for (const counts of countSets) {
		for (const [ruleId, count] of Object.entries(counts)) {
			merged[ruleId] = (merged[ruleId] ?? 0) + count;
		}
	}
	return merged;
}

export function getRedactionCount(counts: RedactionCounts): number {
	return Object.values(counts).reduce((total, count) => total + count, 0);
}

export function getUtf8ByteLength(text: string): number {
	return UTF8_ENCODER.encode(text).byteLength;
}

export function getRedactionBudgetAnomaly(
	redactedBytes: number,
	inputBytes: number,
	counts: RedactionCounts,
): RedactionBudgetAnomaly | null {
	if (
		inputBytes <= 0 ||
		redactedBytes <= 0 ||
		redactedBytes <= inputBytes * MAX_REDACTION_RATIO
	) {
		return null;
	}

	return {
		inputBytes,
		redactedBytes,
		ruleIds: Object.entries(counts)
			.filter(([, count]) => count > 0)
			.map(([ruleId]) => ruleId)
			.sort(),
	};
}

export function compileSecretRule(rule: SecretRule): CompiledSecretRule {
	const matcherFlags = rule.caseInsensitive ? "dgiu" : "dgu";
	const allowlistFlags = rule.caseInsensitive ? "iu" : "u";
	return {
		definition: rule,
		matcher: new RegExp(rule.regexSource, matcherFlags),
		allowlistMatchers: rule.allowlistRegexSources.map(
			(source) => new RegExp(source, allowlistFlags),
		),
		...(rule.keywords && rule.keywords.length > 0
			? {
					keywordMatcher: new RegExp(
						rule.keywords.map(escapeRegExpLiteral).join("|"),
						"iu",
					),
				}
			: {}),
	};
}

function escapeRegExpLiteral(text: string): string {
	return text.replace(/[\\^$.*+?()[\]{}|/]/gu, "\\$&");
}

export function applyCompiledSecretRule(
	text: string,
	rule: CompiledSecretRule,
	redactSecret?: SecretRedactor,
): SecretFilterResult {
	const result = applyCompiledSecretRuleToView(
		text,
		buildMatchView(text, buildEscapedBreakPattern([rule])),
		rule,
		redactSecret,
	);
	return {
		text: result.text,
		counts: result.counts,
		redactedBytes: result.redactedBytes,
	};
}

interface ViewFilterResult extends SecretFilterResult {
	/**
	 * The match view of the filtered text when it follows from the input's
	 * view (a redaction covers whole escape sequences and its marker has no
	 * backslash), or undefined when it has to be rebuilt.
	 */
	readonly nextView: MatchView | null | undefined;
}

function applyCompiledSecretRuleToView(
	text: string,
	view: MatchView | null,
	rule: CompiledSecretRule,
	redactSecret?: SecretRedactor,
): ViewFilterResult {
	const matchedText = view?.text ?? text;
	// Scanning for a literal is several times faster than running the rule.
	if (rule.keywordMatcher && !rule.keywordMatcher.test(matchedText)) {
		return { text, counts: {}, redactedBytes: 0, nextView: view };
	}

	const pieces: string[] = [];
	// The filtered text's view is this view with the same redactions, as long
	// as no marker contains a backslash.
	const viewPieces: string[] = [];
	const redactions: ViewRedaction[] = [];
	let viewCursor = 0;
	let count = 0;
	let overlongCount = 0;
	let redactedBytes = 0;
	let cursor = 0;

	rule.matcher.lastIndex = 0;
	let match = rule.matcher.exec(matchedText);
	while (match !== null) {
		const secret = match[rule.definition.secretGroup];
		const secretSpan = match.indices?.[rule.definition.secretGroup];
		if (secret === undefined || secretSpan === undefined) {
			advanceAfterMatch(rule.matcher, match);
			match = rule.matcher.exec(matchedText);
			continue;
		}

		if (isAllowlisted(secret, rule)) {
			advanceAfterMatch(rule.matcher, match);
			match = rule.matcher.exec(matchedText);
			continue;
		}

		const [viewStart, viewEnd] = secretSpan;
		const secretStart = toTextOffset(view, viewStart);
		const secretEnd = toTextOffset(view, viewEnd);
		const secretBytes = getUtf8ByteLength(text.slice(secretStart, secretEnd));
		const replacement =
			redactSecret?.(rule.definition.id, secret) ??
			`[REDACTED:${rule.definition.id}]`;
		pieces.push(text.slice(cursor, secretStart), replacement);
		cursor = secretEnd;
		viewPieces.push(matchedText.slice(viewCursor, viewStart), replacement);
		viewCursor = viewEnd;
		redactions.push({
			viewStart,
			viewEnd,
			textStart: secretStart,
			textEnd: secretEnd,
			replacement,
		});
		count += 1;
		redactedBytes += secretBytes;

		if (secretBytes > OVERLONG_MATCH_THRESHOLD_BYTES) {
			overlongCount += 1;
		}

		// Resume at the end of the secret group rather than match[0] so a
		// delimiter consumed by the surrounding regex remains available to later
		// rules while every byte in the matched secret stays removed.
		rule.matcher.lastIndex = viewEnd;
		match = rule.matcher.exec(matchedText);
	}
	rule.matcher.lastIndex = 0;

	if (count === 0) {
		return { text, counts: {}, redactedBytes: 0, nextView: view };
	}

	pieces.push(text.slice(cursor));
	viewPieces.push(matchedText.slice(viewCursor));
	const nextView = redactions.some(({ replacement }) =>
		replacement.includes("\\"),
	)
		? undefined
		: view && redactView(view, viewPieces.join(""), redactions);
	const counts: Record<string, number> = {
		[rule.definition.id]: count,
	};
	if (overlongCount > 0) {
		counts[OVERLONG_REDACTION_RULE_ID] = overlongCount;
	}
	return {
		text: pieces.join(""),
		counts,
		redactedBytes,
		nextView,
	};
}

function applyCompiledSecretRules(
	text: string,
	rules: readonly CompiledSecretRule[],
	redactSecret?: SecretRedactor,
): SecretFilterResult {
	let filteredText = text;
	const escapedBreakPattern = buildEscapedBreakPattern(rules);
	let view = buildMatchView(text, escapedBreakPattern);
	let counts: RedactionCounts = {};
	let redactedBytes = 0;

	for (const rule of rules) {
		const result = applyCompiledSecretRuleToView(
			filteredText,
			view,
			rule,
			redactSecret,
		);
		if (result.text !== filteredText) {
			filteredText = result.text;
			view =
				result.nextView === undefined
					? buildMatchView(filteredText, escapedBreakPattern)
					: result.nextView;
		}
		counts = mergeRedactionCounts(counts, result.counts);
		redactedBytes += result.redactedBytes;
	}

	return { text: filteredText, counts, redactedBytes };
}

/**
 * The text rules match. Transcripts are JSON, so a secret sits next to escape
 * sequences, and rules are written for decoded text:
 * - Escaped line breaks and tabs (`\n`, or `\\n` one JSON level deeper)
 *   become spaces of the same length, so `\b` and `\s` see a line break.
 *   Outside JSON a backslash may be literal (`repo\npm_...`), so an
 *   escape letter that begins a rule keyword is left as it is.
 * - JSON writers may escape any character as `\u00XX` (.NET escapes `+`, Go
 *   escapes `&`) and `/` as `\/` (PHP); behind any run of backslashes those
 *   are decoded to the character, and offsets map back to the input.
 * A match always covers whole escape sequences, so a redaction never leaves
 * half an escape behind and JSON stays valid.
 */
interface MatchView {
	readonly text: string;
	/** View offset of each decoded escape, ascending. */
	readonly viewOffsets: readonly number[];
	/** Offset of each decoded escape in the input text. */
	readonly textOffsets: readonly number[];
	readonly textLengths: readonly number[];
}

const ESCAPED_PRINTABLE_PATTERN =
	/\\+(?:u00([2-6][0-9A-Fa-f]|7[0-9A-Ea-e])|\/)/gu;

function buildEscapedBreakPattern(
	rules: readonly CompiledSecretRule[],
): RegExp {
	const keywordTails: Record<string, string[]> = { n: [], r: [], t: [] };
	for (const rule of rules) {
		for (const keyword of rule.definition.keywords ?? []) {
			const tails = keywordTails[keyword.charAt(0)];
			if (tails && keyword.length > 1) {
				tails.push(toCaseInsensitiveLiteral(keyword.slice(1)));
			}
		}
	}
	const letters = Object.entries(keywordTails).map(([letter, tails]) =>
		tails.length === 0 ? letter : `${letter}(?!${tails.join("|")})`,
	);
	return new RegExp(`\\\\+(?:${letters.join("|")})`, "gu");
}

function toCaseInsensitiveLiteral(text: string): string {
	return [...text]
		.map((character) =>
			/[a-z]/iu.test(character)
				? `[${character.toLowerCase()}${character.toUpperCase()}]`
				: escapeRegExpLiteral(character),
		)
		.join("");
}

function buildMatchView(
	text: string,
	escapedBreakPattern: RegExp,
): MatchView | null {
	if (!text.includes("\\")) {
		return null;
	}

	const spaced = text.replace(escapedBreakPattern, (sequence) =>
		" ".repeat(sequence.length),
	);
	const viewOffsets: number[] = [];
	const textOffsets: number[] = [];
	const textLengths: number[] = [];
	if (!spaced.includes("\\u00") && !spaced.includes("\\/")) {
		return { text: spaced, viewOffsets, textOffsets, textLengths };
	}

	const pieces: string[] = [];
	let cursor = 0;
	let viewLength = 0;
	for (const decoded of spaced.matchAll(ESCAPED_PRINTABLE_PATTERN)) {
		const hex = decoded[1];
		pieces.push(spaced.slice(cursor, decoded.index));
		viewLength += decoded.index - cursor;
		viewOffsets.push(viewLength);
		textOffsets.push(decoded.index);
		textLengths.push(decoded[0].length);
		pieces.push(
			hex === undefined ? "/" : String.fromCharCode(Number.parseInt(hex, 16)),
		);
		viewLength += 1;
		cursor = decoded.index + decoded[0].length;
	}
	pieces.push(spaced.slice(cursor));

	return { text: pieces.join(""), viewOffsets, textOffsets, textLengths };
}

interface ViewRedaction {
	readonly viewStart: number;
	readonly viewEnd: number;
	readonly textStart: number;
	readonly textEnd: number;
	readonly replacement: string;
}

/**
 * The view of the redacted text: decoded escapes inside a redaction are gone
 * and the ones after it move by the length the marker adds or removes.
 */
function redactView(
	view: MatchView,
	text: string,
	redactions: readonly ViewRedaction[],
): MatchView {
	const viewOffsets: number[] = [];
	const textOffsets: number[] = [];
	const textLengths: number[] = [];
	let viewShift = 0;
	let textShift = 0;
	let redactionIndex = 0;
	for (let index = 0; index < view.viewOffsets.length; index += 1) {
		const viewOffset = view.viewOffsets[index] ?? 0;
		let redaction = redactions[redactionIndex];
		while (redaction && redaction.viewEnd <= viewOffset) {
			viewShift +=
				redaction.replacement.length -
				(redaction.viewEnd - redaction.viewStart);
			textShift +=
				redaction.replacement.length -
				(redaction.textEnd - redaction.textStart);
			redactionIndex += 1;
			redaction = redactions[redactionIndex];
		}
		if (redaction && redaction.viewStart <= viewOffset) {
			continue;
		}
		viewOffsets.push(viewOffset + viewShift);
		textOffsets.push((view.textOffsets[index] ?? 0) + textShift);
		textLengths.push(view.textLengths[index] ?? 0);
	}
	return { text, viewOffsets, textOffsets, textLengths };
}

function toTextOffset(view: MatchView | null, viewOffset: number): number {
	if (view === null) {
		return viewOffset;
	}

	// The last decoded escape at or before viewOffset.
	let low = 0;
	let high = view.viewOffsets.length - 1;
	let escapeIndex = -1;
	while (low <= high) {
		const middle = (low + high) >>> 1;
		if ((view.viewOffsets[middle] ?? 0) <= viewOffset) {
			escapeIndex = middle;
			low = middle + 1;
		} else {
			high = middle - 1;
		}
	}
	if (escapeIndex < 0) {
		return viewOffset;
	}

	const escapeViewOffset = view.viewOffsets[escapeIndex] ?? 0;
	const escapeTextOffset = view.textOffsets[escapeIndex] ?? 0;
	if (escapeViewOffset === viewOffset) {
		return escapeTextOffset;
	}
	return (
		escapeTextOffset +
		(view.textLengths[escapeIndex] ?? 0) +
		(viewOffset - escapeViewOffset - 1)
	);
}

function advanceAfterMatch(matcher: RegExp, match: RegExpExecArray): void {
	if (matcher.lastIndex === match.index) {
		matcher.lastIndex += 1;
	}
}

function isAllowlisted(secret: string, rule: CompiledSecretRule): boolean {
	return rule.allowlistMatchers.some((matcher) => matcher.test(secret));
}
