import { describe, expect, test } from "bun:test";
import {
	findToolResultReferences,
	getClaudeToolResultsDirectory,
	MAX_TOOL_RESULT_REFERENCES,
} from "../lib/claude-tool-results.js";

const DIRECTORY = "/home/me/.claude/projects/-repo/session-1/tool-results";

function toolResultRecord(
	results: readonly { readonly id: string; readonly name: string }[],
): string {
	return JSON.stringify({
		type: "user",
		message: {
			role: "user",
			content: results.map((result) => ({
				tool_use_id: result.id,
				type: "tool_result",
				content: `Full output saved to: ${DIRECTORY}/${result.name}.`,
			})),
		},
	});
}

describe("Claude Code saved tool outputs", () => {
	test("lives next to the session transcript, only for `<session id>.jsonl`", () => {
		expect(
			getClaudeToolResultsDirectory(
				"/home/me/.claude/projects/-repo/session-1.jsonl",
				"session-1",
			),
		).toBe(DIRECTORY);
		expect(
			getClaudeToolResultsDirectory("/tmp/renamed.jsonl", "session-1"),
		).toBeNull();
	});

	test("links each referenced output to its stream, JSONL line and tool call", () => {
		const main = [
			JSON.stringify({ type: "user", message: { content: "Start" } }),
			toolResultRecord([{ id: "toolu_a", name: "a.txt" }]),
			toolResultRecord([
				{ id: "toolu_b", name: "b.txt" },
				{ id: "toolu_c", name: "c.txt" },
			]),
			`not json but mentions ${DIRECTORY}/d.txt`,
			JSON.stringify({ text: "elsewhere /tmp/tool-results/x.txt" }),
		].join("\n");
		const child = toolResultRecord([{ id: "toolu_e", name: "e.txt" }]);

		expect(
			findToolResultReferences(
				[
					{ agentId: null, content: main },
					{ agentId: "agent-1", content: child },
				],
				DIRECTORY,
			),
		).toEqual({
			references: [
				{ path: "a.txt", agentId: null, recordIndex: 2, toolUseId: "toolu_a" },
				{ path: "b.txt", agentId: null, recordIndex: 3, toolUseId: "toolu_b" },
				{ path: "c.txt", agentId: null, recordIndex: 3, toolUseId: "toolu_c" },
				{ path: "d.txt", agentId: null, recordIndex: 4, toolUseId: null },
				{
					path: "e.txt",
					agentId: "agent-1",
					recordIndex: 1,
					toolUseId: "toolu_e",
				},
			],
			omitted: 0,
		});
	});

	test("bounds the listed references and counts the rest", () => {
		const content = Array.from(
			{ length: MAX_TOOL_RESULT_REFERENCES + 3 },
			(_, index) =>
				toolResultRecord([{ id: `toolu_${index}`, name: `${index}.txt` }]),
		).join("\n");

		const result = findToolResultReferences(
			[{ agentId: null, content }],
			DIRECTORY,
		);

		expect(result.references).toHaveLength(MAX_TOOL_RESULT_REFERENCES);
		expect(result.omitted).toBe(3);
	});
});
