import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { type Source, SourceSchema } from "../contracts/index.js";
import { withConfigLock } from "./config-lock.js";
import { getConfigDir } from "./local-state.js";

export interface RepositoryUploadSetting {
	enabled: boolean;
	name: string;
	paths: string[];
	organizationId?: string;
	enabledSources?: Source[];
}

export interface AutoUploadConfig {
	version: 1;
	repositories: Record<string, RepositoryUploadSetting>;
	defaultOrganizationId?: string;
}

// No file preserves existing installations. Once managed, unknown repos are Off.
// Invalid settings must throw: falling back to legacy mode would permit uploads.
export function loadAutoUploadConfig(
	configDir = getConfigDir(),
): AutoUploadConfig | null {
	const path = join(configDir, "auto-upload.json");
	if (!existsSync(path)) return null;
	chmodSync(configDir, 0o700);
	chmodSync(path, 0o600);
	const value: unknown = JSON.parse(readFileSync(path, "utf8"));
	if (isRecord(value) && value.version === 1 && isRecord(value.repositories)) {
		const repositories: Record<string, RepositoryUploadSetting> = {};
		for (const [key, entry] of Object.entries(value.repositories)) {
			if (
				!isRecord(entry) ||
				typeof entry.label !== "string" ||
				!Array.isArray(entry.sources)
			)
				throw new Error(`Invalid automatic upload settings in ${path}.`);
			const enabledSources = entry.sources.map((source: unknown) =>
				SourceSchema.parse(source),
			);
			if (
				("enabled" in entry || "paths" in entry || "name" in entry) &&
				(!isSetting(entry) || entry.enabled !== enabledSources.length > 0)
			)
				throw new Error(`Invalid automatic upload settings in ${path}.`);
			repositories[key] = isSetting(entry)
				? { ...entry, enabledSources }
				: {
						name: entry.label,
						paths: [],
						enabled: enabledSources.length > 0,
						enabledSources,
					};
		}
		if (
			value.defaultOrganizationId !== undefined &&
			typeof value.defaultOrganizationId !== "string"
		)
			throw new Error(`Invalid automatic upload settings in ${path}.`);
		return {
			version: 1,
			repositories,
			defaultOrganizationId: value.defaultOrganizationId,
		};
	}
	throw new Error(`Invalid automatic upload settings in ${path}.`);
}

// All writers read, modify and persist under the same process-owned lock.
// The checkpoint lets OFF choices take effect even if hook setup later fails.
export async function updateAutoUploadConfig(
	update: (
		config: AutoUploadConfig | null,
		save: (config: AutoUploadConfig) => Promise<void>,
	) => Promise<void>,
	configDir = getConfigDir(),
): Promise<void> {
	await withConfigLock(configDir, async () => {
		await update(loadAutoUploadConfig(configDir), (config) =>
			writeAutoUploadConfig(config, configDir),
		);
	});
}

export function isRepositoryAutoUploadAllowed(
	repoKey: string,
	source: Source,
	legacyKeys: readonly string[] = [],
): boolean {
	const config = loadAutoUploadConfig();
	if (config === null) return true;
	const canonical = config.repositories[repoKey];
	const allowed = (entry: RepositoryUploadSetting | undefined) =>
		entry?.enabled === true && entry.enabledSources?.includes(source) === true;
	return canonical
		? allowed(canonical)
		: legacyKeys.some((key) => allowed(config.repositories[key]));
}

async function writeAutoUploadConfig(
	config: AutoUploadConfig,
	configDir = getConfigDir(),
): Promise<void> {
	await mkdir(configDir, { recursive: true, mode: 0o700 });
	await chmod(configDir, 0o700);
	// Keep the v1 label/sources shape readable by installed Opaline hooks while
	// adding the manager metadata. Off entries expose no allowed sources.
	const persisted = {
		...config,
		version: 1,
		repositories: Object.fromEntries(
			Object.entries(config.repositories).map(([key, entry]) => [
				key,
				{
					...entry,
					label: entry.name,
					sources: entry.enabled
						? (entry.enabledSources ?? ["claude_code", "codex"])
						: [],
				},
			]),
		),
	};
	const temporaryPath = join(configDir, `.auto-upload-${randomUUID()}.tmp`);
	try {
		await writeFile(temporaryPath, `${JSON.stringify(persisted, null, 2)}\n`, {
			mode: 0o600,
			flag: "wx",
		});
		await rename(temporaryPath, join(configDir, "auto-upload.json"));
	} finally {
		await rm(temporaryPath, { force: true });
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSetting(value: unknown): value is RepositoryUploadSetting {
	return (
		isRecord(value) &&
		typeof value.enabled === "boolean" &&
		typeof value.name === "string" &&
		Array.isArray(value.paths) &&
		value.paths.every(
			(path: unknown) => typeof path === "string" && isAbsolute(path),
		) &&
		(value.enabledSources === undefined ||
			(Array.isArray(value.enabledSources) &&
				value.enabledSources.every(
					(source: unknown) => SourceSchema.safeParse(source).success,
				))) &&
		(value.organizationId === undefined ||
			typeof value.organizationId === "string")
	);
}
