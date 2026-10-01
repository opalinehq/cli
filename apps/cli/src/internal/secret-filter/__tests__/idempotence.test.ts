import { describe, expect, test } from "bun:test";
import {
	compileSecretRule,
	filterKnownSecretsWithCompiledRules,
} from "../filter.js";
import { GENERATED_SECRET_RULES } from "../generated-rules.js";
import {
	FILTER_VERSION,
	filterKnownSecrets,
	filterSessionTextFields,
	getRedactionCount,
	getUtf8ByteLength,
	MAX_FILTER_PASSES,
	OVERLONG_MATCH_THRESHOLD_BYTES,
	OVERLONG_REDACTION_RULE_ID,
	SecretFilterConvergenceError,
} from "../index.js";
import {
	CANONICAL_SECRETS,
	DELIMITER_ANCHORED_RULE_IDS,
	PRESERVED_CORPUS,
} from "./helpers/rule-corpus.js";

/**
 * One canary per generated rule, without the surrounding assignment context the
 * positive cases carry. Object.fromEntries deliberately collapses Stripe's
 * secret/restricted-key fixtures to one bare value for pairwise combinations.
 */
const CANARIES: Readonly<Record<string, string>> = Object.fromEntries(
	CANONICAL_SECRETS.map((canonical) => [canonical.ruleId, canonical.secret]),
);
const CANARY_IDS = Object.keys(CANARIES);

const getCanary = (ruleId: string): string => {
	const secret = CANARIES[ruleId];
	if (secret === undefined) {
		throw new Error(`Missing canonical canary for rule "${ruleId}"`);
	}
	return secret;
};

const CASCADE_LABELS = ["ONE", "TWO", "THREE", "FOUR", "FIVE"] as const;

function buildConvergenceCascade(ruleCount: number) {
	const labels = CASCADE_LABELS.slice(0, ruleCount);
	const rules = labels.map((label, index) => {
		const nextRuleId = `cascade-${index + 2}`;
		const lookahead =
			index === labels.length - 1 ? "" : `(?=\\[REDACTED:${nextRuleId}\\])`;
		return compileSecretRule({
			id: `cascade-${index + 1}`,
			sourceId: `cascade-${index + 1}`,
			regexSource: `(${label})${lookahead}`,
			caseInsensitive: false,
			secretGroup: 1,
			allowlistRegexSources: [],
		});
	});
	return {
		input: labels.join(""),
		rules,
	};
}

const refilter = (text: string) =>
	filterKnownSecrets(filterKnownSecrets(text).text);

test("every canary is redacted when it stands alone", () => {
	for (const [ruleId, secret] of Object.entries(CANARIES)) {
		const result = filterKnownSecrets(secret);

		expect(result.text).not.toContain(secret);
		expect(result.counts).toEqual({ [ruleId]: 1 });
	}
});

describe("the reported single-pass leak", () => {
	const aws = getCanary("aws-access-key-id");
	const twilio = getCanary("twilio-api-key");
	const input = `${aws}${twilio}`;

	test("redacts both concatenated secrets in one call", () => {
		const result = filterKnownSecrets(input);

		expect(result.text).not.toContain(aws);
		expect(result.text).not.toContain(twilio);
		expect(result.text).toBe(
			"[REDACTED:aws-access-key-id][REDACTED:twilio-api-key]",
		);
	});

	test("counts and bytes accumulate across both passes", () => {
		const result = filterKnownSecrets(input);

		expect(result.counts).toEqual({
			"aws-access-key-id": 1,
			"twilio-api-key": 1,
		});
		expect(result.redactedBytes).toBe(getUtf8ByteLength(input));
	});

	test("one call equals repeated calls", () => {
		const once = filterKnownSecrets(input);
		const twice = filterKnownSecrets(once.text);

		expect(twice.text).toBe(once.text);
		expect(twice.counts).toEqual({});
		expect(twice.redactedBytes).toBe(0);
	});
});

