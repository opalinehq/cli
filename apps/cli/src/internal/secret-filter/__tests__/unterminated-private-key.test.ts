import { describe, expect, test } from "bun:test";
import { filterKnownSecrets } from "../index.js";

const HEADER = "-----BEGIN PRIVATE KEY-----";
const FOOTER = "-----END PRIVATE KEY-----";
const BODY_LINES = [
	"MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj",
	"MzEfYyjiWA4R4/M2bS1GB4t7NXp98C3SC6dVMvDuictGeurT8jNbvJZHtCSuYEvu",
	"NMoSfm76oqFvAp8Gy0iz5sxjZmSnXyCPykcqXjkyl4ddZTHlTGt4S28rW4cX4Ht5",
];
const BODY = BODY_LINES.join("\n");

describe("unterminated private-key blocks", () => {
	test("redacts a header and full body whose footer is missing", () => {
		const input = `${HEADER}\n${BODY}\n`;
		const result = filterKnownSecrets(input);

		expect(result.text).toBe("[REDACTED:private-key]");
		expect(result.counts).toEqual({ "private-key": 1 });
		expect(result.redactedBytes).toBe(input.length);
	});

	test("redacts a body that is cut in the middle of a line", () => {
		const cut = `${HEADER}\n${BODY_LINES[0]}\n${BODY_LINES[1]?.slice(0, 20)}`;
		const result = filterKnownSecrets(`step output\n${cut}`);

		expect(result.text).toBe("step output\n[REDACTED:private-key]");
	});

	test("redacts a body that is cut inside the footer", () => {
		const result = filterKnownSecrets(`${HEADER}\n${BODY}\n-----END PRIVATE K`);

		expect(result.text).toBe("[REDACTED:private-key]");
	});

	test("redacts a JSON-escaped body that ends with a dangling backslash", () => {
		const escaped = `${HEADER}\\n${BODY_LINES.join("\\n")}\\`;
		const result = filterKnownSecrets(escaped);

		expect(result.text).toBe("[REDACTED:private-key]");
	});

	test("redacts a header with a short body that runs to end of input", () => {
		const result = filterKnownSecrets(`${HEADER}\nMIIEvQIBADANBgkqhkiG9w0B`);

		expect(result.text).toBe("[REDACTED:private-key]");
	});

	test("still redacts a complete block once and keeps the trailing text", () => {
		const result = filterKnownSecrets(
			`before\n${HEADER}\n${BODY}\n${FOOTER}\nafter`,
		);

		expect(result.text).toBe("before\n[REDACTED:private-key]\nafter");
		expect(result.counts).toEqual({ "private-key": 1 });
	});

	test("redacts a complete block that sits exactly at the end of input", () => {
		const result = filterKnownSecrets(`${HEADER}\n${BODY}\n${FOOTER}`);

		expect(result.text).toBe("[REDACTED:private-key]");
		expect(result.counts).toEqual({ "private-key": 1 });
	});

	test("leaves a header mentioned inside surrounding prose untouched", () => {
		const input = `{"text":"A ${HEADER} line opens a PEM block."}`;

		expect(filterKnownSecrets(input)).toEqual({
			text: input,
			counts: {},
			redactedBytes: 0,
		});
	});

	test("is a fixpoint after one pass", () => {
		const once = filterKnownSecrets(`${HEADER}\n${BODY}`);
		const twice = filterKnownSecrets(once.text);

		expect(twice.text).toBe(once.text);
		expect(twice.counts).toEqual({});
	});
});
