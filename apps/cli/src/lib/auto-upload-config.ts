import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { type Source, SourceSchema } from "../contracts/index.js";
import { getConfigDir } from "./local-state.js";

const AUTO_UPLOAD_CONFIG_VERSION = 1;

export interface AutoUploadRepositorySelection {
	readonly key: string;
	readonly label: string;
	readonly sources: readonly Source[];
	readonly legacyKeys?: readonly string[];
}

interface AutoUploadRepositoryEntry {
	readonly label: string;
	readonly sources: readonly Source[];
}

export interface AutoUploadConfig {
	readonly repositories: Readonly<Record<string, AutoUploadRepositoryEntry>>;
	readonly version: typeof AUTO_UPLOAD_CONFIG_VERSION;
}

export function loadAutoUploadConfig(): AutoUploadConfig | null {
	const path = getAutoUploadConfigPath();
	if (!existsSync(path)) return null;
	repairConfigPermissions(path);
	return parseAutoUploadConfig(JSON.parse(readFileSync(path, "utf8")));
}

export function isRepositoryAutoUploadAllowed(
	repoKey: string,
	source: Source,
	legacyKeys: readonly string[] = [],
): boolean {
	const config = loadAutoUploadConfig();
	if (config === null) return true;
	const repository = config.repositories[repoKey];
	if (repository) return repository.sources.includes(source);
	return legacyKeys.some((key) =>
		config.repositories[key]?.sources.includes(source),
	);
}

export function saveVisibleAutoUploadSelections(
	visibleRepositories: readonly AutoUploadRepositorySelection[],
	selectedRepoKeys: ReadonlySet<string>,
): AutoUploadConfig {
	const existing = loadAutoUploadConfig();
	const visibleRepoKeys = new Set(
		visibleRepositories.flatMap((repository) => [
			repository.key,
			...(repository.legacyKeys ?? []),
		]),
	);
	const repositories: Record<string, AutoUploadRepositoryEntry> = {};

	if (existing) {
		for (const [key, repository] of Object.entries(existing.repositories)) {
			if (!visibleRepoKeys.has(key)) repositories[key] = repository;
		}
	}

	for (const repository of visibleRepositories) {
		if (!selectedRepoKeys.has(repository.key)) continue;
		repositories[repository.key] = {
			label: repository.label,
			sources: uniqueSources(repository.sources),
		};
	}

	const config: AutoUploadConfig = {
		repositories,
		version: AUTO_UPLOAD_CONFIG_VERSION,
	};
	saveAutoUploadConfig(config);
	return config;
}

export function enableAutoUploadRepository(
	repository: AutoUploadRepositorySelection,
): AutoUploadConfig {
	const existing = loadAutoUploadConfig();
	const repositories: Record<string, AutoUploadRepositoryEntry> = {
		...(existing?.repositories ?? {}),
		[repository.key]: {
			label: repository.label,
			sources: uniqueSources(repository.sources),
		},
	};
	for (const key of repository.legacyKeys ?? [])
		if (key !== repository.key) delete repositories[key];
	const config: AutoUploadConfig = {
		repositories,
		version: AUTO_UPLOAD_CONFIG_VERSION,
	};
	saveAutoUploadConfig(config);
	return config;
}

export function clearAutoUploadRepositories(): AutoUploadConfig {
	const config: AutoUploadConfig = {
		repositories: {},
		version: AUTO_UPLOAD_CONFIG_VERSION,
	};
	saveAutoUploadConfig(config);
	return config;
}

export function getRequiredAutoUploadSources(
	config: AutoUploadConfig,
): ReadonlySet<Source> {
	const sources = new Set<Source>();
	for (const repository of Object.values(config.repositories)) {
		for (const source of repository.sources) sources.add(source);
	}
	return sources;
}

function getAutoUploadConfigPath(): string {
	return join(getConfigDir(), "auto-upload.json");
}

function saveAutoUploadConfig(config: AutoUploadConfig): void {
	const dir = getConfigDir();
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	chmodSync(dir, 0o700);
	const path = getAutoUploadConfigPath();
	writeFileSync(path, JSON.stringify(config, null, 2), { mode: 0o600 });
	chmodSync(path, 0o600);
}

function repairConfigPermissions(path: string): void {
	const dir = getConfigDir();
	chmodSync(dir, 0o700);
	chmodSync(path, 0o600);
}

function parseAutoUploadConfig(value: unknown): AutoUploadConfig {
	if (!isRecord(value) || value.version !== AUTO_UPLOAD_CONFIG_VERSION) {
		throw new Error("Invalid auto-upload configuration version");
	}
	if (!isRecord(value.repositories)) {
		throw new Error("Invalid auto-upload repository configuration");
	}

	const repositories: Record<string, AutoUploadRepositoryEntry> = {};
	for (const [key, entry] of Object.entries(value.repositories)) {
		if (!isRecord(entry) || typeof entry.label !== "string") {
			throw new Error(`Invalid auto-upload configuration for ${key}`);
		}
		if (!Array.isArray(entry.sources)) {
			throw new Error(`Invalid auto-upload sources for ${key}`);
		}
		const sources: Source[] = [];
		for (const source of entry.sources) {
			const parsed = SourceSchema.safeParse(source);
			if (!parsed.success) {
				throw new Error(`Invalid auto-upload source for ${key}`);
			}
			sources.push(parsed.data);
		}
		repositories[key] = {
			label: entry.label,
			sources: uniqueSources(sources),
		};
	}

	return {
		repositories,
		version: AUTO_UPLOAD_CONFIG_VERSION,
	};
}

function uniqueSources(sources: readonly Source[]): Source[] {
	return Array.from(new Set(sources));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
