import { expect, test } from "bun:test";
import {
	type AgentEvent,
	createClaudeStreamParser,
	NOT_LOGGED_IN_ERROR,
} from "../lib/ask/claude-stream.js";
import { ProgressBuffer } from "../lib/ask/progress-buffer.js";

const SESSION_ID = "6a9e5b10-50b3-4975-afbf-46b263402a22";

function assistant(id: string, block: Record<string, unknown>): string {
	return JSON.stringify({
		type: "assistant",
		message: { id, role: "assistant", content: [block] },
		parent_tool_use_id: null,
		session_id: SESSION_ID,
	});
}

function toolResult(block: Record<string, unknown>): string {
	return JSON.stringify({
		type: "user",
		message: { role: "user", content: [{ type: "tool_result", ...block }] },
		session_id: SESSION_ID,
	});
}

function parseAll(lines: string[]): AgentEvent[] {
	const parse = createClaudeStreamParser();
	return lines.flatMap(parse);
}

const recordedRun = [
	JSON.stringify({
		type: "system",
		subtype: "hook_started",
		hook_name: "SessionStart:startup",
		session_id: SESSION_ID,
	}),
	JSON.stringify({
		type: "system",
		subtype: "init",
		session_id: SESSION_ID,
		tools: ["mcp__opaline__find"],
	}),
	assistant("msg_1", { type: "text", text: "Let me look." }),
	assistant("msg_1", {
		type: "tool_use",
		id: "toolu_a",
		name: "mcp__opaline__find",
		input: {},
	}),
	assistant("msg_1", {
		type: "tool_use",
		id: "toolu_b",
		name: "mcp__opaline__sql",
		input: {},
	}),
	toolResult({
		tool_use_id: "toolu_a",
		content: [{ type: "text", text: "42" }],
	}),
	toolResult({ tool_use_id: "toolu_b", content: "boom", is_error: true }),
	JSON.stringify({ type: "rate_limit_event", rate_limit_info: {} }),
	assistant("msg_2", { type: "thinking", thinking: "", signature: "x" }),
	assistant("msg_2", { type: "text", text: "There are **42** sessions." }),
	"not json",
	JSON.stringify({
		type: "result",
		subtype: "success",
		is_error: false,
		result: "There are **42** sessions.",
		session_id: SESSION_ID,
	}),
];

test("a recorded Claude Code run becomes one progress patch with separated text, final tool states and the session id", () => {
	const buffer = new ProgressBuffer();
	for (const event of parseAll(recordedRun)) buffer.add(event);

	expect(buffer.take()).toEqual({
		text: "Let me look.\n\nThere are **42** sessions.",
		tools: [
			{ id: "toolu_a", name: "find", state: "done" },
			{ id: "toolu_b", name: "sql", state: "error" },
		],
		agentSessionId: SESSION_ID,
	});
	expect(buffer.take()).toBeUndefined();
});

test("text keeps its turn separator when the turns land in different progress batches", () => {
	const parse = createClaudeStreamParser();
	const buffer = new ProgressBuffer();
	for (const event of parse(
		assistant("msg_1", { type: "text", text: "First." }),
	))
		buffer.add(event);
	expect(buffer.take()?.text).toBe("First.");
	for (const event of parse(
		assistant("msg_2", { type: "text", text: "Second." }),
	))
		buffer.add(event);
	expect(buffer.take()?.text).toBe("\n\nSecond.");
});

test("a failed result reports a login problem in plain words and other errors by their first line", () => {
	const notLoggedIn = parseAll([
		JSON.stringify({
			type: "result",
			subtype: "success",
			is_error: true,
			result: "Not logged in · Please run /login",
		}),
	]);
	expect(notLoggedIn).toEqual([
		{ kind: "result", ok: false, error: NOT_LOGGED_IN_ERROR },
	]);

	const maxTurns = parseAll([
		JSON.stringify({
			type: "result",
			subtype: "error_max_turns",
			is_error: true,
		}),
	]);
	expect(maxTurns).toEqual([
		{
			kind: "result",
			ok: false,
			error: "Claude Code stopped after too many turns",
		},
	]);
});
