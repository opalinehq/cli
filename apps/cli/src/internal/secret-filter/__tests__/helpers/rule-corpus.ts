/**
 * Shared fixture corpus for the filter-engine pressure tests.
 *
 * Not a test file: it must not match the `*.test.ts` glob, because importing a
 * test file would execute its tests inside the importer's run.
 */
import { GENERATED_SECRET_RULES } from "../../generated-rules.js";

export interface CanonicalSecretCase {
	readonly ruleId: string;
	readonly secret: string;
	readonly input: string;
}

export const OPENAI_CANARY = `sk-${"CANARY".padEnd(20, "A")}T3BlbkFJ${"CANARY".padEnd(20, "B")}`;
export const AWS_CANARY = "AKIACANARY234567ABCD";

/**
 * One realistic positive per rule (Stripe twice: secret and restricted keys).
 * Moved verbatim from filter.test.ts, which imports it back — the per-rule
 * positive assertions there are the ground truth for these values.
 */
export const CANONICAL_SECRETS: readonly CanonicalSecretCase[] = [
	{
		ruleId: "anthropic-admin-api-key",
		secret: `sk-ant-admin01-${"CANARY".padEnd(93, "A")}AA`,
		input: `ANTHROPIC_ADMIN=${`sk-ant-admin01-${"CANARY".padEnd(93, "A")}AA`}`,
	},
	{
		ruleId: "anthropic-api-key",
		secret: `sk-ant-api03-${"CANARY".padEnd(93, "A")}AA`,
		input: `ANTHROPIC_API_KEY=${`sk-ant-api03-${"CANARY".padEnd(93, "A")}AA`}`,
	},
	{
		ruleId: "aws-access-key-id",
		secret: AWS_CANARY,
		input: `AWS_ACCESS_KEY_ID=${AWS_CANARY}`,
	},
	{
		ruleId: "google-api-key",
		secret: `AIza${"CANARY".padEnd(35, "A")}`,
		input: `GOOGLE_API_KEY=AIza${"CANARY".padEnd(35, "A")}`,
	},
	{
		ruleId: "github-app-token",
		secret: `ghs_${"CANARY".padEnd(36, "A")}`,
		input: `token=ghs_${"CANARY".padEnd(36, "A")}`,
	},
	{
		ruleId: "github-fine-grained-pat",
		secret: `github_pat_${"CANARY".padEnd(82, "A")}`,
		input: `token=github_pat_${"CANARY".padEnd(82, "A")}`,
	},
	{
		ruleId: "github-oauth",
		secret: `gho_${"CANARY".padEnd(36, "A")}`,
		input: `token=gho_${"CANARY".padEnd(36, "A")}`,
	},
	{
		ruleId: "github-pat",
		secret: `ghp_${"CANARY".padEnd(36, "A")}`,
		input: `token=ghp_${"CANARY".padEnd(36, "A")}`,
	},
	{
		ruleId: "gitlab-pat",
		secret: `glpat-${"CANARY".padEnd(20, "A")}`,
		input: `token=glpat-${"CANARY".padEnd(20, "A")}`,
	},
	{
		ruleId: "npm-access-token",
		secret: `npm_${"CANARY".padEnd(36, "A")}`,
		input: `//registry.npmjs.org/:_authToken=npm_${"CANARY".padEnd(36, "A")}`,
	},
	{
		ruleId: "openai-api-key",
		secret: OPENAI_CANARY,
		input: `OPENAI_API_KEY=${OPENAI_CANARY}`,
	},
	{
		ruleId: "private-key",
		secret: [
			"-----BEGIN PRIVATE KEY-----",
			"CANARY".padEnd(64, "A"),
			"-----END PRIVATE KEY-----",
		].join("\n"),
		input: [
			"key:",
			"-----BEGIN PRIVATE KEY-----",
			"CANARY".padEnd(64, "A"),
			"-----END PRIVATE KEY-----",
		].join("\n"),
	},
	{
		ruleId: "sendgrid-api-token",
		secret: `SG.${"CANARY".padEnd(66, "A")}`,
		input: `SENDGRID_API_KEY=SG.${"CANARY".padEnd(66, "A")}`,
	},
	{
		ruleId: "slack-bot-token",
		secret: "xoxb-1234567890-1234567890-CANARY",
		input: "SLACK_BOT_TOKEN=xoxb-1234567890-1234567890-CANARY",
	},
	{
		ruleId: "slack-user-token",
		secret: `xoxp-1234567890-1234567890-1234567890-${"CANARY".padEnd(28, "A")}`,
		input: `SLACK_USER_TOKEN=xoxp-1234567890-1234567890-1234567890-${"CANARY".padEnd(28, "A")}`,
	},
	{
		ruleId: "slack-webhook-url",
		secret: `https://hooks.slack.com/services/${"CANARY".padEnd(43, "A")}`,
		input: `webhook=https://hooks.slack.com/services/${"CANARY".padEnd(43, "A")}`,
	},
	{
		ruleId: "stripe-access-token",
		secret: `sk_live_${"CANARY".padEnd(24, "A")}`,
		input: `STRIPE_SECRET_KEY=sk_live_${"CANARY".padEnd(24, "A")}`,
	},
	{
		ruleId: "stripe-access-token",
		secret: `rk_live_${"CANARY".padEnd(24, "A")}`,
		input: `STRIPE_RESTRICTED_KEY=rk_live_${"CANARY".padEnd(24, "A")}`,
	},
	{
		ruleId: "twilio-api-key",
		secret: `SK${"CA".repeat(16)}`,
		input: `TWILIO_API_KEY=SK${"CA".repeat(16)}`,
	},
];

