import { afterAll, expect, test } from "bun:test";
import {
	mkdir,
	mkdtemp,
	realpath,
	rm,
	symlink,
	utimes,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ScannedProject } from "../internal/agent-adapters/index.js";
import {
	readJsonlFirstLine,
	readSessionDiscoveryMetadata,
} from "../internal/agent-adapters/utils.js";
import { exec } from "../lib/exec.js";
import {
	discoverProjectRepositories,
	resolveUploadRepositoryIdentity,
} from "../lib/repository-discovery.js";
import {
	getRepositoryLastActivity,
	getRepositorySessionCount,
	groupUploadProjectsByRepository,
	orderUploadRepositoriesForSelection,
} from "../lib/upload-reconciliation.js";

const tempRoot = await realpath(
	await mkdtemp(join(tmpdir(), "opaline-repository-discovery-")),
);
afterAll(() => rm(tempRoot, { recursive: true, force: true }));

async function git(...args: string[]) {
	const result = await exec("git", args);
	expect(result.exitCode, result.stderr).toBe(0);
}

async function createRepo(name: string) {
	const root = join(tempRoot, name);
	await mkdir(root, { recursive: true });
	await git("init", root);
	await git(
		"-C",
		root,
		"-c",
		"user.name=Test",
		"-c",
		"user.email=test@example.test",
		"commit",
		"--allow-empty",
		"-m",
		"Initial",
	);
	return root;
}

test("groups subdirectories, arbitrary worktrees and deleted registered worktrees at their main repo", async () => {
	const root = await createRepo("main-repo");
	const nested = join(root, "packages", "web");
	await mkdir(nested, { recursive: true });
	const worktree = join(tempRoot, "temporary-checkout");
	await git("-C", root, "worktree", "add", "--detach", worktree);
	const deleted = join(tempRoot, "removed-checkout");
	await git("-C", root, "worktree", "add", "--detach", deleted);
	await rm(deleted, { recursive: true });
	const alias = join(tempRoot, "alias");
	await symlink(tempRoot, alias);
	const paths = [
		root,
		nested,
		worktree,
		join(deleted, "subdir"),
		join(alias, "removed-checkout", "subdir"),
	];
	const info = await discoverProjectRepositories(paths);
	for (const path of paths) {
		expect(info.get(path)?.repositoryRoot).toBe(root);
		expect(resolveUploadRepositoryIdentity(path, info.get(path) ?? {})).toEqual(
			{
				repoKey: `path-raw:${root}`,
				repoLabel: "main-repo",
				worktree: null,
			},
		);
	}
});

test("uses recorded remotes for removed checkouts without guessing from folder names", async () => {
	const removed = join(tempRoot, "athena-removed");
	const unrelated = join(tempRoot, "athena-unrelated");
	const info = await discoverProjectRepositories(
		[removed, unrelated],
		new Map([[removed, "https://github.com/acme/athena.git"]]),
	);
	expect(
		resolveUploadRepositoryIdentity(removed, info.get(removed) ?? {}),
	).toEqual({
		repoKey: "remote:github.com/acme/athena",
		repoLabel: "athena",
		worktree: null,
	});
	expect(info.get(unrelated)?.repositoryRoot).toBeUndefined();
	expect(info.get(unrelated)?.gitRemote).toBeUndefined();
});

test("keeps unrelated local repos separate even if they have identical package names", async () => {
	const first = await createRepo("first");
	const second = await createRepo("second");
	await Promise.all(
		[first, second].map((root) =>
			writeFile(join(root, "package.json"), '{"name":"same-name"}'),
		),
	);
	const info = await discoverProjectRepositories([first, second]);
	expect(
		resolveUploadRepositoryIdentity(first, info.get(first) ?? {}).repoKey,
	).not.toBe(
		resolveUploadRepositoryIdentity(second, info.get(second) ?? {}).repoKey,
	);
});

test("uses current Git metadata ahead of a transcript's old remote", async () => {
	const root = await createRepo("renamed");
	await git(
		"-C",
		root,
		"remote",
		"add",
		"origin",
		"https://github.com/acme/current.git",
	);
	const info = await discoverProjectRepositories(
		[root],
		new Map([[root, "https://github.com/acme/old.git"]]),
	);
	expect(
		resolveUploadRepositoryIdentity(root, info.get(root) ?? {}).repoKey,
	).toBe("remote:github.com/acme/current");
});