describe("idempotence across every concatenated rule pair", () => {
	test("re-filtering the output never redacts more", () => {
		const unstable: string[] = [];

		for (const left of CANARY_IDS) {
			for (const right of CANARY_IDS) {
				const first = filterKnownSecrets(
					`${getCanary(left)}${getCanary(right)}`,
				);
				const second = filterKnownSecrets(first.text);

				if (second.text !== first.text) {
					unstable.push(`${left}+${right}`);
				}
			}
		}

		expect(unstable).toEqual([]);
	});

	test("no output ever contains a redaction marker plus live secret material", () => {
		for (const left of CANARY_IDS) {
			for (const right of CANARY_IDS) {
				const { text } = filterKnownSecrets(
					`${getCanary(left)}${getCanary(right)}`,
				);

				// Whatever survives must survive because no rule matched it, not
				// because a marker masked the boundary a rule needed.
				expect(filterKnownSecrets(text).counts).toEqual({});
			}
		}
	});
});

describe("idempotence across delimiters and surrounding context", () => {
	const delimiters = [
		"",
		" ",
		"\n",
		"\t",
		'"',
		"'",
		"`",
		",",
		";",
		"=",
		"&",
		")",
		".",
		"\\n",
	];

	test("holds for every canary against every delimiter", () => {
		for (const secret of Object.values(CANARIES)) {
			for (const delimiter of delimiters) {
				for (const shape of [
					`${secret}${delimiter}`,
					`${delimiter}${secret}`,
					`prefix${delimiter}${secret}${delimiter}suffix`,
					`{"k":"${secret}"${delimiter}"n":1}`,
				]) {
					const first = filterKnownSecrets(shape);

					expect(filterKnownSecrets(first.text).text).toBe(first.text);
				}
			}
		}
	});

	test("holds for triples of concatenated secrets", () => {
		for (const a of CANARY_IDS) {
			for (const b of CANARY_IDS) {
				const input = `${getCanary(a)}${getCanary(b)}${getCanary("twilio-api-key")}`;
				const first = filterKnownSecrets(input);

				expect(filterKnownSecrets(first.text).counts).toEqual({});
			}
		}
	});
});

describe("redaction markers are inert", () => {
	const markers = GENERATED_SECRET_RULES.map((rule) => `[REDACTED:${rule.id}]`);

	test("a wall of markers is left byte-identical", () => {
		const input = markers.join("");

		expect(filterKnownSecrets(input)).toEqual({
			text: input,
			counts: {},
			redactedBytes: 0,
		});
	});

	test("markers adjacent to word characters stay inert", () => {
		for (const marker of markers) {
			const input = `abc${marker}def${marker}123`;

			expect(filterKnownSecrets(input).text).toBe(input);
		}
	});
});

describe("the loop introduces no false positives", () => {
	test("preserves benign content sitting next to a redacted secret", () => {
		for (const [, benign] of PRESERVED_CORPUS) {
			const input = `${benign} ${getCanary("aws-access-key-id")} ${benign}`;
			const { text } = filterKnownSecrets(input);

			expect(text).toBe(`${benign} [REDACTED:aws-access-key-id] ${benign}`);
		}
	});
});

describe("byte accounting stays honest across passes", () => {
	test("never counts a byte the input did not contain", () => {
		for (const left of CANARY_IDS) {
			for (const right of CANARY_IDS) {
				const input = `${getCanary(left)}${getCanary(right)}`;
				const result = filterKnownSecrets(input);

				expect(result.redactedBytes).toBeLessThanOrEqual(
					getUtf8ByteLength(input),
				);
			}
		}
	});

	test("accumulated bytes equal the material actually removed", () => {
		const aws = getCanary("aws-access-key-id");
		const twilio = getCanary("twilio-api-key");
		const input = `head ${aws}${twilio} tail`;
		const result = filterKnownSecrets(input);

		expect(result.redactedBytes).toBe(
			getUtf8ByteLength(aws) + getUtf8ByteLength(twilio),
		);
		expect(getRedactionCount(result.counts)).toBe(2);
	});

	test("multi-pass redaction still reports a usable budget ratio", () => {
		const aws = getCanary("aws-access-key-id");
		const twilio = getCanary("twilio-api-key");
		const input = `${aws}${twilio}`;
		const result = filterKnownSecrets(input);

		// Everything was secret, so the ratio must read as 100% rather than the
		// ~63% a single pass would have reported.
		expect(result.redactedBytes / getUtf8ByteLength(input)).toBe(1);
	});
});

