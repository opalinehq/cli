import { describe, expect, test } from "bun:test";
import { SAFE_DIFF_PATHSPEC } from "./git-collector.js";
import { isHighRiskContentPath } from "./path-policy.js";

const PATHSPEC_PREFIX = ":(exclude,icase,glob)**/";

describe("high-risk credential paths", () => {
	test("every git diff exclusion pathspec is classified as high risk", () => {
		const patterns = SAFE_DIFF_PATHSPEC.filter((entry) =>
			entry.startsWith(PATHSPEC_PREFIX),
		).map((entry) => entry.slice(PATHSPEC_PREFIX.length));

		expect(patterns.length).toBe(SAFE_DIFF_PATHSPEC.length - 1);
		for (const pattern of patterns) {
			const name = pattern.replaceAll("*", "sample-value");
			expect(isHighRiskContentPath(`nested/dir/${name}`)).toBe(true);
			expect(isHighRiskContentPath(`nested/dir/${name.toUpperCase()}`)).toBe(
				true,
			);
		}
	});

	test("excludes template env files that can contain uncommitted credentials", () => {
		expect(isHighRiskContentPath("config/.env.example")).toBe(true);
		expect(isHighRiskContentPath("config/.env.sample")).toBe(true);
		expect(isHighRiskContentPath("config/.env.template")).toBe(true);
	});
});