/**
 * Byte-identical inputs the filter must never rewrite. Shared by the core
 * behavior tests, fixpoint checks, and output fingerprint.
 */
export const PRESERVED_CORPUS: readonly (readonly [string, string])[] = [
	["uuid", "550e8400-e29b-41d4-a716-446655440000"],
	["git sha", "0123456789abcdef0123456789abcdef01234567"],
	["content hash", "0123456789abcdef".repeat(4)],
	["base64 asset", `data:image/png;base64,${"aGVsbG8td29ybGQ=".repeat(64)}`],
	[
		"minified js",
		`(()=>{const e="0123456789abcdef",t={a:1,b:2};return\`\${e}:\${JSON.stringify(t)}\`})();`,
	],
	["lowercase sendgrid prefix", `sg.${"a".repeat(66)}`],
	["aws example allowlist", "AKIAIOSFODNN7EXAMPLE"],
	["bracket soup", "arr[0][1][REDACTED][2]"],
	["prose", "The quick brown fox jumps over the lazy dog."],
	["empty", ""],
];

export interface DelimiterContext {
	readonly id: string;
	/** Text placed before the embedded secret. */
	readonly prefix: string;
	/**
	 * Text placed after the embedded secret. Its leading characters are what
	 * the trailing-delimiter-anchored rules see, so they decide redacted
	 * versus gap for those rules.
	 */
	readonly suffix: string;
	/** JSON string contexts escape the secret before embedding it. */
	readonly escapesSecret: boolean;
}

