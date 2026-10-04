import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse as parseToml } from "smol-toml";
import {
	type AgentConfigurationInputs,
	type ParsedSource,
	summarizeUserAgentConfiguration,
} from "../internal/local-context-source/agent-configuration.js";
import type {
	AdditionalContextRoot,
	ContextRootInclude,
	UserAgentConfiguration,
} from "../internal/local-context-source/index.js";
import { extractInstructionImportSpecifiers } from "../internal/local-context-source/instruction-imports.js";

/**
 * Everything outside the repository that shapes a session: user-level and
 * parent-directory instructions (with the files they import), user skills,
 * installed plugins' skills, commands, agents and hooks, and the user's agent
 * configuration. Collected as additional context roots; home directories are
 * never walked, only the listed paths are read, and nothing outside $HOME is
 * read except an explicitly configured CODEX_HOME.
 */

const MAX_PARENT_LEVELS = 12;
const MAX_IMPORT_DEPTH = 5;
const MAX_IMPORTED_FILES = 64;
const MAX_INSTRUCTION_READ_BYTES = 2 * 1024 * 1024;
const MAX_CONFIGURATION_READ_BYTES = 4 * 1024 * 1024;

export interface UserContextLocations {
	readonly home: string;
	readonly codexHome: string;
}

export interface UserAgentSources extends AgentConfigurationInputs {
	readonly claudePluginPaths: readonly string[];
	readonly codexPluginNames: readonly string[];
}

export function getUserContextLocations(
	environment: NodeJS.ProcessEnv = process.env,
	home: string = homedir(),
): UserContextLocations {
	const codexHome = environment.CODEX_HOME?.trim();
	return {
		home: resolve(home),
		codexHome:
			codexHome && isAbsolute(codexHome)
				? resolve(codexHome)
				: join(resolve(home), ".codex"),
	};
}

/** Locations with symlinks resolved, so containment checks are exact. */
export async function canonicalizeUserContextLocations(
	locations: UserContextLocations,
): Promise<UserContextLocations> {
	const canonical = (path: string) => realpath(path).catch(() => path);
	return {
		home: await canonical(locations.home),
		codexHome: await canonical(locations.codexHome),
	};
}

/** Reads the user's agent configuration files once for roots and summary. */
export async function readUserAgentSources(
	locations: UserContextLocations,
	repositoryRoot: string,
): Promise<UserAgentSources> {
	const claudeDirectory = join(locations.home, ".claude");
	const [claudeSettings, installed, codexConfig, codexHooks] =
		await Promise.all([
			readSource(join(claudeDirectory, "settings.json"), JSON.parse),
			readSource(
				join(claudeDirectory, "plugins", "installed_plugins.json"),
				JSON.parse,
			),
			readSource(join(locations.codexHome, "config.toml"), parseToml),
			readSource(join(locations.codexHome, "hooks.json"), JSON.parse),
		]);
	const claudePlugins = getApplicableClaudePlugins(
		installed.value,
		repositoryRoot,
	);
	return {
		claudeSettings: { ...claudeSettings, path: "~/.claude/settings.json" },
		claudeInstalledPlugins: claudePlugins.map((plugin) => plugin.name),
		claudePluginPaths: claudePlugins.map((plugin) => plugin.installPath),
		codexConfig: { ...codexConfig, path: "$CODEX_HOME/config.toml" },
		codexHooks: { ...codexHooks, path: "$CODEX_HOME/hooks.json" },
		codexPluginNames: getEnabledCodexPlugins(codexConfig.value),
	};
}

export function summarizeUserAgentSources(
	sources: UserAgentSources,
): UserAgentConfiguration {
	return summarizeUserAgentConfiguration(sources);
}

