import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	collectSessionRepositoryContext,
	resolveRepositoryContext,
} from "../lib/repo-context.js";

const tempRoot = await mkdtemp(join(tmpdir(), "opaline-repo-context-"));
const originalConfigDir = process.env.OPALINE_CONFIG_DIR;
const originalHome = process.env.HOME;

afterEach(() => {
	setOptionalEnvironment("OPALINE_CONFIG_DIR", originalConfigDir);
	setOptionalEnvironment("HOME", originalHome);
});

afterAll(async () => {
	await rm(tempRoot, { recursive: true, force: true });
});

describe("repository context privacy", () => {
	test("excludes an in-repository CLI config spool from session capture", async () => {
		const repositoryRoot = await createRepository("in-repo-config-repository");
		const configDir = join(repositoryRoot, ".context", "rudel-local-cli");
		const home = join(tempRoot, "empty-home");
		await Promise.all([
			mkdir(configDir, { recursive: true }),
			mkdir(home, { recursive: true }),
		]);
		process.env.OPALINE_CONFIG_DIR = configDir;
		process.env.HOME = home;

		const capture = await collectSessionRepositoryContext({
			accountId: "account",
			endpoint: "https://opaline.example",
			lifecycle: "checkpoint",
			organizationId: "workspace",
			repositoryPath: repositoryRoot,
		});

		expect(capture.bundle.manifest.coverage.excludedPaths).toContainEqual({
			rootId: "repository",
			path: ".context/rudel-local-cli",
			reason: "explicit",
		});
		expect(
			capture.bundle.manifest.entries.some((entry) =>
				entry.path.startsWith(".context/rudel-local-cli/"),
			),
		).toBe(false);
	}, 15_000);

	test("rejects the repository root as the CLI config directory", async () => {
		const repositoryRoot = await createRepository("root-config-repository");
		process.env.OPALINE_CONFIG_DIR = repositoryRoot;

		await expect(resolveRepositoryContext(repositoryRoot)).rejects.toThrow(
			"cannot be the repository root",
		);
	});
});

async function createRepository(name: string): Promise<string> {
	const repositoryRoot = join(tempRoot, name);
	await mkdir(repositoryRoot, { recursive: true });
	git(repositoryRoot, ["init", "--quiet"]);
	git(repositoryRoot, ["config", "user.name", "Opaline Test"]);
	git(repositoryRoot, ["config", "user.email", "opaline-test@example.invalid"]);
	await writeFile(
		join(repositoryRoot, "context.md"),
		"stable context\n",
		"utf8",
	);
	git(repositoryRoot, ["add", "context.md"]);
	git(repositoryRoot, ["commit", "--quiet", "-m", "fixture"]);
	return repositoryRoot;
}

function git(repositoryRoot: string, args: readonly string[]): void {
	const result = spawnSync("git", args, {
		cwd: repositoryRoot,
		encoding: "utf8",
		env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
	});
	if (result.status !== 0) {
		throw new Error(`Git fixture command failed: ${result.stderr}`);
	}
}

function setOptionalEnvironment(name: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[name];
	} else {
		process.env[name] = value;
	}
}