describe("termination", () => {
	test("converges well inside the pass ceiling", () => {
		const chain = CANARY_IDS.map(getCanary).join("");
		let text = filterKnownSecrets(chain).text;
		let extraPasses = 0;

		while (extraPasses < MAX_FILTER_PASSES * 4) {
			const next = filterKnownSecrets(text);
			if (next.text === text) {
				break;
			}
			text = next.text;
			extraPasses += 1;
		}

		// filterKnownSecrets loops internally, so the first call must already have
		// landed on the fixpoint and no later call may find anything to do.
		expect(extraPasses).toBe(0);
	});

	test("a long alternating chain reaches a fixpoint in one call", () => {
		const input = Array.from(
			{ length: 200 },
			() => `${getCanary("aws-access-key-id")}${getCanary("twilio-api-key")}`,
		).join("");
		const result = filterKnownSecrets(input);

		expect(result.text).not.toContain(getCanary("aws-access-key-id"));
		expect(result.text).not.toContain(getCanary("twilio-api-key"));
		expect(result.counts).toEqual({
			"aws-access-key-id": 200,
			"twilio-api-key": 200,
		});
		expect(filterKnownSecrets(result.text).counts).toEqual({});
	});

	test("the pass ceiling is headroom, not a silent truncation point", () => {
		// Exhaustive search over concatenated triples and quads puts the deepest
		// chain this ruleset can produce at two redacting passes. If a ruleset
		// change pushes real convergence past MAX_FILTER_PASSES, filterKnownSecrets
		// would start returning partially filtered text, so pin the headroom here.
		let deepest = 0;

		for (const left of CANARY_IDS) {
			for (const right of CANARY_IDS) {
				for (const trailing of ["", " ", '"', ","]) {
					let text = `${getCanary(left)}${getCanary(right)}${trailing}`;
					let passes = 0;

					// Drive one rule fold at a time by re-entering the filter, which
					// short-circuits after its own first clean pass.
					while (passes <= MAX_FILTER_PASSES) {
						const next = filterKnownSecrets(text);
						if (next.text === text) {
							break;
						}
						text = next.text;
						passes += 1;
					}

					deepest = Math.max(deepest, passes);
				}
			}
		}

		// One call absorbs the whole chain, so re-entry never finds more work.
		expect(deepest).toBe(1);
		expect(MAX_FILTER_PASSES).toBeGreaterThanOrEqual(4);
	});

	test("four changing passes succeed only after a clean confirmation", () => {
		const cascade = buildConvergenceCascade(MAX_FILTER_PASSES);
		const result = filterKnownSecretsWithCompiledRules(
			cascade.input,
			cascade.rules,
		);

		expect(result.counts).toEqual({
			"cascade-1": 1,
			"cascade-2": 1,
			"cascade-3": 1,
			"cascade-4": 1,
		});
		expect(
			filterKnownSecretsWithCompiledRules(result.text, cascade.rules).counts,
		).toEqual({});
	});

	test("rejects output that still changes after four redacting passes", () => {
		const cascade = buildConvergenceCascade(MAX_FILTER_PASSES + 1);

		expect(() =>
			filterKnownSecretsWithCompiledRules(cascade.input, cascade.rules),
		).toThrow(SecretFilterConvergenceError);
		expect(() =>
			filterKnownSecretsWithCompiledRules(cascade.input, cascade.rules),
		).toThrow(
			"Known-pattern redaction did not converge within the safety limit.",
		);
	});

	test("overlong private keys fully redact and remain stable", () => {
		const input = `-----BEGIN PRIVATE KEY-----\n${"A".repeat(
			OVERLONG_MATCH_THRESHOLD_BYTES * 2,
		)}\n-----END PRIVATE KEY-----`;
		const first = filterKnownSecrets(input);

		expect(first.text).not.toBe(input);
		expect(first.text).toContain("[REDACTED:private-key]");
		expect(first.text).not.toContain("-----BEGIN PRIVATE KEY-----");
		expect(first.text).not.toContain("-----END PRIVATE KEY-----");
		expect(first.counts).toEqual({
			"private-key": 1,
			[OVERLONG_REDACTION_RULE_ID]: 1,
		});
		expect(first.redactedBytes).toBe(getUtf8ByteLength(input));
		expect(filterKnownSecrets(first.text)).toEqual({
			text: first.text,
			counts: {},
			redactedBytes: 0,
		});
	});
});