export async function resolveUserContextRoots(input: {
	readonly locations: UserContextLocations;
	readonly repositoryRoot: string;
	readonly sources: UserAgentSources;
}): Promise<readonly AdditionalContextRoot[]> {
	const { home, codexHome } = input.locations;
	const claudeDirectory = join(home, ".claude");
	const skillRoots: readonly AdditionalContextRoot[] = [
		{
			absolutePath: join(claudeDirectory, "skills"),
			id: "claude-user-skills",
			label: "Claude user skills",
			origin: "user",
			scope: "skills",
		},
		{
			absolutePath: join(codexHome, "skills"),
			id: "codex-user-skills",
			label: "Codex user skills",
			origin: "user",
			scope: "skills",
		},
		{
			absolutePath: join(home, ".agents", "skills"),
			id: "agents-user-skills",
			label: "Shared user skills",
			origin: "user",
			scope: "skills",
		},
	];
	const claudePluginCache = join(claudeDirectory, "plugins", "cache");
	const codexPluginCache = join(codexHome, "plugins", "cache");
	// Imports stay inside $HOME and never reach into the repository (already
	// captured) or into directories other roots walk.
	const excludedTrees = [
		input.repositoryRoot,
		...skillRoots.map((root) => root.absolutePath),
		claudePluginCache,
		codexPluginCache,
	];
	const claudeInstructions = await collectInstructionClosure(
		[join(claudeDirectory, "CLAUDE.md")],
		home,
		excludedTrees,
	);
	const parentCandidates = getParentInstructionCandidates(
		input.repositoryRoot,
		home,
	);
	const parentInstructions = await collectInstructionClosure(
		parentCandidates,
		home,
		excludedTrees,
	);
	// Every candidate is listed, so a missing parent file is recorded as
	// absent rather than not looked for.
	const homeIncludes = [
		...parentCandidates,
		...parentInstructions,
		...claudeInstructions,
	]
		.filter((path) => !isPathWithin(claudeDirectory, path))
		.map((path) => instruction(relative(home, path)));
	const claudeHomeIncludes = [...claudeInstructions, ...parentInstructions]
		.filter((path) => isPathWithin(claudeDirectory, path))
		.map((path) => instruction(relative(claudeDirectory, path)));
	const roots: AdditionalContextRoot[] = [
		...skillRoots,
		{
			absolutePath: claudeDirectory,
			id: "claude-user-home",
			label: "Claude Code user instructions and settings",
			origin: "user",
			scope: "agent-config",
			include: uniqueIncludes([
				instruction("CLAUDE.md"),
				...claudeHomeIncludes,
				metadata("settings.json"),
			]),
		},
		{
			absolutePath: codexHome,
			id: "codex-user-home",
			label: "Codex user instructions and settings",
			origin: "user",
			scope: "agent-config",
			include: [
				instruction("AGENTS.md"),
				instruction("AGENTS.override.md"),
				metadata("config.toml"),
				metadata("hooks.json"),
			],
		},
		{
			absolutePath: claudePluginCache,
			id: "claude-plugins",
			label: "Claude Code plugins",
			origin: "user",
			scope: "skills",
			include: input.sources.claudePluginPaths.flatMap((installPath) =>
				isPathWithin(claudePluginCache, installPath) &&
				installPath !== claudePluginCache
					? pluginIncludes(relative(claudePluginCache, installPath), [
							".claude-plugin/plugin.json",
						])
					: [],
			),
		},
		{
			absolutePath: codexPluginCache,
			id: "codex-plugins",
			label: "Codex plugins",
			origin: "user",
			scope: "skills",
			include: (
				await Promise.all(
					input.sources.codexPluginNames.map((name) =>
						resolveCodexPluginDirectory(codexPluginCache, name),
					),
				)
			).flatMap((directory) =>
				directory === null
					? []
					: pluginIncludes(directory, [".codex-plugin/plugin.json"]),
			),
		},
	];
	if (homeIncludes.length > 0)
		roots.push({
			absolutePath: home,
			id: "home-instructions",
			label: "Instructions above the repository",
			origin: "user",
			scope: "instructions",
			include: uniqueIncludes(homeIncludes),
		});
	return withoutRepositoryOverlap(roots, input.repositoryRoot);
}

/**
 * A repository that contains user directories (for example a Git repository
 * at $HOME) already inventories them: such roots and included paths are
 * dropped instead of being collected twice.
 */
