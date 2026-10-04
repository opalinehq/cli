import { basename, dirname } from "node:path/posix";
import type { ContextFileCategory } from "./types.js";

// General session content: observed skill definitions and agent definitions.
export const SESSION_CONTEXT_MAX_BLOBS = 256;
export const SESSION_CONTEXT_MAX_BLOB_BYTES = 2 * 1024 * 1024;
export const SESSION_CONTEXT_MAX_ENTRIES = 5000;
export const SESSION_CONTEXT_MAX_MANIFEST_BYTES = 1024 * 1024;
// Each Git or exclusion metadata list is trimmed on its own; trimming one list
// never marks a root, a facet or Git output as truncated.
export const SESSION_CONTEXT_MAX_METADATA_LIST_BYTES = 32 * 1024;
// Repository instruction files (AGENTS.md, CLAUDE.md, nested ones and the
// files they import) have their own pool so other content cannot crowd them out.
export const SESSION_INSTRUCTION_MAX_FILE_BYTES = 2 * 1024 * 1024;
export const SESSION_INSTRUCTION_MAX_TOTAL_BYTES = 16 * 1024 * 1024;
export const SESSION_INSTRUCTION_MAX_FILES = 512;
export const SESSION_INSTRUCTION_MAX_IMPORT_DEPTH = 5;
// Working-tree and staged patches have their own pool as well.
export const SESSION_DIFF_MAX_TOTAL_BYTES = 16 * 1024 * 1024;
// User context: every skill definition (observed first), the session
// project's Claude auto-memory, and user-level Claude commands, agents and
// output styles. Filled after the instruction pool and never shares its budget.
export const SESSION_USER_CONTEXT_MAX_FILE_BYTES = 2 * 1024 * 1024;
export const SESSION_USER_CONTEXT_MAX_TOTAL_BYTES = 16 * 1024 * 1024;
export const SESSION_USER_CONTEXT_MAX_FILES = 1024;
// Large tool outputs Claude Code saved next to the session transcript.
export const SESSION_TOOL_RESULT_MAX_FILE_BYTES = 2 * 1024 * 1024;
export const SESSION_TOOL_RESULT_MAX_TOTAL_BYTES = 16 * 1024 * 1024;
export const SESSION_TOOL_RESULT_MAX_FILES = 256;

export const CLAUDE_USER_HOME_ROOT_ID = "claude-user-home";
export const CODEX_USER_HOME_ROOT_ID = "codex-user-home";
export const CLAUDE_PROJECT_MEMORY_ROOT_ID = "claude-project-memory";
export const CLAUDE_TOOL_RESULTS_ROOT_ID = "claude-tool-results";
/** User-level Claude Code directories captured in full from ~/.claude. */
export const CLAUDE_USER_EXTENSION_DIRECTORIES = [
	"agents",
	"commands",
	"output-styles",
] as const;

export const INSTRUCTION_IMPORT_EVIDENCE_REASON = "instruction-import";
// Explicitly included files of user-level roots (see ContextRootInclude).
export const INSTRUCTION_INCLUDE_EVIDENCE_REASON = "instruction-include";
export const METADATA_INCLUDE_EVIDENCE_REASON = "metadata-include";

export function getSessionContentPriority(
	rootId: string,
	path: string,
	categories: readonly ContextFileCategory[],
	observedSkillNames: ReadonlySet<string>,
): number {
	// The repository's MCP server files decide which tools a session has.
	if (rootId === "repository" && isRepositoryMcpFile(path)) return 2;
	if (isSessionContentPolicyExcluded(path, categories)) return 4;
	if (isClaudeRuleFile(rootId, path)) return 0;
	if (categories.includes("skill-definition")) {
		return observedSkillNames.has(basename(dirname(path))) ? 1 : 4;
	}
	if (
		rootId === "repository" &&
		(categories.includes("instruction") ||
			/^(?:agents|claude)(?:\.[^.]+)?\.md$/iu.test(basename(path)))
	) {
		return /^(?:[^/]+|\.(?:claude|codex|agents|cursor|github)\/[^/]+)$/iu.test(
			path,
		)
			? -1
			: 0;
	}
	if (
		categories.includes("agent-config") &&
		/(?:^|\/)\.(?:claude|codex|agents|cursor)\/agents\/[^/]+\.md$/iu.test(path)
	)
		return 3;
	if (categories.includes("markdown")) return 4;
	if (categories.includes("agent-config") && categories.includes("config")) {
		return 3;
	}
	return 4;
}

/**
 * Instruction files whose content goes into the instruction pool: repository
 * instructions (priority -1 or 0) and files an instruction file imports.
 */