describe("filterSessionTextFields inherits the fixpoint", () => {
	const aws = getCanary("aws-access-key-id");
	const twilio = getCanary("twilio-api-key");

	test("filters concatenated secrets in content and every subagent", () => {
		const result = filterSessionTextFields({
			content: `${aws}${twilio}`,
			subagents: [
				{ agentId: "agent-1", content: `${twilio}${aws}`, rank: 1 },
				{ agentId: "agent-2", content: "benign", rank: 2 },
			],
		});

		expect(result.content).not.toContain(aws);
		expect(result.content).not.toContain(twilio);
		expect(result.subagents?.[0]?.content).not.toContain(aws);
		expect(result.subagents?.[0]?.content).not.toContain(twilio);
		expect(result.subagents?.[1]?.content).toBe("benign");
		expect(result.counts).toEqual({
			"aws-access-key-id": 2,
			"twilio-api-key": 2,
		});
	});

	test("re-filtering an already filtered session is a no-op", () => {
		const first = filterSessionTextFields({
			content: `${aws}${twilio}`,
			subagents: [{ agentId: "agent-1", content: `${twilio}${aws}`, rank: 1 }],
		});
		const second = filterSessionTextFields({
			content: first.content,
			subagents: first.subagents,
		});

		expect(second.content).toBe(first.content);
		expect(second.subagents).toEqual(first.subagents);
		expect(second.counts).toEqual({});
		expect(second.redactedBytes).toBe(0);
	});
});

describe("upload paths converge", () => {
	test("client-then-server filtering matches server-only filtering", () => {
		for (const left of CANARY_IDS) {
			for (const right of CANARY_IDS) {
				const raw = `${getCanary(left)}${getCanary(right)}`;

				// Current CLI: filters locally, API filters the result again.
				const clientThenServer = refilter(raw).text;
				// Older CLI (0.1.17): uploads raw, API filters exactly once.
				const serverOnly = filterKnownSecrets(raw).text;

				expect(serverOnly).toBe(clientThenServer);
			}
		}
	});
});

describe("fuzz", () => {
	/** Seeded so failures reproduce. */
	const createRandom = (seed: number) => {
		let state = seed;
		return () => {
			state = (state * 1664525 + 1013904223) >>> 0;
			return state / 0x100000000;
		};
	};

	const FILLERS = [
		"",
		" ",
		"\n",
		"\t",
		'"',
		"'",
		"`",
		",",
		";",
		"=",
		"&",
		")",
		".",
		"\\n",
		"{",
		"}",
		"[",
		"]",
		"://",
		"key=",
		"héllo",
		"日本語",
		"🔑",
		"aGVsbG8=",
		"0123456789abcdef",
		"-----BEGIN",
		"[REDACTED:aws-access-key-id]",
	];

	test("2000 random transcripts are all fixpoints after one call", () => {
		const random = createRandom(0x5eed);
		const pick = <T>(items: readonly T[]): T =>
			items[Math.floor(random() * items.length)] as T;

		for (let iteration = 0; iteration < 2000; iteration += 1) {
			const parts: string[] = [];
			const partCount = 1 + Math.floor(random() * 8);

			for (let part = 0; part < partCount; part += 1) {
				parts.push(pick(FILLERS));
				if (random() < 0.6) {
					parts.push(getCanary(pick(CANARY_IDS)));
				}
			}

			const input = parts.join("");
			const first = filterKnownSecrets(input);
			const second = filterKnownSecrets(first.text);

			// The invariant: one call is enough, whatever the surrounding shape.
			if (second.text !== first.text) {
				throw new Error(
					`not a fixpoint (iteration ${iteration}): ${JSON.stringify(input)}`,
				);
			}
			expect(second.counts).toEqual({});
			expect(first.redactedBytes).toBeLessThanOrEqual(getUtf8ByteLength(input));
		}
	});

	test("never emits a partial redaction marker", () => {
		const random = createRandom(0xc0ffee);
		const pick = <T>(items: readonly T[]): T =>
			items[Math.floor(random() * items.length)] as T;

		for (let iteration = 0; iteration < 500; iteration += 1) {
			const input = Array.from({ length: 6 }, () =>
				random() < 0.5 ? pick(FILLERS) : getCanary(pick(CANARY_IDS)),
			).join("");
			const { text } = filterKnownSecrets(input);

			// Every marker that appears must be well formed and name a real rule.
			for (const marker of text.matchAll(/\[REDACTED:([a-z0-9-]*)\]/gu)) {
				const ruleId = marker[1] as string;
				const known =
					ruleId === OVERLONG_REDACTION_RULE_ID ||
					GENERATED_SECRET_RULES.some((rule) => rule.id === ruleId);

				expect(known).toBe(true);
			}
		}
	});
});

