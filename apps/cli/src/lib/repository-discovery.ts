import { realpath } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import pMap from "p-map";
import { type RepoIdentity, resolveRepoIdentity } from "../contracts/index.js";
import { exec } from "./exec.js";
import {
	type GitInfo,
	getRepositoryInfo,
	normalizeRemoteUrl,
} from "./git-info.js";
import { getCachedRemote, getRemoteCache } from "./remote-cache.js";

export function resolveUploadRepositoryIdentity(
	projectPath: string,
	gitInfo: GitInfo,
): RepoIdentity {
	if (gitInfo.repositoryRoot || gitInfo.gitRemote)
		return {
			repoKey: gitInfo.gitRemote
				? `remote:${gitInfo.gitRemote}`
				: `path-raw:${gitInfo.repositoryRoot}`,
			repoLabel: gitInfo.repositoryRoot
				? basename(gitInfo.repositoryRoot)
				: (gitInfo.gitRemote?.split("/").at(-1) ?? "Repository"),
			worktree: null,
		};
	return resolveRepoIdentity({
		projectPath,
		gitRemote: null,
		packageName: gitInfo.packageName ?? null,
	});
}

export function getLegacyRepositoryKey(
	projectPath: string,
	gitInfo: GitInfo,
): string {
	return resolveRepoIdentity({
		projectPath,
		gitRemote: gitInfo.gitRemote ?? null,
		packageName: gitInfo.packageName ?? null,
	}).repoKey;
}

export async function discoverProjectRepositories(
	projectPaths: readonly string[],
	recordedRemotes: ReadonlyMap<string, string> = new Map(),
	options: {
		signal?: AbortSignal;
		onRepository?: (path: string, info: GitInfo) => void;
	} = {},
): Promise<Map<string, GitInfo>> {
	options.signal?.throwIfAborted();
	const entries = await pMap(
		[...new Set(projectPaths)],
		async (path) => {
			options.signal?.throwIfAborted();
			const info = await getRepositoryInfo(path);
			options.signal?.throwIfAborted();
			const recordedRemote = recordedRemotes.get(path);
			if (!info.gitRemote && !info.repositoryRoot && recordedRemote)
				info.gitRemote = normalizeRemoteUrl(recordedRemote);
			if (info.repositoryRoot) options.onRepository?.(path, info);
			return [path, info] as const;
		},
		{ concurrency: 8 },
	);
	const repositories = new Map(entries);
	const roots = new Map<string, GitInfo>();
	for (const [, info] of entries)
		if (info.repositoryRoot) roots.set(info.repositoryRoot, info);
	const knownPaths = new Map<string, GitInfo>();
	await pMap(
		[...roots],
		async ([root, info]) => {
			options.signal?.throwIfAborted();
			knownPaths.set(await normalizeProjectPath(root), info);
			const result = await exec("git", [
				"-C",
				root,
				"worktree",
				"list",
				"--porcelain",
				"-z",
			]);
			if (result.exitCode === 0)
				for (const field of result.stdout.split("\0")) {
					if (field.startsWith("worktree "))
						knownPaths.set(await normalizeProjectPath(field.slice(9)), info);
				}
		},
		{ concurrency: 8 },
	);
	// A removed Conductor checkout can still be tied to its collection through a live sibling.
	const collections = new Map<string, GitInfo | null>();
	for (const [path, info] of entries) {
		const collection = path.match(
			/^(.*[\\/]conductor[\\/]workspaces[\\/][^\\/]+)[\\/]/u,
		)?.[1];
		if (!collection || !info.repositoryRoot) continue;
		const existing = collections.get(collection);
		collections.set(
			collection,
			existing === null ||
				(existing && existing.repositoryRoot !== info.repositoryRoot)
				? null
				: info,
		);
	}
	for (const [collection, info] of collections)
		if (info) knownPaths.set(await normalizeProjectPath(collection), info);
	const cache = await getRemoteCache();
	const ancestors = [...knownPaths].sort(([a], [b]) => b.length - a.length);
	for (const [path, info] of entries) {
		options.signal?.throwIfAborted();
		if (info.repositoryRoot) continue;
		const normalized = await normalizeProjectPath(path);
		const parent = ancestors.find(
			([root]) => normalized === root || normalized.startsWith(root + sep),
		);
		if (parent) {
			repositories.set(path, {
				...parent[1],
				branch: undefined,
				sha: undefined,
			});
		} else {
			const remote = getCachedRemote(cache, path.replaceAll("/", "-"));
			if (remote) repositories.set(path, { ...info, gitRemote: remote });
		}
		options.onRepository?.(path, repositories.get(path) ?? info);
	}
	return repositories;
}

async function normalizeProjectPath(path: string): Promise<string> {
	let existing = resolve(path);
	const missing: string[] = [];
	while (true) {
		const canonical = await realpath(existing).catch(() => null);
		if (canonical) return join(canonical, ...missing);
		const parent = dirname(existing);
		if (parent === existing) return resolve(path);
		missing.unshift(basename(existing));
		existing = parent;
	}
}