function withoutRepositoryOverlap(
	roots: readonly AdditionalContextRoot[],
	repositoryRoot: string,
): readonly AdditionalContextRoot[] {
	return roots.flatMap((root): readonly AdditionalContextRoot[] => {
		if (root.include === undefined)
			return isPathWithin(repositoryRoot, root.absolutePath) ||
				isPathWithin(root.absolutePath, repositoryRoot)
				? []
				: [root];
		const include = root.include.filter(
			(entry) =>
				!isPathWithin(repositoryRoot, resolve(root.absolutePath, entry.path)),
		);
		return include.length === 0 && root.include.length > 0
			? []
			: [{ ...root, include }];
	});
}

/**
 * CLAUDE.md and CLAUDE.local.md in every directory from the repository's
 * parent up to $HOME, which Claude Code loads for sessions below them. Only
 * for repositories inside $HOME.
 */
function getParentInstructionCandidates(
	repositoryRoot: string,
	home: string,
): readonly string[] {
	if (!isPathWithin(home, repositoryRoot) || repositoryRoot === home) return [];
	const candidates: string[] = [];
	let directory = dirname(repositoryRoot);
	for (let level = 0; level < MAX_PARENT_LEVELS; level += 1) {
		if (!isPathWithin(home, directory)) break;
		candidates.push(
			join(directory, "CLAUDE.md"),
			join(directory, "CLAUDE.local.md"),
		);
		if (directory === home) break;
		directory = dirname(directory);
	}
	return candidates;
}

/**
 * The given instruction files that exist, plus the files they import with
 * Claude Code `@path` syntax (relative, `~/`, or absolute), followed up to
 * five hops, inside $HOME and outside the excluded trees.
 */
async function collectInstructionClosure(
	entryPoints: readonly string[],
	home: string,
	excludedTrees: readonly string[],
): Promise<readonly string[]> {
	const found: string[] = [];
	const visited = new Set<string>();
	let frontier = entryPoints.map((path) => ({ path, depth: 0 }));
	while (frontier.length > 0 && found.length < MAX_IMPORTED_FILES) {
		const next: { path: string; depth: number }[] = [];
		for (const item of frontier) {
			const path = resolve(item.path);
			if (visited.has(path)) continue;
			visited.add(path);
			if (
				!isPathWithin(home, path) ||
				excludedTrees.some((tree) => isPathWithin(tree, path))
			)
				continue;
			const text = await readTextIfFile(path, MAX_INSTRUCTION_READ_BYTES);
			if (text === null) continue;
			found.push(path);
			if (item.depth >= MAX_IMPORT_DEPTH) continue;
			for (const specifier of extractInstructionImportSpecifiers(text)) {
				const target = specifier.startsWith("~/")
					? join(home, specifier.slice(2))
					: isAbsolute(specifier)
						? specifier
						: join(dirname(path), specifier);
				next.push({ path: target, depth: item.depth + 1 });
			}
		}
		frontier = next;
	}
	return found;
}

function pluginIncludes(
	directory: string,
	manifests: readonly string[],
): readonly ContextRootInclude[] {
	const base = directory.split(sep).join("/");
	return [
		...["skills", "commands", "agents", "hooks"].map(
			(tree): ContextRootInclude => ({ path: `${base}/${tree}`, role: "tree" }),
		),
		...[...manifests, ".mcp.json"].map(
			(manifest): ContextRootInclude => ({
				path: `${base}/${manifest}`,
				role: "metadata",
			}),
		),
	];
}

/**
 * Claude Code plugins installed for the user, or for this repository's
 * project, from installed_plugins.json.
 */
