import { existsSync } from "node:fs";
import { basename, dirname, isAbsolute } from "node:path";
import type { Source } from "../contracts/index.js";
import {
	type AgentAdapter,
	getAllAdapters,
	type HookOptions,
	type SessionFile,
} from "../internal/agent-adapters/index.js";
import {
	loadAutoUploadConfig,
	type RepositoryUploadSetting,
} from "./auto-upload-config.js";
import { getGitInfo } from "./git-info.js";
import {
	discoverProjectRepositories,
	getLegacyRepositoryKey,
	resolveUploadRepositoryIdentity,
} from "./repository-discovery.js";

export interface UploadRepository extends RepositoryUploadSetting {
	key: string;
	legacyKeys?: string[];
	sessionCount: number;
	uploadedCount?: number;
	uploadedOrganizationId?: string;
	uploadError?: string;
	sessions?: Array<SessionFile & { source: Source }>;
	uploadedSessionIds?: Set<string>;
	upload?: {
		completed: number;
		total: number;
		active: boolean;
		failed: number;
	};
	sources: Source[];
	current: boolean;
	problem?: string;
}

export interface ScanProgress {
	sessions: number;
	repositories: number;
}

export function getUploadAdapters(): AgentAdapter[] {
	const all = getAllAdapters();
	const installed = all.filter((adapter) =>
		existsSync(dirname(adapter.getSessionsBaseDir())),
	);
	// Allow setup before the first session has created the agent directory.
	return installed.length > 0
		? installed
		: all.filter((adapter) => adapter.source === "claude_code");
}

