import { basename, dirname } from "node:path/posix";
import type { ContextFileCategory } from "./types.js";

export const SESSION_CONTEXT_MAX_BLOBS = 256;
export const SESSION_CONTEXT_MAX_BLOB_BYTES = 2 * 1024 * 1024;
export const SESSION_CONTEXT_MAX_ENTRIES = 2000;
export const SESSION_CONTEXT_MAX_MANIFEST_BYTES = 256 * 1024;

export function getSessionContentPriority(
	rootId: string,
	path: string,
	categories: readonly ContextFileCategory[],
	observedSkillNames: ReadonlySet<string>,
): number {
	if (
		basename(path).toLowerCase().endsWith(".local.md") ||
		(categories.includes("mcp-config") &&
			!categories.includes("instruction") &&
			!categories.includes("skill-definition")) ||
		/(?:^|\/)(?:\.claude\/settings[^/]*\.json|\.codex\/config\.toml|\.cursor\/[^/]+\.json)$/iu.test(
			path,
		)
	)
		return 4;
	if (categories.includes("skill-definition")) {
		return observedSkillNames.has(basename(dirname(path))) ? 1 : 4;
	}
	if (categories.includes("skill-resource")) return 4;
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
