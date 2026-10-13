import { describe, expect, test } from "bun:test";
import { GENERATED_SECRET_RULES } from "../generated-rules.js";
import { filterKnownSecrets, getUtf8ByteLength } from "../index.js";
import {
	buildRedactedExpectation,
	CANONICAL_SECRETS,
	CONTEXTUAL_SECRETS,
	type CorpusOutcome,
	DELIMITER_ANCHORED_RULE_IDS,
	DELIMITER_CONTEXTS,
	embedSecretInContext,
	getExpectedCorpusOutcome,
} from "./helpers/rule-corpus.js";

interface GeneratedCase {
	readonly title: string;
	readonly ruleId: string;
	readonly contextId: string;
	readonly secret: string;
	readonly embedded: string;
	readonly input: string;
	readonly expectedText: string;
	readonly outcome: CorpusOutcome;
}

const generatedCases: GeneratedCase[] = [];
for (const canonical of CANONICAL_SECRETS) {
	for (const context of DELIMITER_CONTEXTS) {
		const outcome = getExpectedCorpusOutcome(
			canonical.ruleId,
			context,
			canonical.secret,
		);
		const { input, embedded } = embedSecretInContext(context, canonical.secret);
		generatedCases.push({
			title: `${canonical.ruleId} (${canonical.secret.slice(0, 8)}…) in ${context.id}`,
			ruleId: canonical.ruleId,
			contextId: context.id,
			secret: canonical.secret,
			embedded,
			input,
			expectedText:
				outcome === "redacted"
					? buildRedactedExpectation(context, canonical.ruleId)
					: input,
			outcome,
		});
	}
}

const redactedCases = generatedCases.filter((c) => c.outcome === "redacted");
const delimiterGapCases = generatedCases.filter(
	(c) => c.outcome === "delimiter-anchor-gap",
);
const jsonEscapedPrivateKeyCases = generatedCases.filter(
	(c) =>
		c.ruleId === "private-key" &&
		["json-value", "jsonl-transcript-line"].includes(c.contextId),
);

describe("every rule in every delimiter context", () => {
	for (const generated of redactedCases) {
		test(`${generated.title} redacts byte-exactly`, () => {
			const result = filterKnownSecrets(generated.input);

			expect(result.text).toBe(generated.expectedText);
			expect(result.counts).toEqual({ [generated.ruleId]: 1 });
			expect(result.redactedBytes).toBe(getUtf8ByteLength(generated.embedded));
		});
	}
});

describe("known delimiter-anchor gap", () => {
	/**
	 * Seven rules inherit gitleaks' trailing delimiter group: the secret must
	 * be followed by a backtick, quote, whitespace, semicolon, a literal \n or
	 * \r escape, or end of input. A URL query's "&" and a directly adjacent
	 * emoji are outside that group, so these secrets survive every pass today.
	 * Pinned as accepted behaviour; these tests fail loudly — flip them to the
	 * redacting corpus — when the ruleset fix lands.
	 */
	test("the derived anchored-rule set matches the four documented rules", () => {
		expect([...DELIMITER_ANCHORED_RULE_IDS].sort()).toEqual([
			"google-api-key",
			"npm-access-token",
			"sendgrid-api-token",
			"stripe-access-token",
		]);
	});

	test("gap cases are exactly the anchored rules in the two unsupported contexts", () => {
		for (const generated of delimiterGapCases) {
			expect(DELIMITER_ANCHORED_RULE_IDS).toContain(generated.ruleId);
			expect(["url-query-param", "emoji-cjk-adjacent"]).toContain(
				generated.contextId,
			);
		}
	});

	for (const generated of delimiterGapCases) {
		test(`${generated.title} passes through unredacted (pinned gap)`, () => {
			expect(filterKnownSecrets(generated.input)).toEqual({
				text: generated.input,
				counts: {},
				redactedBytes: 0,
			});
		});
	}
});

describe("JSON-escaped multi-line private keys", () => {
	test("the corpus covers JSON values and raw JSONL transcript lines", () => {
		expect(
			jsonEscapedPrivateKeyCases.map((generated) => generated.contextId),
		).toEqual(["json-value", "jsonl-transcript-line"]);
	});

	for (const generated of jsonEscapedPrivateKeyCases) {
		test(`${generated.title} redacts the escaped key byte-exactly`, () => {
			expect(filterKnownSecrets(generated.input)).toEqual({
				text: generated.expectedText,
				counts: { "private-key": 1 },
				redactedBytes: getUtf8ByteLength(generated.embedded),
			});
		});
	}
});

describe("density", () => {
	const aws = "AKIACANARY234567ABCD";
	const slackBot = "xoxb-1234567890-1234567890-CANARY";
	const twilio = `SK${"CA".repeat(16)}`;
	const gitlab = `glpat-${"CANARY".padEnd(20, "A")}`;
	const githubPat = `ghp_${"CANARY".padEnd(36, "A")}`;

	test("two different rules on one line both redact with exact counts", () => {
		const input = `AWS_ACCESS_KEY_ID=${aws} SLACK_BOT_TOKEN=${slackBot}`;
		const result = filterKnownSecrets(input);

		expect(result.text).toBe(
			"AWS_ACCESS_KEY_ID=[REDACTED:aws-access-key-id] SLACK_BOT_TOKEN=[REDACTED:slack-bot-token]",
		);
		expect(result.counts).toEqual({
			"aws-access-key-id": 1,
			"slack-bot-token": 1,
		});
		expect(result.redactedBytes).toBe(
			getUtf8ByteLength(aws) + getUtf8ByteLength(slackBot),
		);
	});

	test("six same-rule secrets one character apart all redact", () => {
		const input = Array.from({ length: 6 }, () => twilio).join(" ");
		const result = filterKnownSecrets(input);

		expect(result.text).toBe(
			Array.from({ length: 6 }, () => "[REDACTED:twilio-api-key]").join(" "),
		);
		expect(result.counts).toEqual({ "twilio-api-key": 6 });
		expect(result.redactedBytes).toBe(6 * getUtf8ByteLength(twilio));
	});

	test("back-to-back same-rule secrets redact as two matches", () => {
		const input = `${githubPat}${githubPat}`;
		const result = filterKnownSecrets(input);

		expect(result.text).toBe("[REDACTED:github-pat][REDACTED:github-pat]");
		expect(result.counts).toEqual({ "github-pat": 2 });
		expect(result.redactedBytes).toBe(2 * getUtf8ByteLength(githubPat));
	});

	test("back-to-back different-rule secrets redact without cross-rule bleed", () => {
		const input = `${gitlab}${twilio}`;
		const result = filterKnownSecrets(input);

		expect(result.text).toBe("[REDACTED:gitlab-pat][REDACTED:twilio-api-key]");
		expect(result.counts).toEqual({
			"gitlab-pat": 1,
			"twilio-api-key": 1,
		});
		expect(result.redactedBytes).toBe(
			getUtf8ByteLength(gitlab) + getUtf8ByteLength(twilio),
		);
	});
});

test("the generated corpus covers every canonical secret in every context", () => {
	expect(generatedCases).toHaveLength(
		CANONICAL_SECRETS.length * DELIMITER_CONTEXTS.length,
	);
	expect(
		new Set([...CANONICAL_SECRETS, ...CONTEXTUAL_SECRETS].map((c) => c.ruleId))
			.size,
	).toBe(GENERATED_SECRET_RULES.length);
});
