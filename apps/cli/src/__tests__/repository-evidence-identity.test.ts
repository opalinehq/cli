import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveRepositoryEvidenceLocalIdentity } from "../lib/repository-evidence-identity.js";

const tempRoot = await mkdtemp(join(tmpdir(), "opaline-evidence-identity-"));

afterAll(async () => {
	await rm(tempRoot, { force: true, recursive: true });
});

describe("repository evidence local identity", () => {
	test("joins linked worktrees to one repository while keeping worktrees distinct", async () => {
		const repositoryRoot = join(tempRoot, "repository");
		const linkedWorktree = join(tempRoot, "linked-worktree");
		await mkdir(repositoryRoot, { recursive: true });
		git(repositoryRoot, ["init", "--quiet"]);
		git(repositoryRoot, ["config", "user.name", "Opaline Test"]);
		git(repositoryRoot, [
			"config",
			"user.email",
			"opaline-test@example.invalid",
		]);
		await writeFile(join(repositoryRoot, "README.md"), "# Fixture\n", "utf8");
		git(repositoryRoot, ["add", "README.md"]);
		git(repositoryRoot, ["commit", "--quiet", "-m", "fixture"]);
		git(repositoryRoot, [
			"worktree",
			"add",
			"--quiet",
			"-b",
			"identity-test",
			linkedWorktree,
		]);

		const installationId = "00000000-0000-4000-8000-000000000201";
		const [main, repeated, linked, otherInstallation] = await Promise.all([
			resolveRepositoryEvidenceLocalIdentity(repositoryRoot, installationId),
			resolveRepositoryEvidenceLocalIdentity(repositoryRoot, installationId),
			resolveRepositoryEvidenceLocalIdentity(linkedWorktree, installationId),
			resolveRepositoryEvidenceLocalIdentity(
				repositoryRoot,
				"00000000-0000-4000-8000-000000000202",
			),
		]);

		expect(repeated).toEqual(main);
		expect(linked.repositoryId).toBe(main.repositoryId);
		expect(linked.worktreeId).not.toBe(main.worktreeId);
		expect(otherInstallation.repositoryId).not.toBe(main.repositoryId);
		expect(JSON.stringify({ main, linked })).not.toContain(tempRoot);
	});
});

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