function getApplicableClaudePlugins(
	value: unknown,
	repositoryRoot: string,
): readonly { readonly name: string; readonly installPath: string }[] {
	const plugins = asRecord(asRecord(value)?.plugins);
	if (!plugins) return [];
	const applicable: { name: string; installPath: string }[] = [];
	for (const [name, installations] of Object.entries(plugins)) {
		if (!Array.isArray(installations)) continue;
		for (const installation of installations) {
			const record = asRecord(installation);
			if (typeof record?.installPath !== "string") continue;
			const scope = record.scope;
			const projectPath =
				typeof record.projectPath === "string" ? record.projectPath : null;
			if (
				scope === "user" ||
				(projectPath !== null && resolve(projectPath) === repositoryRoot)
			) {
				applicable.push({ name, installPath: resolve(record.installPath) });
			}
		}
	}
	return applicable.sort((left, right) =>
		left.installPath < right.installPath ? -1 : 1,
	);
}

/** `name@marketplace` entries of config.toml `[plugins]` that are enabled. */
function getEnabledCodexPlugins(value: unknown): readonly string[] {
	const plugins = asRecord(asRecord(value)?.plugins);
	if (!plugins) return [];
	return Object.entries(plugins)
		.filter(([, entry]) => asRecord(entry)?.enabled === true)
		.map(([name]) => name)
		.sort();
}

/** The most recently updated cached version of an enabled Codex plugin. */
async function resolveCodexPluginDirectory(
	cache: string,
	name: string,
): Promise<string | null> {
	const separator = name.lastIndexOf("@");
	if (separator <= 0) return null;
	const plugin = name.slice(0, separator);
	const marketplace = name.slice(separator + 1);
	if (![plugin, marketplace].every(isSafeSegment)) return null;
	const pluginDirectory = join(cache, marketplace, plugin);
	let versions: string[];
	try {
		versions = (await readdir(pluginDirectory, { withFileTypes: true }))
			.filter((entry) => entry.isDirectory() && isSafeSegment(entry.name))
			.map((entry) => entry.name);
	} catch {
		return null;
	}
	const dated = await Promise.all(
		versions.map(async (version) => ({
			version,
			modifiedAt: (await stat(join(pluginDirectory, version))).mtimeMs,
		})),
	);
	const newest = dated.sort(
		(left, right) =>
			right.modifiedAt - left.modifiedAt ||
			(left.version < right.version ? 1 : -1),
	)[0];
	return newest ? join(marketplace, plugin, newest.version) : null;
}

async function readSource(
	path: string,
	parse: (text: string) => unknown,
): Promise<ParsedSource> {
	const text = await readTextIfFile(path, MAX_CONFIGURATION_READ_BYTES).catch(
		() => undefined,
	);
	if (text === null) return { path, status: "absent", value: undefined };
	if (text === undefined)
		return { path, status: "unreadable", value: undefined };
	try {
		return { path, status: "parsed", value: parse(text) };
	} catch {
		return { path, status: "unreadable", value: undefined };
	}
}

/** File text, or null when the path is missing or not a regular file. */
async function readTextIfFile(
	path: string,
	maxBytes: number,
): Promise<string | null> {
	try {
		const details = await stat(path);
		if (!details.isFile() || details.size > maxBytes) return null;
		return await readFile(path, "utf8");
	} catch (error) {
		if (
			error instanceof Error &&
			"code" in error &&
			(error.code === "ENOENT" || error.code === "ENOTDIR")
		)
			return null;
		throw error;
	}
}

function instruction(path: string): ContextRootInclude {
	return { path: path.split(sep).join("/"), role: "instruction" };
}

function metadata(path: string): ContextRootInclude {
	return { path, role: "metadata" };
}

function uniqueIncludes(
	includes: readonly ContextRootInclude[],
): readonly ContextRootInclude[] {
	const seen = new Set<string>();
	return includes.filter((include) => {
		if (seen.has(include.path)) return false;
		seen.add(include.path);
		return true;
	});
}

function isSafeSegment(value: string): boolean {
	return /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value) && value !== "..";
}

function isPathWithin(parent: string, candidate: string): boolean {
	const relativePath = relative(parent, candidate);
	return (
		relativePath === "" ||
		(relativePath !== ".." &&
			!relativePath.startsWith(`..${sep}`) &&
			!isAbsolute(relativePath))
	);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? Object.fromEntries(Object.entries(value))
		: undefined;
}
