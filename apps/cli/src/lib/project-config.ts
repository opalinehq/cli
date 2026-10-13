import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { exec } from "./exec.js";
import { getLegacyRemoteUrl, normalizeRemoteUrl } from "./git-info.js";
import { getConfigDir } from "./local-state.js";

interface ProjectEntry {
	organizationId: string;
}

interface ProjectsConfig {
	projects: Record<string, ProjectEntry>;
	/** The workspace last chosen with `opaline set-org`, for unmapped folders. */
	defaultOrganizationId?: string;
}

function getProjectsConfigPath(): string {
	return join(getConfigDir(), "projects.json");
}

function loadProjectsConfig(): ProjectsConfig {
	const path = getProjectsConfigPath();
	if (!existsSync(path)) return { projects: {} };
	chmodSync(getConfigDir(), 0o700);
	chmodSync(path, 0o600);
	const content = readFileSync(path, "utf-8");
	return JSON.parse(content) as ProjectsConfig;
}

function saveProjectsConfig(config: ProjectsConfig): void {
	const dir = getConfigDir();
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	chmodSync(dir, 0o700);
	const path = getProjectsConfigPath();
	writeFileSync(path, JSON.stringify(config, null, 2), { mode: 0o600 });
	chmodSync(path, 0o600);
}

interface ProjectKeys {
	key: string;
	/** Keys older releases saved the same project under. */
	legacyKeys: string[];
}

async function getProjectKeys(cwd: string): Promise<ProjectKeys> {
	// Prefer git remote URL (portable across clones)
	try {
		const result = await exec("git", [
			"-C",
			cwd,
			"remote",
			"get-url",
			"origin",
		]);
		if (result.exitCode === 0) {
			const url = result.stdout.trim();
			if (url.length > 0) {
				const legacyKey = getLegacyRemoteUrl(url);
				return {
					key: normalizeRemoteUrl(url),
					legacyKeys: legacyKey ? [legacyKey] : [],
				};
			}
		}
	} catch {
		// Not a git repo or no remote
	}

	// Fall back to absolute path
	try {
		const result = await exec("git", [
			"-C",
			cwd,
			"rev-parse",
			"--show-toplevel",
		]);
		if (result.exitCode === 0) {
			return { key: result.stdout.trim(), legacyKeys: [] };
		}
	} catch {
		// Not a git repo
	}

	return { key: cwd, legacyKeys: [] };
}

export async function getProjectOrgId(
	cwd: string,
): Promise<string | undefined> {
	const { key, legacyKeys } = await getProjectKeys(cwd);
	const config = loadProjectsConfig();
	return [key, ...legacyKeys]
		.map((candidate) => config.projects[candidate]?.organizationId)
		.find((organizationId) => organizationId !== undefined);
}

export async function setProjectOrgId(
	cwd: string,
	organizationId: string,
): Promise<void> {
	const { key, legacyKeys } = await getProjectKeys(cwd);
	const config = loadProjectsConfig();
	config.projects[key] = { organizationId };
	for (const legacyKey of legacyKeys) delete config.projects[legacyKey];
	config.defaultOrganizationId = organizationId;
	saveProjectsConfig(config);
}

export function getDefaultProjectOrgId(): string | undefined {
	const value = loadProjectsConfig().defaultOrganizationId;
	return typeof value === "string" && value.length > 0 ? value : undefined;
}
