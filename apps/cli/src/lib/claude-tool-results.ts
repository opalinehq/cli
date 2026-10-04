import { basename, dirname, join } from "node:path";
import type {
	ToolResultReference,
	ToolResultReferences,
} from "../internal/local-context-source/index.js";

/** Bound on listed references, which keeps the capture manifest small. */
export const MAX_TOOL_RESULT_REFERENCES = 512;

/**
 * Claude Code saves a tool output too large for the transcript as
 * `<project dir>/<session id>/tool-results/<name>`, next to the session's
 * `<session id>.jsonl`, and records the path in the tool result.
 */
export function getClaudeToolResultsDirectory(
	transcriptPath: string,
	sessionId: string,
): string | null {
	if (basename(transcriptPath) !== `${sessionId}.jsonl`) return null;
	return join(dirname(transcriptPath), sessionId, "tool-results");
}

/**
 * Every record that references a file in `directory`, with its stream,
 * 1-based JSONL line and tool call, in stream order.
 */
export function findToolResultReferences(
	streams: readonly {
		readonly agentId: string | null;
		readonly content: string;
	}[],
	directory: string,
): ToolResultReferences {
	const prefix = `${directory}/`;
	const references: ToolResultReference[] = [];
	let omitted = 0;
	const seen = new Set<string>();
	for (const stream of streams) {
		let start = 0;
		for (let line = 1; start < stream.content.length; line += 1) {
			const end = stream.content.indexOf("\n", start);
			const text = stream.content.slice(start, end < 0 ? undefined : end);
			start = end < 0 ? stream.content.length : end + 1;
			if (!text.includes(prefix)) continue;
			const toolResults = readToolResults(text);
			for (const path of findReferencedPaths(text, prefix)) {
				const key = `${stream.agentId ?? ""}\0${line}\0${path}`;
				if (seen.has(key)) continue;
				seen.add(key);
				if (references.length >= MAX_TOOL_RESULT_REFERENCES) {
					omitted += 1;
					continue;
				}
				const matching = toolResults.filter((result) =>
					result.serialized.includes(`${prefix}${path}`),
				);
				const owner =
					matching.length === 1
						? matching[0]
						: toolResults.length === 1
							? toolResults[0]
							: undefined;
				references.push({
					path,
					agentId: stream.agentId,
					recordIndex: line,
					toolUseId: owner?.toolUseId ?? null,
				});
			}
		}
	}
	return { references, omitted };
}

function findReferencedPaths(text: string, prefix: string): readonly string[] {
	const paths = new Set<string>();
	let index = text.indexOf(prefix);
	while (index >= 0) {
		const match = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}/u.exec(
			text.slice(index + prefix.length, index + prefix.length + 256),
		);
		if (match) paths.add(match[0].replace(/\.+$/u, ""));
		index = text.indexOf(prefix, index + prefix.length);
	}
	return [...paths].filter((path) => path.length > 0);
}

/** Tool results of a user record, each with its serialized content. */
function readToolResults(
	text: string,
): readonly { readonly toolUseId: string; readonly serialized: string }[] {
	let record: unknown;
	try {
		record = JSON.parse(text);
	} catch {
		return [];
	}
	const message = asRecord(asRecord(record)?.message);
	const content = message?.content;
	if (!Array.isArray(content)) return [];
	return content.flatMap((item) => {
		const block = asRecord(item);
		return block?.type === "tool_result" &&
			typeof block.tool_use_id === "string"
			? [{ toolUseId: block.tool_use_id, serialized: JSON.stringify(block) }]
			: [];
	});
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? Object.fromEntries(Object.entries(value))
		: undefined;
}