describe("multi-byte accounting", () => {
	test("counts UTF-8 bytes, not code units, around redactions", () => {
		const aws = getCanary("aws-access-key-id");
		const input = `日本語 ${aws} 🔑`;
		const result = filterKnownSecrets(input);

		expect(result.text).toBe("日本語 [REDACTED:aws-access-key-id] 🔑");
		expect(result.redactedBytes).toBe(getUtf8ByteLength(aws));
	});

	test("multi-byte neighbours do not block a multi-pass redaction", () => {
		const aws = getCanary("aws-access-key-id");
		const twilio = getCanary("twilio-api-key");
		const input = `🔑${aws}${twilio}🔑`;
		const result = filterKnownSecrets(input);

		expect(result.text).toBe(
			"🔑[REDACTED:aws-access-key-id][REDACTED:twilio-api-key]🔑",
		);
		expect(result.redactedBytes).toBe(
			getUtf8ByteLength(aws) + getUtf8ByteLength(twilio),
		);
	});
});

describe("known gap: rules anchored on a trailing delimiter", () => {
	/**
	 * Seven rules require the secret to be followed by a backtick, quote,
	 * whitespace, semicolon, an escaped newline, or end-of-string. Ordinary
	 * punctuation does not qualify, so these secrets survive every pass. The
	 * fixpoint loop cannot help: nothing matches on any pass, so there is no
	 * marker to create the delimiter. Closing this needs a ruleset change.
	 *
	 * These assertions pin current behaviour so the gap cannot widen silently,
	 * and they will fail loudly when the ruleset fix lands.
	 */
	test("a trailing comma defeats them", () => {
		for (const ruleId of DELIMITER_ANCHORED_RULE_IDS) {
			const secret = getCanary(ruleId);

			expect(filterKnownSecrets(`k=${secret},next=1`).text).toContain(secret);
		}
	});

	test("a secret in a URL query string survives", () => {
		const secret = getCanary("google-api-key");

		expect(
			filterKnownSecrets(`https://maps.example.dev/api?key=${secret}&z=1`).text,
		).toContain(secret);
	});

	test("but they are still caught with a supported delimiter", () => {
		for (const ruleId of DELIMITER_ANCHORED_RULE_IDS) {
			const secret = getCanary(ruleId);

			expect(filterKnownSecrets(`k="${secret}"`).text).not.toContain(secret);
			expect(filterKnownSecrets(`k=${secret}\n`).text).not.toContain(secret);
			expect(filterKnownSecrets(`k=${secret}`).text).not.toContain(secret);
		}
	});
});

describe("filter provenance", () => {
	/**
	 * filter_version travels with every upload and is hashed into the ingest
	 * content hash, so it identifies which filter produced a stored transcript.
	 * Any change to filter output must bump it -- the 1 -> 2 bump in
	 * "fix: bound transcript redaction failures" set that precedent.
	 *
	 * This fingerprint covers the filter's observable output over a fixed corpus.
	 * If it changes, the filter behaves differently: bump FILTER_VERSION, update
	 * the filter_version assertions in apps/cli's integration suite, then update
	 * this constant.
	 */
	const OUTPUT_FINGERPRINT =
		"65e401d93304a6614b1614a7b7170e94984e86cb21cf2e3b1d2aaf7adf9230bb";

	test("output fingerprint matches the declared FILTER_VERSION", () => {
		const corpus = [
			...CANARY_IDS.map(getCanary),
			...CANARY_IDS.map(
				(id) => `${getCanary(id)}${getCanary("twilio-api-key")}`,
			),
			...CANARY_IDS.map((id) => `k="${getCanary(id)}", next=1`),
			JSON.stringify({ key: getCanary("private-key") }),
			`xoxb-1234567890-1234567890-${"A".repeat(
				OVERLONG_MATCH_THRESHOLD_BYTES,
			)}`,
			...PRESERVED_CORPUS.map(([, text]) => text),
		];
		const digest = new Bun.CryptoHasher("sha256");
		for (const entry of corpus) {
			const result = filterKnownSecrets(entry);
			digest.update(
				`${result.text} ${JSON.stringify(result.counts)} ${result.redactedBytes}`,
			);
		}

		expect(FILTER_VERSION).toBe(6);
		expect(digest.digest("hex")).toBe(OUTPUT_FINGERPRINT);
	});
});
