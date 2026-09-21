import { basename, dirname, extname } from "node:path/posix";
import type {
	ContextFileCategory,
	ContextRootScope,
	ExcludedPath,
} from "./types.js";

const DEPENDENCY_SEGMENTS = new Set([
	"node_modules",
	".pnpm-store",
	"vendor",
	"third_party",
	"third-party",
]);
const GENERATED_SEGMENTS = new Set([
	"dist",
	"build",
	"coverage",
	"target",
	".next",
	".nuxt",
]);
const CACHE_SEGMENTS = new Set([".cache", ".turbo"]);
const SOURCE_EXTENSIONS = new Set([
	".c",
	".cc",
	".cpp",
	".cs",
	".css",
	".go",
	".html",
	".java",
	".js",
	".jsx",
	".kt",
	".lua",
	".php",
	".py",
	".rb",
	".rs",
	".sh",
	".sql",
	".svelte",
	".swift",
	".tsx",
	".ts",
	".vue",
]);
const CONFIG_EXTENSIONS = new Set([
	".ini",
	".json",
	".jsonc",
	".properties",
	".toml",
	".yaml",
	".yml",
	".xml",
]);
const DOCUMENT_EXTENSIONS = new Set([".adoc", ".mdx", ".rst", ".txt"]);

export interface PathExclusion {
	readonly excluded: boolean;
	readonly reason: ExcludedPath["reason"] | null;
}

export function getPathExclusion(
	relativePath: string,
	excludedPathPrefixes: readonly string[],
): PathExclusion {
	const segments = relativePath.split("/");
	if (segments.includes(".git")) {
		return { excluded: true, reason: "vcs" };
	}
	if (
		segments.some((segment) => DEPENDENCY_SEGMENTS.has(segment)) ||
		relativePath === ".yarn/cache" ||
		relativePath.startsWith(".yarn/cache/")
	) {
		return { excluded: true, reason: "dependency" };
	}
	if (segments.some((segment) => GENERATED_SEGMENTS.has(segment))) {
		return { excluded: true, reason: "generated" };
	}
	if (segments.some((segment) => CACHE_SEGMENTS.has(segment))) {
		return { excluded: true, reason: "cache" };
	}
	for (const prefix of excludedPathPrefixes) {
		const normalized = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
		if (
			relativePath === normalized ||
			relativePath.startsWith(`${normalized}/`)
		) {
			return { excluded: true, reason: "explicit" };
		}
	}
	return { excluded: false, reason: null };
}

export function isHighRiskContentPath(relativePath: string): boolean {
	const name = basename(relativePath).toLowerCase();
	if (
		name === ".env.example" ||
		name === ".env.sample" ||
		name === ".env.template"
	) {
		return false;
	}
	return (
		name === ".env" ||
		name.startsWith(".env.") ||
		name === ".npmrc" ||
		name === ".netrc" ||
		name === ".pypirc" ||
		name === "credentials.json" ||
		name === "service-account.json" ||
		name === "id_rsa" ||
		name === "id_ed25519" ||
		name.endsWith(".pem") ||
		name.endsWith(".key") ||
		name.endsWith(".p12") ||
		name.endsWith(".pfx")
	);
}

export function findSkillDirectories(
	paths: readonly string[],
): readonly string[] {
	return paths
		.filter((path) => basename(path).toLowerCase() === "skill.md")
		.map((path) => dirname(path))
		.sort(compareStrings);
}

