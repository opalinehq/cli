import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { type Source, SourceSchema } from "../contracts/index.js";
import { getGitInfo } from "./git-info.js";
import { getConfigDir } from "./local-state.js";
import { resolveUploadRepositoryIdentity } from "./repository-discovery.js";

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

export async function saveAutoUploadConfig(
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

export async function getAutoUploadPolicy(
	projectPath: string,
	configDir = getConfigDir(),
	source?: Source,
): Promise<{ enabled: boolean; organizationId?: string }> {
	const config = loadAutoUploadConfig(configDir);
	if (!config) return { enabled: true };
	if (!projectPath || !isAbsolute(projectPath)) return { enabled: false };
	const key = await getRepositoryKey(projectPath);
	const setting = config.repositories[key];
	return {
		enabled:
			setting?.enabled === true &&
			(!source ||
				!setting.enabledSources ||
				setting.enabledSources.includes(source)),
		organizationId: setting?.organizationId,
	};
}

export async function getRepositoryKey(projectPath: string): Promise<string> {
	return resolveUploadRepositoryIdentity(
		projectPath,
		await getGitInfo(projectPath),
	).repoKey;
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
