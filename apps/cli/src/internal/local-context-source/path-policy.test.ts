import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SAFE_DIFF_PATHSPEC } from "./git-collector.js";
import { getPathExclusion, isHighRiskContentPath } from "./path-policy.js";

const PATHSPEC_PREFIX = ":(exclude,icase,glob)**/";
const HIGH_RISK_FIXTURE_PATHS = [
	".env",
	".envrc",
	".dev.vars",
	"config/production.tfvars",
	"state/terraform.tfstate",
	"secrets.json",
	"nested/secrets.yaml",
	".aws/credentials",
	"nested/.aws/profiles/credentials",
	"nested/.AWS/CREDENTIALS",
	".pgpass",
	".git-credentials",
	".htpasswd",
	"nested/release.keystore",
	"nested/release.jks",
];

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

	test.each(HIGH_RISK_FIXTURE_PATHS)("classifies %s as high risk", (path) => {
		expect(isHighRiskContentPath(path)).toBe(true);
		expect(isHighRiskContentPath(`nested/${path.toUpperCase()}`)).toBe(true);
	});

	test("only treats a credentials basename inside an .aws segment as high risk", () => {
		for (const path of [
			"credentials",
			"nested/credentials",
			"aws/credentials",
			"not.aws/credentials",
			".aws/config",
			".aws/credentials.md",
			"secrets",
			"not-secrets.json",
			"infra/main.tf",
		]) {
			expect(isHighRiskContentPath(path)).toBe(false);
		}
	});

	test("git excludes high-risk files from staged and working-tree diffs at every depth", () => {
		const directory = mkdtempSync(join(tmpdir(), "opaline-pathspec-"));
		const safePaths = [
			"README.md",
			"credentials",
			".aws/config",
			"aws/credentials",
		];
		const paths = [...safePaths, ...HIGH_RISK_FIXTURE_PATHS];
		try {
			for (const path of paths) {
				mkdirSync(dirname(join(directory, path)), { recursive: true });
				writeFileSync(join(directory, path), `Original ${path}\n`);
			}
			execFileSync("git", ["init", "-q"], { cwd: directory });
			execFileSync("git", ["add", "."], { cwd: directory });
			for (const path of paths) {
				writeFileSync(join(directory, path), `Changed ${path}\n`);
			}
			for (const diffArgs of [["--cached"], []]) {
				const output = execFileSync(
					"git",
					["diff", ...diffArgs, "--name-only", "--", ...SAFE_DIFF_PATHSPEC],
					{ cwd: directory, encoding: "utf8" },
				);
				expect(output.trim().split("\n").sort()).toEqual([...safePaths].sort());
			}
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});

describe("dependency, generated and cache path exclusions", () => {
	test.each([
		[".venv", "dependency"],
		["venv", "dependency"],
		[".wrangler", "generated"],
		["__pycache__", "cache"],
		[".terraform", "cache"],
		[".gradle", "cache"],
		[".mypy_cache", "cache"],
		[".pytest_cache", "cache"],
		[".parcel-cache", "cache"],
	])("excludes %s directories as %s", (segment, reason) => {
		for (const path of [
			segment,
			`${segment}/file.md`,
			`nested/${segment}/file.md`,
		]) {
			expect(getPathExclusion(path, [])).toEqual({ excluded: true, reason });
		}
		expect(getPathExclusion(`${segment}-source/file.md`, []).excluded).toBe(
			false,
		);
	});
});