test("ranks combined repository activity and counts duplicate sessions once", () => {
	const project = (
		path: string,
		ids: string[],
		lastActivityAt: number,
		source: "claude_code" | "codex" = "claude_code",
	): ScannedProject => ({
		source,
		projectPath: path,
		displayPath: path,
		sessionCount: ids.length,
		sessions: ids.map((sessionId) => ({
			sessionId,
			projectPath: path,
			transcriptPath: `${path}/${sessionId}.jsonl`,
			lastActivityAt,
		})),
	});
	const inputs = [
		{ project: project("/alpha", ["one"], 100), root: "/alpha" },
		{ project: project("/beta", ["two"], 200), root: "/beta" },
		{
			project: project("/alpha/worktree", ["one", "three"], 300, "codex"),
			root: "/alpha",
		},
		{ project: project("/unknown", ["four"], 0), root: "/unknown" },
	];
	const repositories = orderUploadRepositoriesForSelection(
		groupUploadProjectsByRepository(
			inputs.map(({ project, root }) => ({
				project,
				newSessions: project.sessions,
				repositoryIdentity: resolveUploadRepositoryIdentity(
					project.projectPath,
					{ repositoryRoot: root },
				),
			})),
		),
	);
	expect(repositories.map((repository) => repository.label)).toEqual([
		"alpha",
		"beta",
		"unknown",
	]);
	const alpha = repositories[0];
	expect(alpha).toBeDefined();
	if (!alpha) throw new Error("Missing alpha repository");
	expect(getRepositorySessionCount(alpha)).toBe(2);
	expect(getRepositoryLastActivity(alpha)).toBe(300);
});

test("reads transcript activity dates rather than the date the file was copied", async () => {
	const path = join(tempRoot, "copied.jsonl");
	await writeFile(
		path,
		[
			JSON.stringify({
				cwd: "/repo/with-hyphens",
				timestamp: "2026-01-01T00:00:00Z",
			}),
			JSON.stringify({ padding: "x".repeat(200_000) }),
			JSON.stringify({ timestamp: "2026-02-01T00:00:00Z" }),
			"malformed final line",
		].join("\n"),
	);
	await utimes(path, new Date("2026-09-01"), new Date("2026-09-01"));
	expect(await readSessionDiscoveryMetadata(path)).toEqual({
		cwd: "/repo/with-hyphens",
		lastActivityAt: Date.parse("2026-02-01T00:00:00Z"),
	});
	expect(await readJsonlFirstLine(path)).toEqual({
		cwd: "/repo/with-hyphens",
		timestamp: "2026-01-01T00:00:00Z",
	});
});

test("reads long Codex metadata without loading the remainder of the transcript", async () => {
	const path = join(tempRoot, "large-header.jsonl");
	const meta = {
		type: "session_meta",
		payload: { id: "one", cwd: "/repo", instructions: "x".repeat(100_000) },
	};
	await writeFile(
		path,
		`${JSON.stringify(meta)}\n${"unparsed body\n".repeat(100_000)}`,
	);
	expect(await readJsonlFirstLine(path)).toEqual(meta);
});

test("balances substantial session counts with recency instead of sorting only by either", () => {
	const now = Date.parse("2026-09-13T12:00:00Z");
	const day = 24 * 60 * 60 * 1000;
	const inputs = [
		{ name: "tiny-today", count: 1, daysAgo: 0 },
		{ name: "largest-dormant", count: 1000, daysAgo: 180 },
		{ name: "larger-two-weeks-ago", count: 180, daysAgo: 14 },
		{ name: "substantial-yesterday", count: 60, daysAgo: 1 },
		{ name: "smaller-yesterday", count: 10, daysAgo: 1 },
	];
	const repositories = inputs.map(({ name, count, daysAgo }) => {
		const project: ScannedProject = {
			source: "claude_code",
			projectPath: `/${name}`,
			displayPath: name,
			sessionCount: count,
			sessions: Array.from({ length: count }, (_, index) => ({
				sessionId: `${name}-${index}`,
				transcriptPath: `/${name}/${index}.jsonl`,
				projectPath: `/${name}`,
				lastActivityAt: now - daysAgo * day,
			})),
		};
		return {
			key: name,
			label: name,
			projects: [
				{
					project,
					newSessions: project.sessions,
					repositoryIdentity: {
						repoKey: name,
						repoLabel: name,
						worktree: null,
					},
				},
			],
		};
	});
	expect(
		orderUploadRepositoriesForSelection(repositories, now).map(
			(repository) => repository.label,
		),
	).toEqual([
		"substantial-yesterday",
		"larger-two-weeks-ago",
		"smaller-yesterday",
		"tiny-today",
		"largest-dormant",
	]);
	expect(repositories.map((repository) => repository.label)).toEqual(
		inputs.map((input) => input.name),
	);
});