export const DELIMITER_CONTEXTS: readonly DelimiterContext[] = [
	{
		id: "json-value",
		prefix: '{"service":"demo","apiKey":"',
		suffix: '","active":true}',
		escapesSecret: true,
	},
	{
		// A raw transcript line the way it sits in a .jsonl file: the secret is
		// followed by a literal backslash-n escape, which the trailing group's
		// \\[nr] branch treats as a delimiter.
		id: "jsonl-transcript-line",
		prefix:
			'{"type":"assistant","message":{"role":"assistant","content":"token=',
		suffix: '\\nDone."},"uuid":"3e1b2a"}',
		escapesSecret: true,
	},
	{
		id: "shell-double-quote",
		prefix: 'curl -H "Authorization: Bearer ',
		suffix: '" https://api.example.dev/v1',
		escapesSecret: false,
	},
	{
		id: "shell-single-quote",
		prefix: "echo '",
		suffix: "' | pbcopy",
		escapesSecret: false,
	},
	{
		id: "export-assignment",
		prefix: "export SERVICE_KEY=",
		suffix: "\nrun-deploy --now",
		escapesSecret: false,
	},
	{
		id: "fenced-code-block",
		prefix: "```bash\n",
		suffix: "\n```",
		escapesSecret: false,
	},
	{
		id: "inline-backticks",
		prefix: "run it with `",
		suffix: "` as the key",
		escapesSecret: false,
	},
	{
		id: "url-query-param",
		prefix: "https://api.example.dev/v1/items?key=",
		suffix: "&page=2",
		escapesSecret: false,
	},
	{
		id: "yaml",
		prefix: "credentials:\n  api_key: ",
		suffix: "\n  region: us-east-1",
		escapesSecret: false,
	},
	{
		id: "crlf",
		prefix: "token=",
		suffix: "\r\nnext-line",
		escapesSecret: false,
	},
	{
		id: "position-0",
		prefix: "",
		suffix: " leaked in the first line",
		escapesSecret: false,
	},
	{
		id: "eof-no-delimiter",
		prefix: "the credential is ",
		suffix: "",
		escapesSecret: false,
	},
	{
		id: "emoji-cjk-adjacent",
		prefix: "密钥🔑",
		suffix: "🚀続行",
		escapesSecret: false,
	},
];

/** JSON-escape a string the way it appears inside a JSON string literal. */
export function escapeForJsonString(text: string): string {
	return JSON.stringify(text).slice(1, -1);
}

export function embedSecretInContext(
	context: DelimiterContext,
	secret: string,
): { readonly input: string; readonly embedded: string } {
	const embedded = context.escapesSecret ? escapeForJsonString(secret) : secret;
	return { input: `${context.prefix}${embedded}${context.suffix}`, embedded };
}

export function buildRedactedExpectation(
	context: DelimiterContext,
	ruleId: string,
): string {
	return `${context.prefix}[REDACTED:${ruleId}]${context.suffix}`;
}

/**
 * Gitleaks' trailing delimiter group, exactly as it ends seven generated rule
 * sources at runtime. Derived (not hardcoded per rule) so a ruleset regen that
 * adds or removes the anchor moves rules in and out of the gap set here.
 */
export const TRAILING_DELIMITER_GROUP_SOURCE = String.raw`(?:[\x60'"\s;]|\\[nr]|$)`;

export const DELIMITER_ANCHORED_RULE_IDS: readonly string[] =
	GENERATED_SECRET_RULES.filter((rule) =>
		rule.regexSource.endsWith(TRAILING_DELIMITER_GROUP_SOURCE),
	).map((rule) => rule.id);

/**
 * Whether the text that follows a secret satisfies the trailing delimiter
 * group: backtick, quote, whitespace, semicolon, a literal \n or \r escape
 * sequence, or end of input.
 */
