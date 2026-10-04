import { posix } from "node:path";

const MAX_INSTRUCTION_IMPORTS_PER_FILE = 64;

/**
 * Raw `@path` import specifiers of a Claude Code instruction file. Code spans
 * and fenced blocks are ignored, as in Claude Code. Each specifier is
 * returned as written and, when it ends in sentence punctuation, also without
 * it; callers keep only targets that exist.
 */
export function extractInstructionImportSpecifiers(
	text: string,
): readonly string[] {
	const prose = text
		.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gmu, "")
		.replace(/`[^`\n]*`/gu, "");
	const specifiers = new Set<string>();
	for (const match of prose.matchAll(/(?:^|\s)@([^\s`'"<>()[\]{}]+)/gu)) {
		const raw = match[1];
		if (raw === undefined) continue;
		for (const candidate of [raw, raw.replace(/[.,;:!?]+$/u, "")])
			if (candidate.length > 0) specifiers.add(candidate);
		if (specifiers.size >= MAX_INSTRUCTION_IMPORTS_PER_FILE * 2) break;
	}
	return [...specifiers];
}

/**
 * Repository-relative targets of Claude Code `@path` imports. Only relative
 * paths inside the repository resolve; callers keep only targets that exist
 * in the inventory.
 */
export function findInstructionImports(
	text: string,
	fromPath: string,
): readonly string[] {
	const targets = new Set<string>();
	for (const specifier of extractInstructionImportSpecifiers(text)) {
		if (specifier.startsWith("/") || specifier.startsWith("~")) continue;
		const resolved = posix.normalize(
			posix.join(posix.dirname(fromPath), specifier),
		);
		if (
			resolved === "." ||
			resolved === ".." ||
			resolved.startsWith("../") ||
			posix.isAbsolute(resolved)
		)
			continue;
		targets.add(resolved);
		if (targets.size >= MAX_INSTRUCTION_IMPORTS_PER_FILE) break;
	}
	return [...targets];
}