export function isSessionInstructionContent(
	rootId: string,
	path: string,
	categories: readonly ContextFileCategory[],
	evidenceReason: string | null,
): boolean {
	if (
		evidenceReason === INSTRUCTION_IMPORT_EVIDENCE_REASON ||
		evidenceReason === INSTRUCTION_INCLUDE_EVIDENCE_REASON
	) {
		return !isSessionContentPolicyExcluded(path, categories);
	}
	if (isClaudeRuleFile(rootId, path))
		return !isSessionContentPolicyExcluded(path, categories);
	if (rootId !== "repository") return false;
	return getSessionContentPriority(rootId, path, categories, new Set()) <= 0;
}

/** MCP server definitions checked into a repository (`.mcp.json` and kin). */
export function isRepositoryMcpFile(path: string): boolean {
	return [".mcp.json", "mcp.json", "mcp-config.json"].includes(
		basename(path).toLowerCase(),
	);
}

/**
 * Claude Code rules (`.claude/rules/**.md` in the repository, `~/.claude/rules`
 * for the user) are loaded like CLAUDE.md, so they are instructions.
 */
export function isClaudeRuleFile(rootId: string, path: string): boolean {
	if (!/\.md$/iu.test(path)) return false;
	if (rootId === "repository") return /(?:^|\/)\.claude\/rules\//u.test(path);
	return rootId === CLAUDE_USER_HOME_ROOT_ID && path.startsWith("rules/");
}

/**
 * Directory symlinks followed during discovery: every one inside a skill
 * root, and those inside or naming instruction, skill, command, agent and
 * output-style directories elsewhere. The target must stay inside the root's
 * symlink boundary (the repository, or \$HOME for user roots).
 */
export function isFollowableContextSymlink(
	rootScope: string,
	path: string,
): boolean {
	return (
		rootScope === "skills" ||
		/(?:^|\/)(?:skills|rules|commands|agents|output-styles)(?:\/|$)/u.test(path)
	);
}

/**
 * Orders instruction files: root and agent-directory files first, then the
 * nested files that apply to the working directory, then the rest by depth.
 */
export function getInstructionRank(
	path: string,
	workingDirectory: string | undefined,
): number {
	if (/^(?:[^/]+|\.(?:claude|codex|agents|cursor|github)\/[^/]+)$/iu.test(path))
		return 0;
	const directory = dirname(path);
	if (
		workingDirectory !== undefined &&
		(workingDirectory === directory ||
			workingDirectory.startsWith(`${directory}/`))
	)
		return 1;
	return 2 + path.split("/").length;
}

/**
 * Rank in the user-context pool (lower first), or null for content that does
 * not belong to it: the auto-memory index, then memory files, then user-level
 * commands, agents, output styles and Codex rules, then observed skill
 * definitions, then every other skill definition, then the resources of
 * observed skills.
 * Resources of other skills stay hash-only.
 */
export function getSessionUserContextRank(
	rootId: string,
	path: string,
	categories: readonly ContextFileCategory[],
	skillDirectory: string | null,
	observedSkillNames: ReadonlySet<string>,
): number | null {
	if (rootId === CLAUDE_PROJECT_MEMORY_ROOT_ID)
		return path.toLowerCase() === "memory.md" ? 0 : 1;
	if (
		rootId === CLAUDE_USER_HOME_ROOT_ID &&
		CLAUDE_USER_EXTENSION_DIRECTORIES.some((directory) =>
			path.startsWith(`${directory}/`),
		)
	)
		return 2;
	// Codex exec-policy rules decide which commands run without approval.
	if (rootId === CODEX_USER_HOME_ROOT_ID && path.startsWith("rules/")) return 2;
	const observed =
		skillDirectory !== null && observedSkillNames.has(basename(skillDirectory));
	if (categories.includes("skill-definition")) return observed ? 3 : 4;
	if (categories.includes("skill-resource") && observed) return 5;
	return null;
}

/** Claude Code's saved large tool outputs of the captured session. */
export function isSessionToolResult(rootId: string): boolean {
	return rootId === CLAUDE_TOOL_RESULTS_ROOT_ID;
}

/**
 * MCP files, agent settings and skill resources are deliberately hash-only.
 * Omitting them is policy, not a capacity cut. Personal instruction files
 * (`CLAUDE.local.md`, `*.local.md`) are loaded into the agent's context and
 * captured in full, secret-filtered, like other instructions.
 */
function isSessionContentPolicyExcluded(
	path: string,
	categories: readonly ContextFileCategory[],
): boolean {
	return (
		(categories.includes("mcp-config") &&
			!categories.includes("instruction") &&
			!categories.includes("skill-definition")) ||
		/(?:^|\/)(?:\.claude\/settings[^/]*\.json|\.codex\/config\.toml|\.cursor\/[^/]+\.json)$/iu.test(
			path,
		) ||
		(categories.includes("skill-resource") &&
			!categories.includes("skill-definition"))
	);
}