export function isSupportedTrailingText(afterSecret: string): boolean {
	return (
		afterSecret === "" ||
		/^[\x60'"\s;]/u.test(afterSecret) ||
		/^\\[nr]/u.test(afterSecret)
	);
}

export type CorpusOutcome = "redacted" | "delimiter-anchor-gap";

/**
 * Expected filter outcome for one (rule, context) pair.
 *
 * - "delimiter-anchor-gap": the rule requires a trailing delimiter and the
 *   context's next character is outside the group, so the secret survives
 *   today. Pinned, accepted; closing it needs a ruleset change.
 */
export function getExpectedCorpusOutcome(
	ruleId: string,
	context: DelimiterContext,
	_secret: string,
): CorpusOutcome {
	if (
		DELIMITER_ANCHORED_RULE_IDS.includes(ruleId) &&
		!isSupportedTrailingText(context.suffix)
	) {
		return "delimiter-anchor-gap";
	}
	return "redacted";
}

export type NearMissMutationKind =
	| "truncated-last-char"
	| "mutated-prefix-char"
	| "case-flip"
	| "interior-whitespace"
	| "body-1-short"
	| "charset-violation";

export interface NearMissMutation {
	readonly ruleId: string;
	readonly kind: NearMissMutationKind;
	readonly value: string;
	/**
	 * When set, this mutation is a syntactically valid token of a sibling rule
	 * and the filter redacts it as that sibling. Triaged findings, not fixture
	 * noise: redacting them is correct behaviour.
	 */
	readonly expectedSiblingRuleId?: string;
}

const pad = (value: string, length: number, fill: string): string =>
	value.padEnd(length, fill);
const BODY_93 = pad("CANARY", 93, "A");
const BODY_82 = pad("CANARY", 82, "A");
const BODY_66 = pad("CANARY", 66, "A");
const BODY_43 = pad("CANARY", 43, "A");
const BODY_36 = pad("CANARY", 36, "A");
const BODY_35 = pad("CANARY", 35, "A");
const BODY_28 = pad("CANARY", 28, "A");
const BODY_24 = pad("CANARY", 24, "A");
const BODY_20 = pad("CANARY", 20, "A");
const NPM_BODY = pad("canary", 36, "a");
const OPENAI_TAIL = pad("CANARY", 20, "B");
const TWILIO_BODY = "CA".repeat(16);

/**
 * Per-rule negatives that sit one mutation away from a live secret. Every
 * entry without expectedSiblingRuleId must pass through byte-identically.
 *
 * Rule-specific constraints encoded below:
 * - npm-access-token and private-key are case-insensitive, so they get no
 *   case-flip mutation (a flipped token still matches — it is not a near miss).
 * - private-key gets no interior-whitespace mutation: whitespace is legal
 *   inside its body charset, so the mutant would still match.
 * - Flexible-length rules (stripe {10,99}, slack-bot trailing *) cannot use
 *   truncated-last-char — the shorter token still matches — so their length
 *   mutation drops below the regex minimum instead (body-1-short).
 */
export const NEAR_MISS_MUTATIONS: readonly NearMissMutation[] = [
	{
		ruleId: "anthropic-admin-api-key",
		kind: "truncated-last-char",
		value: `sk-ant-admin01-${BODY_93}A`,
	},
	{
		ruleId: "anthropic-admin-api-key",
		kind: "mutated-prefix-char",
		value: `sk-ant-admin02-${BODY_93}AA`,
	},
	{
		ruleId: "anthropic-admin-api-key",
		kind: "case-flip",
		value: `SK-ant-admin01-${BODY_93}AA`,
	},
	{
		ruleId: "anthropic-admin-api-key",
		kind: "interior-whitespace",
		value: `sk-ant-admin01-${BODY_93.slice(0, 40)} ${BODY_93.slice(40)}AA`,
	},
	{
		ruleId: "anthropic-admin-api-key",
		kind: "body-1-short",
		value: `sk-ant-admin01-${pad("CANARY", 92, "A")}AA`,
	},
	{
		ruleId: "anthropic-api-key",
		kind: "truncated-last-char",
		value: `sk-ant-api03-${BODY_93}A`,
	},
	{
		ruleId: "anthropic-api-key",
		kind: "mutated-prefix-char",
		value: `sk-ant-api04-${BODY_93}AA`,
	},
	{
		ruleId: "anthropic-api-key",
		kind: "case-flip",
		value: `SK-ant-api03-${BODY_93}AA`,
	},
	{
		ruleId: "anthropic-api-key",
		kind: "interior-whitespace",
		value: `sk-ant-api03-${BODY_93.slice(0, 40)} ${BODY_93.slice(40)}AA`,
	},
	{
		ruleId: "anthropic-api-key",
		kind: "body-1-short",
		value: `sk-ant-api03-${pad("CANARY", 92, "A")}AA`,
	},
	{
		ruleId: "aws-access-key-id",
		kind: "truncated-last-char",
		value: "AKIACANARY234567ABC",
	},
	{
		// AKIA -> AQIA misses every alternative of the prefix alternation.
		ruleId: "aws-access-key-id",
		kind: "mutated-prefix-char",
		value: "AQIACANARY234567ABCD",
	},
	{
		ruleId: "aws-access-key-id",
		kind: "case-flip",
		value: "akiacanary234567abcd",
	},
	{
		ruleId: "aws-access-key-id",
		kind: "interior-whitespace",
		value: "AKIACANARY 234567ABCD",
	},
	{
		// "8" is outside the base32 body class [A-Z2-7].
		ruleId: "aws-access-key-id",
		kind: "charset-violation",
		value: "AKIACANARY834567ABCD",
	},
	{
		ruleId: "google-api-key",
		kind: "truncated-last-char",
		value: `AIza${BODY_35.slice(0, 34)}`,
	},
	{
		ruleId: "google-api-key",
		kind: "mutated-prefix-char",
		value: `AIzb${BODY_35}`,
	},
	{
		ruleId: "google-api-key",
		kind: "case-flip",
		value: `aIza${BODY_35}`,
	},
	{
		ruleId: "google-api-key",
		kind: "interior-whitespace",
		value: `AIza${BODY_35.slice(0, 12)} ${BODY_35.slice(12)}`,
	},
	{
		ruleId: "google-api-key",
		kind: "charset-violation",
		value: `AIza${BODY_35.slice(0, 12)}!${BODY_35.slice(13)}`,
	},
	{
		ruleId: "github-app-token",
		kind: "truncated-last-char",
		value: `ghs_${BODY_36.slice(0, 35)}`,
	},
	{
		ruleId: "github-app-token",
		kind: "mutated-prefix-char",
		value: `ght_${BODY_36}`,
	},
	{
		// Triaged finding: mutating the app-token prefix ghs_ one letter to
		// gho_ produces a syntactically valid github-oauth token, so the
		// sibling rule redacts it. Correct behaviour, pinned as such.
		ruleId: "github-app-token",
		kind: "mutated-prefix-char",
		value: `gho_${BODY_36}`,
		expectedSiblingRuleId: "github-oauth",
	},
	{
		ruleId: "github-app-token",
		kind: "case-flip",
		value: `GHS_${BODY_36}`,
	},
	{
		ruleId: "github-app-token",
		kind: "interior-whitespace",
		value: `ghs_${BODY_36.slice(0, 12)} ${BODY_36.slice(12)}`,
	},
	{
		// "-" is outside the token body class [0-9a-zA-Z].
		ruleId: "github-app-token",
		kind: "charset-violation",
		value: `ghs_${BODY_36.slice(0, 12)}-${BODY_36.slice(13)}`,
	},
	{
		ruleId: "github-fine-grained-pat",
		kind: "truncated-last-char",
		value: `github_pat_${BODY_82.slice(0, 81)}`,
	},
	{
		ruleId: "github-fine-grained-pat",
		kind: "mutated-prefix-char",
		value: `github_qat_${BODY_82}`,
	},
	{
		ruleId: "github-fine-grained-pat",
		kind: "case-flip",
		value: `GITHUB_PAT_${BODY_82}`,
	},
	{
		ruleId: "github-fine-grained-pat",
		kind: "interior-whitespace",
		value: `github_pat_${BODY_82.slice(0, 40)} ${BODY_82.slice(40)}`,
	},
	{
		ruleId: "github-fine-grained-pat",
		kind: "charset-violation",
		value: `github_pat_${BODY_82.slice(0, 40)}!${BODY_82.slice(41)}`,
	},
	{
		ruleId: "github-oauth",
		kind: "truncated-last-char",
		value: `gho_${BODY_36.slice(0, 35)}`,
	},
	{
		ruleId: "github-oauth",
		kind: "mutated-prefix-char",
		value: `ghq_${BODY_36}`,
	},
	{
		// Triaged finding: gho_ -> ghp_ lands on a valid github-pat token, so
		// the sibling rule redacts it. Correct behaviour, pinned as such.
		ruleId: "github-oauth",
		kind: "mutated-prefix-char",
		value: `ghp_${BODY_36}`,
		expectedSiblingRuleId: "github-pat",
	},
	{
		ruleId: "github-oauth",
		kind: "case-flip",
		value: `GHO_${BODY_36}`,
	},
	{
		ruleId: "github-oauth",
		kind: "interior-whitespace",
		value: `gho_${BODY_36.slice(0, 12)} ${BODY_36.slice(12)}`,
	},
	{
		ruleId: "github-oauth",
		kind: "charset-violation",
		value: `gho_${BODY_36.slice(0, 12)}-${BODY_36.slice(13)}`,
	},
	{
		ruleId: "github-pat",
		kind: "truncated-last-char",
		value: `ghp_${BODY_36.slice(0, 35)}`,
	},
	{
		// ghr_ deliberately avoids gho/ghs/ghu, which are live sibling prefixes.
		ruleId: "github-pat",
		kind: "mutated-prefix-char",
		value: `ghr_${BODY_36}`,
	},
	{
		ruleId: "github-pat",
		kind: "case-flip",
		value: `GHP_${BODY_36}`,
	},
	{
		ruleId: "github-pat",
		kind: "interior-whitespace",
		value: `ghp_${BODY_36.slice(0, 12)} ${BODY_36.slice(12)}`,
	},
	{
		ruleId: "github-pat",
		kind: "charset-violation",
		value: `ghp_${BODY_36.slice(0, 12)}-${BODY_36.slice(13)}`,
	},
	{
		ruleId: "gitlab-pat",
		kind: "truncated-last-char",
		value: `glpat-${BODY_20.slice(0, 19)}`,
	},
	{
		ruleId: "gitlab-pat",
		kind: "mutated-prefix-char",
		value: `glqat-${BODY_20}`,
	},
	{
		ruleId: "gitlab-pat",
		kind: "case-flip",
		value: `GLPAT-${BODY_20}`,
	},
	{
		ruleId: "gitlab-pat",
		kind: "interior-whitespace",
		value: `glpat-${BODY_20.slice(0, 8)} ${BODY_20.slice(8)}`,
	},
	{
		ruleId: "gitlab-pat",
		kind: "charset-violation",
		value: `glpat-${BODY_20.slice(0, 8)}!${BODY_20.slice(9)}`,
	},
	{
		ruleId: "npm-access-token",
		kind: "truncated-last-char",
		value: `npm_${NPM_BODY.slice(0, 35)}`,
	},
	{
		ruleId: "npm-access-token",
		kind: "mutated-prefix-char",
		value: `npn_${NPM_BODY}`,
	},
	{
		ruleId: "npm-access-token",
		kind: "interior-whitespace",
		value: `npm_${NPM_BODY.slice(0, 12)} ${NPM_BODY.slice(12)}`,
	},
	{
		// "-" is outside the npm body class [a-z0-9] (case-insensitive).
		ruleId: "npm-access-token",
		kind: "charset-violation",
		value: `npm_${NPM_BODY.slice(0, 12)}-${NPM_BODY.slice(13)}`,
	},
	{
		ruleId: "openai-api-key",
		kind: "truncated-last-char",
		value: `sk-${BODY_20}T3BlbkFJ${OPENAI_TAIL.slice(0, 19)}`,
	},
	{
		ruleId: "openai-api-key",
		kind: "mutated-prefix-char",
		value: `sj-${BODY_20}T3BlbkFJ${OPENAI_TAIL}`,
	},
	{
		ruleId: "openai-api-key",
		kind: "case-flip",
		value: `SK-${BODY_20}T3BlbkFJ${OPENAI_TAIL}`,
	},
	{
		ruleId: "openai-api-key",
		kind: "interior-whitespace",
		value: `sk-${BODY_20.slice(0, 10)} ${BODY_20.slice(10)}T3BlbkFJ${OPENAI_TAIL}`,
	},
	{
		// The magic T3BlbkFJ infix off by its final letter.
		ruleId: "openai-api-key",
		kind: "charset-violation",
		value: `sk-${BODY_20}T3BlbkFK${OPENAI_TAIL}`,
	},
	{
		ruleId: "openai-api-key",
		kind: "body-1-short",
		value: `sk-${BODY_20.slice(0, 19)}T3BlbkFJ${OPENAI_TAIL}`,
	},
	{
		ruleId: "private-key",
		kind: "truncated-last-char",
		value: [
			"-----BEGIN PRIVATE KEY-----",
			pad("CANARY", 64, "A"),
			'-----END PRIVATE KEY----"',
		].join("\n"),
	},
	{
		ruleId: "private-key",
		kind: "mutated-prefix-char",
		value: [
			"-----BEGIM PRIVATE KEY-----",
			pad("CANARY", 64, "A"),
			"-----END PRIVATE KEY-----",
		].join("\n"),
	},
	{
		// The regex body spans the newlines and the footer's "-----END PRIVATE "
		// run (19 characters), so a 44-character key body totals 63 matchable
		// characters — one below the {64,} minimum.
		ruleId: "private-key",
		kind: "body-1-short",
		value: [
			"-----BEGIN PRIVATE KEY-----",
			pad("CANARY", 44, "A"),
			'-----END PRIVATE KEY-----"',
		].join("\n"),
	},
	{
		ruleId: "private-key",
		kind: "charset-violation",
		value: [
			"-----BEGIN PRIVATE KEY-----",
			`${pad("CANARY", 64, "A").slice(0, 30)}!${pad("CANARY", 64, "A").slice(31)}`,
			"-----END PRIVATE KEY-----",
		].join("\n"),
	},
	{
		ruleId: "sendgrid-api-token",
		kind: "truncated-last-char",
		value: `SG.${BODY_66.slice(0, 65)}`,
	},
	{
		ruleId: "sendgrid-api-token",
		kind: "mutated-prefix-char",
		value: `SH.${BODY_66}`,
	},
	{
		ruleId: "sendgrid-api-token",
		kind: "case-flip",
		value: `sg.${BODY_66}`,
	},
	{
		ruleId: "sendgrid-api-token",
		kind: "interior-whitespace",
		value: `SG.${BODY_66.slice(0, 20)} ${BODY_66.slice(20)}`,
	},
	{
		ruleId: "sendgrid-api-token",
		kind: "charset-violation",
		value: `SG.${BODY_66.slice(0, 20)}!${BODY_66.slice(21)}`,
	},
	{
		// Second digit block one short of its {10,13} minimum; the trailing
		// [a-zA-Z0-9-]* makes truncated-last-char still match, so length
		// pressure has to come from the digit block.
		ruleId: "slack-bot-token",
		kind: "body-1-short",
		value: "xoxb-1234567890-123456789",
	},
	{
		ruleId: "slack-bot-token",
		kind: "mutated-prefix-char",
		value: "xoxc-1234567890-1234567890-CANARY",
	},
	{
		ruleId: "slack-bot-token",
		kind: "case-flip",
		value: "XOXB-1234567890-1234567890-CANARY",
	},
	{
		ruleId: "slack-bot-token",
		kind: "interior-whitespace",
		value: "xoxb-12345 67890-1234567890-CANARY",
	},
	{
		ruleId: "slack-bot-token",
		kind: "charset-violation",
		value: "xoxb-1234567890-12345a7890-CANARY",
	},
	{
		ruleId: "slack-user-token",
		kind: "truncated-last-char",
		value: `xoxp-1234567890-1234567890-1234567890-${BODY_28.slice(0, 27)}`,
	},
	{
		// xoxq avoids xoxe (same rule) and xoxb (sibling).
		ruleId: "slack-user-token",
		kind: "mutated-prefix-char",
		value: `xoxq-1234567890-1234567890-1234567890-${BODY_28}`,
	},
	{
		// Triaged finding: xoxp -> xoxb turns the user token into a valid
		// slack-bot-token — the bot rule's [a-zA-Z0-9-]* tail swallows the
		// third digit block and the suffix. Correct behaviour, pinned as such.
		ruleId: "slack-user-token",
		kind: "mutated-prefix-char",
		value: `xoxb-1234567890-1234567890-1234567890-${BODY_28}`,
		expectedSiblingRuleId: "slack-bot-token",
	},
	{
		ruleId: "slack-user-token",
		kind: "case-flip",
		value: `XOXP-1234567890-1234567890-1234567890-${BODY_28}`,
	},
	{
		ruleId: "slack-user-token",
		kind: "interior-whitespace",
		value: `xoxp-1234567890-1234567890-1234567890-${BODY_28.slice(0, 10)} ${BODY_28.slice(10)}`,
	},
	{
		ruleId: "slack-user-token",
		kind: "charset-violation",
		value: `xoxp-1234567890-1234567890-1234567890-${BODY_28.slice(0, 10)}!${BODY_28.slice(11)}`,
	},
	{
		ruleId: "slack-webhook-url",
		kind: "truncated-last-char",
		value: `https://hooks.slack.com/services/${BODY_43.slice(0, 42)}`,
	},
	{
		// Mutates a literal letter of the host; the dots are regex wildcards,
		// so mutating a dot would still match.
		ruleId: "slack-webhook-url",
		kind: "mutated-prefix-char",
		value: `https://hooks.slack.con/services/${BODY_43}`,
	},
	{
		ruleId: "slack-webhook-url",
		kind: "case-flip",
		value: `https://HOOKS.SLACK.COM/services/${BODY_43}`,
	},
	{
		ruleId: "slack-webhook-url",
		kind: "interior-whitespace",
		value: `https://hooks.slack.com/services/${BODY_43.slice(0, 15)} ${BODY_43.slice(15)}`,
	},
	{
		ruleId: "slack-webhook-url",
		kind: "charset-violation",
		value: `https://hooks.slack.com/services/${BODY_43.slice(0, 15)}!${BODY_43.slice(16)}`,
	},
	{
		// Nine body characters, one below the {10,99} minimum; truncating the
		// canonical 24-character secret by one would still match.
		ruleId: "stripe-access-token",
		kind: "body-1-short",
		value: "sk_live_CANARYAAA",
	},
	{
		ruleId: "stripe-access-token",
		kind: "mutated-prefix-char",
		value: `sk_lave_${BODY_24}`,
	},
	{
		ruleId: "stripe-access-token",
		kind: "case-flip",
		value: `SK_LIVE_${BODY_24}`,
	},
	{
		// The space lands after five body characters, below the ten-character
		// minimum, so neither fragment matches.
		ruleId: "stripe-access-token",
		kind: "interior-whitespace",
		value: `sk_live_${BODY_24.slice(0, 5)} ${BODY_24.slice(5)}`,
	},
	{
		// "_" is outside the stripe body class [a-zA-Z0-9] and sits before the
		// minimum run length.
		ruleId: "stripe-access-token",
		kind: "charset-violation",
		value: `sk_live_CAN_RY${BODY_24.slice(7)}`,
	},
	{
		ruleId: "twilio-api-key",
		kind: "truncated-last-char",
		value: `SK${TWILIO_BODY.slice(0, 31)}`,
	},
	{
		ruleId: "twilio-api-key",
		kind: "mutated-prefix-char",
		value: `SL${TWILIO_BODY}`,
	},
	{
		ruleId: "twilio-api-key",
		kind: "case-flip",
		value: `sk${TWILIO_BODY}`,
	},
	{
		ruleId: "twilio-api-key",
		kind: "interior-whitespace",
		value: `SK${"CA".repeat(8)} ${"CA".repeat(8)}`,
	},
	{
		// "g" is outside the hex body class.
		ruleId: "twilio-api-key",
		kind: "charset-violation",
		value: `SKg${TWILIO_BODY.slice(1)}`,
	},
];

/**
 * Local stand-in for String.prototype.isWellFormed (lib es2024, which this
 * package's tsconfig does not target): true when the string contains no
 * unpaired surrogate code units.
 */
export function isWellFormedUtf16(text: string): boolean {
	for (let index = 0; index < text.length; index += 1) {
		const code = text.charCodeAt(index);
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = text.charCodeAt(index + 1);
			if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) {
				return false;
			}
			index += 1;
		} else if (code >= 0xdc00 && code <= 0xdfff) {
			return false;
		}
	}
	return true;
}
