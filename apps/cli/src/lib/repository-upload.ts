import { existsSync } from "node:fs";
import { mkdir, open, rm } from "node:fs/promises";
import { join } from "node:path";
import type { AgentAdapter } from "../internal/agent-adapters/index.js";
import {
	captureAutoUploadSetupResult,
	summarizeAutoUploadRepositories,
} from "./auto-upload-analytics.js";
import { loadCredentials } from "./credentials.js";
import { getConfigDir } from "./local-state.js";
import { setProjectOrgId } from "./project-config.js";
import {
	type AutoUploadConfig,
	loadAutoUploadConfig,
	saveAutoUploadConfig,
} from "./upload-manager-config.js";
import type { UploadRepository } from "./upload-manager-repositories.js";

export interface RepositoryChange {
	repository: UploadRepository;
	enabled: boolean;
	organizationId?: string;
}

export async function saveRepositoryChanges(
	repositories: UploadRepository[],
	changes: RepositoryChange[],
	adapters: AgentAdapter[],
	options: { configDir?: string; defaultOrganizationId?: string } = {},
): Promise<void> {
	const configDir = options.configDir ?? getConfigDir();
	await mkdir(configDir, { recursive: true, mode: 0o700 });
	const lockPath = join(configDir, "auto-upload.lock");
	const lock = await open(lockPath, "wx", 0o600).catch(() => {
		throw new Error("Another upload manager is saving. Try again in a moment.");
	});
	try {
		const existing = loadAutoUploadConfig(configDir);
		const config: AutoUploadConfig = existing ?? {
			version: 1,
			repositories: Object.fromEntries(
				repositories.map((repository) => [
					repository.key,
					{
						enabled: repository.enabled,
						name: repository.name,
						paths: repository.paths,
						organizationId: repository.organizationId,
						enabledSources: repository.enabledSources,
					},
				]),
			),
		};
		// Fold older identity keys into the canonical entry before saving an OFF state.
		for (const repository of repositories) {
			config.repositories[repository.key] ??= {
				name: repository.name,
				paths: repository.paths,
				enabled: repository.enabled,
				enabledSources: repository.enabledSources,
				organizationId: repository.organizationId,
			};
			for (const key of repository.legacyKeys ?? [])
				delete config.repositories[key];
		}
		// Establish the allowlist before adding any global hook. New repos stay Off.
		// Persist Off first, so a failed installation cannot keep a disabled repo uploading.
		for (const change of changes) {
			const { repository } = change;
			if (!change.enabled) {
				config.repositories[repository.key] = {
					name: repository.name,
					paths: repository.paths,
					organizationId: repository.organizationId,
					enabled: false,
				};
			}
		}
		await saveAutoUploadConfig(config, configDir);
		for (const change of changes.filter((change) => !change.enabled))
			change.repository.enabled = false;

		if (changes.length) {
			const summaries = summarizeAutoUploadRepositories(
				changes
					.filter((change) => change.enabled)
					.flatMap((change) =>
						adapters.map((adapter) => ({
							repositoryKey: change.repository.key,
							organizationId:
								change.organizationId ?? change.repository.organizationId,
							source: adapter.source,
							sessionIds: (change.repository.sessions ?? [])
								.filter((session) => session.source === adapter.source)
								.map((session) => session.sessionId),
						})),
					),
			);
			const userId = loadCredentials()?.user?.id;
			for (const adapter of adapters) {
				try {
					const alreadyInstalled = adapter.isHookInstalled({ global: true });
					adapter.installHook({ global: true });
					captureAutoUploadSetupResult({
						result: {
							source: adapter.source,
							status: "enabled",
							alreadyInstalled,
						},
						summaries,
						userId,
						command: "upload",
					});
				} catch (error) {
					captureAutoUploadSetupResult({
						result: { source: adapter.source, status: "failed", error },
						summaries,
						userId,
						command: "upload",
					});
					throw error;
				}
			}
			// Global Claude hooks cover future worktrees too. Remove our old local
			// hooks to avoid running twice, preserving every unrelated hook/setting.
			const claude = adapters.find(
				(adapter) => adapter.source === "claude_code",
			);
			if (claude) {
				const globalPath = claude.getHookConfigPath({ global: true });
				for (const repository of repositories) {
					for (const projectPath of repository.paths.filter(existsSync)) {
						if (
							claude.getHookConfigPath({ projectPath }) !== globalPath &&
							claude.isHookInstalled({ projectPath })
						) {
							claude.removeHook({ projectPath });
						}
					}
				}
			}
		}

		for (const change of changes) {
			const { repository, enabled, organizationId } = change;
			if (enabled && organizationId) {
				for (const path of repository.paths)
					await setProjectOrgId(path, organizationId);
			}
			config.repositories[repository.key] = {
				name: repository.name,
				paths: repository.paths,
				enabled,
				organizationId: organizationId ?? repository.organizationId,
			};
		}
		if (options.defaultOrganizationId)
			config.defaultOrganizationId = options.defaultOrganizationId;
		await saveAutoUploadConfig(config, configDir);
		for (const change of changes) {
			change.repository.enabled = change.enabled;
			change.repository.problem = undefined;
			change.repository.enabledSources = undefined;
			change.repository.organizationId =
				change.organizationId ?? change.repository.organizationId;
		}
	} finally {
		await lock.close();
		await rm(lockPath, { force: true });
	}
}