export async function discoverUploadRepositories(
	onProgress: (progress: ScanProgress, rows: UploadRepository[]) => void,
	options: {
		cwd?: string;
		configDir?: string;
		adapters?: AgentAdapter[];
		signal?: AbortSignal;
	} = {},
): Promise<UploadRepository[]> {
	options.signal?.throwIfAborted();
	onProgress({ sessions: 0, repositories: 0 }, []);
	const config = loadAutoUploadConfig(options.configDir);
	const adapters = options.adapters ?? getUploadAdapters();
	const repositories = new Map<string, UploadRepository>();
	const keys = new Map<string, Promise<string>>();
	const sessions = new Set<string>();
	const currentKey = await getRepositoryKey(options.cwd ?? process.cwd());
	options.signal?.throwIfAborted();
	keys.set(options.cwd ?? process.cwd(), Promise.resolve(currentKey));
	const hookCache = new Map<string, boolean>();
	const report = () =>
		onProgress({ sessions: sessions.size, repositories: repositories.size }, [
			...repositories.values(),
		]);

	for (const [key, setting] of Object.entries(config?.repositories ?? {})) {
		repositories.set(key, {
			...setting,
			key,
			paths: [...setting.paths],
			sessionCount: 0,
			sessions: [],
			sources: [],
			current: key === currentKey,
		});
	}

	async function addPath(path: string): Promise<UploadRepository> {
		options.signal?.throwIfAborted();
		let keyPromise = keys.get(path);
		if (!keyPromise) {
			keyPromise = getRepositoryKey(path);
			keys.set(path, keyPromise);
		}
		const key = await keyPromise;
		options.signal?.throwIfAborted();
		let repository = repositories.get(key);
		if (!repository) {
			repository = {
				key,
				name: key.startsWith("path-raw:")
					? basename(key.slice(9))
					: key.startsWith("remote:")
						? key.split("/").slice(1).join("/")
						: key.replace(/^[^:]+:/u, ""),
				paths: [],
				enabled: false,
				sessionCount: 0,
				sessions: [],
				sources: [],
				current: key === currentKey,
			};
			repositories.set(key, repository);
		}
		if (!repository.paths.includes(path)) {
			repository.paths.push(path);
			updateHookStatus(repository);
		}
		return repository;
	}

	function installedHook(adapter: AgentAdapter, projectPath?: string): boolean {
		const cacheKey = `${adapter.source}:${projectPath ?? "global"}`;
		let installed = hookCache.get(cacheKey);
		if (installed === undefined) {
			installed = projectPath
				? existsSync(projectPath) && hasHook(adapter, { projectPath })
				: hasHook(adapter, { global: true });
			hookCache.set(cacheKey, installed);
		}
		return installed;
	}

	function updateHookStatus(repository: UploadRepository) {
		const hasRepositoryHook = (adapter: AgentAdapter) =>
			installedHook(adapter) ||
			repository.paths.some((path) => installedHook(adapter, path));
		if (!config) repository.enabled = adapters.some(hasRepositoryHook);
		const missing = repository.enabled
			? adapters.filter(
					(adapter) =>
						(repository.enabledSources &&
							!repository.enabledSources.includes(adapter.source)) ||
						!hasRepositoryHook(adapter),
				)
			: [];
		if (missing.length)
			repository.problem = `Enter to repair setup for ${missing.map((adapter) => adapter.name).join(" + ")}.`;
		else delete repository.problem;
	}

	await addPath(options.cwd ?? process.cwd());
	// Sort the initial saved rows once. Discoveries append to this order, so
	// keyboard focus and existing rows stay in place throughout the scan.
	const initial = [...repositories.values()].sort(
		(a, b) =>
			Number(b.current) - Number(a.current) || a.name.localeCompare(b.name),
	);
	repositories.clear();
	for (const repository of initial) {
		updateHookStatus(repository);
		repositories.set(repository.key, repository);
	}
	report();
	for (const adapter of adapters) {
		options.signal?.throwIfAborted();
		await adapter.scanAllSessions({
			signal: options.signal,
			onSession: async (session: SessionFile) => {
				options.signal?.throwIfAborted();
				if (!isAbsolute(session.projectPath)) return;
				const repository = await addPath(session.projectPath);
				const sessionKey = `${adapter.source}:${session.sessionId}`;
				if (!sessions.has(sessionKey)) {
					sessions.add(sessionKey);
					repository.sessionCount += 1;
					repository.sessions?.push({ ...session, source: adapter.source });
				}
				if (!repository.sources.includes(adapter.source))
					repository.sources.push(adapter.source);
				report();
			},
		});
	}
	options.signal?.throwIfAborted();
	// Reconcile removed worktrees and legacy allowlist keys after all paths are known.
	// The table remains locked during this pass, so provisional discoveries can merge.
	const paths = [...repositories.values()].flatMap(
		(repository) => repository.paths,
	);
	const remotes = new Map<string, string>();
	for (const repository of repositories.values())
		for (const session of repository.sessions ?? [])
			if (session.gitRemote)
				remotes.set(session.projectPath, session.gitRemote);
	const info = await discoverProjectRepositories(paths, remotes);
	options.signal?.throwIfAborted();
	const canonical = new Map<string, UploadRepository>();
	const consumedKeys = new Set<string>();
	for (const row of repositories.values()) {
		for (const path of row.paths) {
			const git = info.get(path);
			if (!git) continue;
			const identity = resolveUploadRepositoryIdentity(path, git);
			const legacyKey = getLegacyRepositoryKey(path, git);
			const setting =
				config?.repositories[identity.repoKey] ??
				config?.repositories[legacyKey] ??
				config?.repositories[row.key];
			consumedKeys.add(row.key);
			consumedKeys.add(legacyKey);
			let repository = canonical.get(identity.repoKey);
			if (!repository) {
				repository = {
					...row,
					...(setting ?? {}),
					key: identity.repoKey,
					name: identity.repoLabel,
					paths: [],
					sessions: [],
					sessionCount: 0,
					sources: [],
					current: false,
					legacyKeys: [],
				};
				canonical.set(identity.repoKey, repository);
			}
			if (!repository.paths.includes(path)) repository.paths.push(path);
			repository.current ||= path === (options.cwd ?? process.cwd());
			for (const key of [row.key, legacyKey])
				if (key !== repository.key && !repository.legacyKeys?.includes(key))
					repository.legacyKeys?.push(key);
			for (const session of row.sessions ?? []) {
				if (
					session.projectPath !== path ||
					repository.sessions?.some(
						(existing) =>
							existing.source === session.source &&
							existing.sessionId === session.sessionId,
					)
				)
					continue;
				repository.sessions?.push(session);
				repository.sessionCount++;
				if (!repository.sources.includes(session.source))
					repository.sources.push(session.source);
			}
		}
	}
	for (const row of repositories.values())
		if (
			!row.paths.length &&
			!consumedKeys.has(row.key) &&
			!canonical.has(row.key)
		)
			canonical.set(row.key, row);
	repositories.clear();
	for (const row of canonical.values()) {
		updateHookStatus(row);
		repositories.set(row.key, row);
	}
	report();
	return [...repositories.values()];
}

function hasHook(adapter: AgentAdapter, options: HookOptions): boolean {
	try {
		return adapter.isHookInstalled(options);
	} catch {
		return false;
	} // A broken agent config must not prevent turning uploads Off.
}

async function getRepositoryKey(projectPath: string): Promise<string> {
	return resolveUploadRepositoryIdentity(
		projectPath,
		await getGitInfo(projectPath),
	).repoKey;
}
