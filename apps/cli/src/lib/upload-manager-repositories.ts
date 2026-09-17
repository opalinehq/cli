import { existsSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
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
import type { GitInfo } from "./git-info.js";
import {
	discoverProjectRepositories,
	getLegacyRepositoryKey,
	resolveUploadRepositoryIdentity,
} from "./repository-discovery.js";
import type { SessionUploadDetail, UploadSpeed } from "./upload-progress.js";

export interface UploadRepository extends RepositoryUploadSetting {
	key: string;
	legacyKeys?: string[];
	sessionCount: number;
	uploadedCount?: number;
	uploadedOrganizationId?: string;
	uploadError?: string;
	sessions?: Array<SessionFile & { source: Source }>;
	uploadedSessionIds?: Set<string>;
	sessionUploads?: SessionUploadDetail[];
	uploadSpeed?: UploadSpeed;
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
	phase: "sessions" | "repositories" | "history";
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
	const { signal } = options;
	signal?.throwIfAborted();
	const config = loadAutoUploadConfig(options.configDir);
	const adapters = options.adapters ?? getUploadAdapters();
	const cwd = options.cwd ?? process.cwd();
	const repositories = new Map<string, UploadRepository>();
	const sessions = new Map<string, Array<SessionFile & { source: Source }>>();
	const sessionIds = new Set<string>();
	const remotes = new Map<string, string>();
	const savedPaths = new Map<string, string>();
	const consumedKeys = new Set<string>();
	const hookCache = new Map<string, boolean>();
	let phase: ScanProgress["phase"] = "sessions";
	const report = () =>
		onProgress(
			{ phase, sessions: sessionIds.size, repositories: repositories.size },
			[...repositories.values()],
		);
	// Keep only canonical rows in the table. Session discovery is deliberately
	// separate from Git resolution: callbacks must not block file-reading workers
	// or publish temporary worktree identities that disappear later.
	sessions.set(cwd, []);
	for (const [key, setting] of Object.entries(config?.repositories ?? {}))
		for (const path of setting.paths) {
			sessions.set(path, []);
			savedPaths.set(path, key);
		}
	report();
	for (const adapter of adapters) {
		signal?.throwIfAborted();
		await adapter.scanAllSessions({
			signal,
			onSession: (session) => {
				signal?.throwIfAborted();
				if (!isAbsolute(session.projectPath)) return;
				const key = `${adapter.source}:${session.sessionId}`;
				if (sessionIds.has(key)) return;
				sessionIds.add(key);
				const entries = sessions.get(session.projectPath) ?? [];
				entries.push({ ...session, source: adapter.source });
				sessions.set(session.projectPath, entries);
				if (session.gitRemote)
					remotes.set(session.projectPath, session.gitRemote);
				report();
			},
		});
	}
	phase = "repositories";
	report();
	await discoverProjectRepositories([...sessions.keys()], remotes, {
		signal,
		onRepository: addRepository,
	});
	for (const [key, setting] of Object.entries(config?.repositories ?? {})) {
		if (setting.paths.length || consumedKeys.has(key) || repositories.has(key))
			continue;
		const repository: UploadRepository = {
			...setting,
			key,
			paths: [],
			sessionCount: 0,
			sessions: [],
			sources: [],
			current: false,
		};
		updateHookStatus(repository);
		repositories.set(key, repository);
		report();
	}
	signal?.throwIfAborted();
	return [...repositories.values()];

	function addRepository(path: string, info: GitInfo) {
		const identity = resolveUploadRepositoryIdentity(path, info);
		const legacyKey = getLegacyRepositoryKey(path, info);
		const savedKey = savedPaths.get(path);
		const setting =
			config?.repositories[identity.repoKey] ??
			config?.repositories[legacyKey] ??
			(savedKey ? config?.repositories[savedKey] : undefined);
		consumedKeys.add(legacyKey);
		if (savedKey) consumedKeys.add(savedKey);
		let repository = repositories.get(identity.repoKey);
		if (!repository) {
			repository = {
				...setting,
				key: identity.repoKey,
				name: identity.repoLabel,
				enabled: setting?.enabled ?? false,
				paths: [],
				sessionCount: 0,
				sessions: [],
				sources: [],
				current: false,
				legacyKeys: [],
			};
			repositories.set(identity.repoKey, repository);
		}
		repository.paths.push(path);
		repository.current ||= path === cwd;
		for (const key of [savedKey, legacyKey])
			if (
				key &&
				key !== repository.key &&
				!repository.legacyKeys?.includes(key)
			)
				repository.legacyKeys?.push(key);
		for (const session of sessions.get(path) ?? []) {
			repository.sessions?.push(session);
			repository.sessionCount++;
			if (!repository.sources.includes(session.source))
				repository.sources.push(session.source);
		}
		updateHookStatus(repository);
		report();
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
}

function hasHook(adapter: AgentAdapter, options: HookOptions): boolean {
	try {
		return adapter.isHookInstalled(options);
	} catch {
		return false;
	} // A broken agent config must not prevent turning uploads Off.
}
