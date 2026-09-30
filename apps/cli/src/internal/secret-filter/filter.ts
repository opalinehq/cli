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
}

const COMPILED_SECRET_RULES = GENERATED_SECRET_RULES.map(compileSecretRule);
const UTF8_ENCODER = new TextEncoder();

export const FILTER_VERSION = 6;
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

export function filterKnownSecrets(text: string): SecretFilterResult {
	return filterKnownSecretsWithCompiledRules(text, COMPILED_SECRET_RULES);
}

export function filterKnownSecretsWithCompiledRules(
	text: string,
	rules: readonly CompiledSecretRule[],
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
		const passResult = applyCompiledSecretRules(filteredText, rules);
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
	const confirmation = applyCompiledSecretRules(filteredText, rules);
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
	};
}

export function applyCompiledSecretRule(
	text: string,
	rule: CompiledSecretRule,
): SecretFilterResult {
	const pieces: string[] = [];
	let count = 0;
	let overlongCount = 0;
	let redactedBytes = 0;
	let cursor = 0;

	rule.matcher.lastIndex = 0;
	let match = rule.matcher.exec(text);
	while (match !== null) {
		const secret = match[rule.definition.secretGroup];
		const secretSpan = match.indices?.[rule.definition.secretGroup];
		if (secret === undefined || secretSpan === undefined) {
			advanceAfterMatch(rule.matcher, match);
			match = rule.matcher.exec(text);
			continue;
		}

		if (isAllowlisted(secret, rule)) {
			advanceAfterMatch(rule.matcher, match);
			match = rule.matcher.exec(text);
			continue;
		}

		const [secretStart, secretEnd] = secretSpan;
		const secretBytes = getUtf8ByteLength(secret);
		pieces.push(
			text.slice(cursor, secretStart),
			`[REDACTED:${rule.definition.id}]`,
		);
		cursor = secretEnd;
		count += 1;
		redactedBytes += secretBytes;

		if (secretBytes > OVERLONG_MATCH_THRESHOLD_BYTES) {
			overlongCount += 1;
		}

		// Resume at the end of the secret group rather than match[0] so a
		// delimiter consumed by the surrounding regex remains available to later
		// rules while every byte in the matched secret stays removed.
		rule.matcher.lastIndex = secretEnd;
		match = rule.matcher.exec(text);
	}
	rule.matcher.lastIndex = 0;

	if (count === 0) {
		return { text, counts: {}, redactedBytes: 0 };
	}

	pieces.push(text.slice(cursor));
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
	};
}

function applyCompiledSecretRules(
	text: string,
	rules: readonly CompiledSecretRule[],
): SecretFilterResult {
	let filteredText = text;
	let counts: RedactionCounts = {};
	let redactedBytes = 0;

	for (const rule of rules) {
		const result = applyCompiledSecretRule(filteredText, rule);
		filteredText = result.text;
		counts = mergeRedactionCounts(counts, result.counts);
		redactedBytes += result.redactedBytes;
	}

	return { text: filteredText, counts, redactedBytes };
}

function advanceAfterMatch(matcher: RegExp, match: RegExpExecArray): void {
	if (matcher.lastIndex === match.index) {
		matcher.lastIndex += 1;
	}
}

function isAllowlisted(secret: string, rule: CompiledSecretRule): boolean {
	return rule.allowlistMatchers.some((matcher) => matcher.test(secret));
}