export function classifyContextPath(
	relativePath: string,
	skillDirectories: readonly string[],
	rootScope: ContextRootScope | undefined = undefined,
): readonly ContextFileCategory[] {
	const categories = new Set<ContextFileCategory>();
	const lowerPath = relativePath.toLowerCase();
	const name = basename(lowerPath);
	const extension = extname(name);
	const segments = lowerPath.split("/");
	const isMarkdown = extension === ".md" || extension === ".mdx";

	if (isMarkdown) categories.add("markdown");
	if (isInstructionPath(name, lowerPath)) categories.add("instruction");
	if (name === "skill.md") categories.add("skill-definition");
	if (isInsideSkillDirectory(relativePath, skillDirectories)) {
		categories.add("skill-resource");
	}
	if (
		isPlanCandidate(name, segments, isMarkdown) ||
		(rootScope === "plans" && isMarkdown)
	) {
		categories.add("plan-candidate");
	}
	if (isAgentConfigPath(name, segments)) categories.add("agent-config");
	if (isMcpConfigPath(name, lowerPath)) categories.add("mcp-config");
	if (isPackageContextPath(name)) categories.add("package-context");
	if (segments.includes("hooks") && isAgentConfigPath(name, segments)) {
		categories.add("hook-config");
	}
	if (SOURCE_EXTENSIONS.has(extension)) categories.add("source");
	if (isTestPath(name, segments)) categories.add("test");
	if (CONFIG_EXTENSIONS.has(extension) || isConfigName(name)) {
		categories.add("config");
	}
	if (isMarkdown || DOCUMENT_EXTENSIONS.has(extension)) {
		categories.add("document");
	}
	if (categories.size === 0) categories.add("other");
	return [...categories].sort(compareStrings);
}

export function getContentPriority(
	categories: readonly ContextFileCategory[],
): number {
	if (categories.includes("instruction")) return 0;
	if (categories.includes("skill-definition")) return 1;
	if (categories.includes("markdown")) return 2;
	if (categories.includes("skill-resource")) return 3;
	if (categories.includes("plan-candidate")) return 4;
	if (categories.includes("agent-config")) return 5;
	if (categories.includes("package-context")) return 5;
	if (categories.includes("config")) return 6;
	if (categories.includes("source")) return 7;
	if (categories.includes("document")) return 8;
	return 9;
}

export function getParentPath(relativePath: string): string | null {
	const parent = dirname(relativePath);
	return parent === "." ? null : parent;
}

function isInstructionPath(name: string, lowerPath: string): boolean {
	return (
		name === "agents.md" ||
		name === "claude.md" ||
		name === "gemini.md" ||
		name === "instructions.md" ||
		name === "copilot-instructions.md" ||
		name.endsWith(".instructions.md") ||
		name === ".cursorrules" ||
		lowerPath.startsWith(".github/instructions/") ||
		lowerPath.includes("/.github/instructions/")
	);
}

function isInsideSkillDirectory(
	relativePath: string,
	skillDirectories: readonly string[],
): boolean {
	return skillDirectories.some(
		(directory) =>
			directory === "." ||
			relativePath === directory ||
			relativePath.startsWith(`${directory}/`),
	);
}

function isPlanCandidate(
	name: string,
	segments: readonly string[],
	isMarkdown: boolean,
): boolean {
	return (
		isMarkdown &&
		(segments.includes("plans") ||
			/(^|[-_.])(plan|roadmap|spec)([-_.]|$)/u.test(name))
	);
}

function isAgentConfigPath(name: string, segments: readonly string[]): boolean {
	return (
		segments.some((segment) =>
			[".claude", ".codex", ".agents", ".cursor"].includes(segment),
		) ||
		["agents.md", "claude.md", "conductor.json", ".cursorrules"].includes(name)
	);
}

function isMcpConfigPath(name: string, lowerPath: string): boolean {
	return (
		name === ".mcp.json" ||
		name === "mcp.json" ||
		name === "mcp-config.json" ||
		lowerPath.includes("/mcp/")
	);
}

function isPackageContextPath(name: string): boolean {
	return [
		"package.json",
		"pyproject.toml",
		"cargo.toml",
		"go.mod",
		"pom.xml",
		"build.gradle",
		"build.gradle.kts",
		"gemfile",
	].includes(name);
}

function isTestPath(name: string, segments: readonly string[]): boolean {
	return (
		segments.includes("__tests__") ||
		name.includes(".test.") ||
		name.includes(".spec.")
	);
}

function isConfigName(name: string): boolean {
	return (
		name === "dockerfile" ||
		name === "makefile" ||
		name === ".editorconfig" ||
		name === ".gitignore" ||
		name === ".gitattributes"
	);
}

function compareStrings(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}
