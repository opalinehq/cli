import { existsSync, readFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { exec } from "./exec.js";

export interface GitInfo {
	repositoryRoot?: string;
	gitRemote?: string;
	packageName?: string;
	packageType?: string;
	branch?: string;
	sha?: string;
}

/**
 * Normalize a git remote URL to a canonical form: "github.com/owner/repo"
 */
export function normalizeRemoteUrl(url: string): string {
	const sanitizedUrl = url.replace(/^([a-z][a-z\d+.-]*:\/\/)[^/]+@/i, "$1");
	return sanitizedUrl
		.replace(/^(https?:\/\/|git@|ssh:\/\/)/, "")
		.replace(/:/, "/")
		.replace(/\.git$/, "");
}

/**
 * Extract git metadata for a given project directory.
 */
export async function getGitInfo(cwd: string): Promise<GitInfo> {
	const repositoryRoot = await getRepositoryRoot(cwd);
	const [remoteUrl, branch, sha, packageInfo] = await Promise.all([
		getGitRemoteUrl(repositoryRoot ?? cwd),
		getGitBranch(cwd),
		getGitSha(cwd),
		getPackageInfo(repositoryRoot ?? cwd),
	]);

	const gitRemote = remoteUrl ? normalizeRemoteUrl(remoteUrl) : undefined;

	return {
		repositoryRoot,
		gitRemote,
		packageName: packageInfo?.name,
		packageType: packageInfo?.type,
		branch: branch ?? undefined,
		sha: sha ?? undefined,
	};
}

async function getRepositoryRoot(cwd: string): Promise<string | undefined> {
	let directory = resolve(cwd);
	while (!(await stat(directory).catch(() => null))?.isDirectory()) {
		const parent = dirname(directory);
		if (parent === directory) return undefined;
		directory = parent;
	}
	const result = await exec("git", [
		"-C",
		directory,
		"rev-parse",
		"--path-format=absolute",
		"--git-common-dir",
		"--show-toplevel",
	]);
	if (result.exitCode !== 0) return undefined;
	const [commonDirectory, worktreeRoot] = result.stdout.trim().split("\n");
	if (!commonDirectory || !worktreeRoot) return undefined;
	return basename(commonDirectory) === ".git"
		? dirname(commonDirectory)
		: worktreeRoot;
}

interface PackageInfo {
	name: string;
	type: string;
}

async function getPackageInfo(cwd: string): Promise<PackageInfo | null> {
	try {
		const result = await exec("git", [
			"-C",
			cwd,
			"rev-parse",
			"--show-toplevel",
		]);
		const root = result.exitCode === 0 ? result.stdout.trim() : cwd;

		return (
			getNodePackage(root) ??
			getPythonPackage(root) ??
			getRustPackage(root) ??
			getGoModule(root)
		);
	} catch {
		return null;
	}
}

function getNodePackage(root: string): PackageInfo | null {
	try {
		const filePath = join(root, "package.json");
		if (!existsSync(filePath)) return null;
		const pkg = JSON.parse(readFileSync(filePath, "utf-8"));
		return pkg.name ? { name: pkg.name, type: "package.json" } : null;
	} catch {
		return null;
	}
}

function getPythonPackage(root: string): PackageInfo | null {
	try {
		const filePath = join(root, "pyproject.toml");
		if (!existsSync(filePath)) return null;
		const content = readFileSync(filePath, "utf-8");
		const name = content.match(/^\s*name\s*=\s*"([^"]+)"/m)?.[1];
		return name ? { name, type: "pyproject.toml" } : null;
	} catch {
		return null;
	}
}

function getRustPackage(root: string): PackageInfo | null {
	try {
		const filePath = join(root, "Cargo.toml");
		if (!existsSync(filePath)) return null;
		const content = readFileSync(filePath, "utf-8");
		const name = content.match(/^\s*name\s*=\s*"([^"]+)"/m)?.[1];
		return name ? { name, type: "Cargo.toml" } : null;
	} catch {
		return null;
	}
}

function getGoModule(root: string): PackageInfo | null {
	try {
		const filePath = join(root, "go.mod");
		if (!existsSync(filePath)) return null;
		const content = readFileSync(filePath, "utf-8");
		const name = content.match(/^module\s+(\S+)/m)?.[1];
		return name ? { name, type: "go.mod" } : null;
	} catch {
		return null;
	}
}

export async function getGitRemoteUrl(cwd: string): Promise<string | null> {
	try {
		const result = await exec("git", [
			"-C",
			cwd,
			"remote",
			"get-url",
			"origin",
		]);
		if (result.exitCode !== 0) return null;
		return result.stdout.trim() || null;
	} catch {
		return null;
	}
}

async function getGitBranch(cwd: string): Promise<string | null> {
	try {
		const result = await exec("git", [
			"-C",
			cwd,
			"rev-parse",
			"--abbrev-ref",
			"HEAD",
		]);
		if (result.exitCode !== 0) return null;
		return result.stdout.trim();
	} catch {
		return null;
	}
}

async function getGitSha(cwd: string): Promise<string | null> {
	try {
		const result = await exec("git", ["-C", cwd, "rev-parse", "HEAD"]);
		if (result.exitCode !== 0) return null;
		return result.stdout.trim();
	} catch {
		return null;
	}
}
