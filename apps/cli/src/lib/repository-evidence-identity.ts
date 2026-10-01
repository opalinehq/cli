import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import type { RepositoryEvidenceLocalIdentity } from "../contracts/index.js";
import { exec } from "./exec.js";

export async function resolveRepositoryEvidenceLocalIdentity(
	repositoryRoot: string,
	installationId: string,
): Promise<RepositoryEvidenceLocalIdentity> {
	if (installationId.trim().length === 0) {
		throw new Error("CLI installation ID cannot be empty.");
	}
	const [commonDirectoryResult, gitDirectoryResult] = await Promise.all([
		exec("git", [
			"-C",
			repositoryRoot,
			"rev-parse",
			"--path-format=absolute",
			"--git-common-dir",
		]),
		exec("git", [
			"-C",
			repositoryRoot,
			"rev-parse",
			"--path-format=absolute",
			"--git-dir",
		]),
	]);
	if (commonDirectoryResult.exitCode !== 0) {
		throw new Error(
			commonDirectoryResult.stderr.trim() ||
				"Could not resolve the Git common directory.",
		);
	}
	if (gitDirectoryResult.exitCode !== 0) {
		throw new Error(
			gitDirectoryResult.stderr.trim() ||
				"Could not resolve the Git directory.",
		);
	}

	const commonDirectory = await realpath(commonDirectoryResult.stdout.trim());
	const gitDirectory = await realpath(gitDirectoryResult.stdout.trim());
	const repositoryId = createPrivateIdentity(
		"local-repository",
		installationId,
		commonDirectory,
	);
	const worktreePath = getStableWorktreePath(commonDirectory, gitDirectory);
	return {
		installationId,
		repositoryId,
		worktreeId: createPrivateIdentity(
			"local-worktree",
			installationId,
			`${repositoryId}\u0000${worktreePath}`,
		),
	};
}

function getStableWorktreePath(
	commonDirectory: string,
	gitDirectory: string,
): string {
	const relativeGitDirectory = relative(commonDirectory, gitDirectory);
	const isWithinCommonDirectory =
		relativeGitDirectory === "" ||
		(relativeGitDirectory !== ".." &&
			!relativeGitDirectory.startsWith(`..${sep}`) &&
			!isAbsolute(relativeGitDirectory));
	return isWithinCommonDirectory
		? relativeGitDirectory.split(sep).join("/") || "."
		: gitDirectory;
}

function createPrivateIdentity(
	kind: "local-repository" | "local-worktree",
	installationId: string,
	value: string,
): string {
	const digest = createHash("sha256")
		.update(`${kind}\u0000${installationId}\u0000${value}`)
		.digest("hex");
	return `${kind}:${digest}`;
}
