import { expect, test } from "bun:test";
import { SESSION_NOT_FOUND_ERROR } from "../lib/ask/agent-event.js";
import {
	createCodexStreamParser,
	describeCodexFailure,
} from "../lib/ask/codex-stream.js";
import { ProgressBuffer } from "../lib/ask/progress-buffer.js";

const recordedRun = `{"type":"thread.started","thread_id":"01a19d87-8478-7351-80d7-4573adc359c0"}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"I’ll check the available Opaline tools."}}
{"type":"item.started","item":{"id":"item_1","type":"mcp_tool_call","server":"opaline","tool":"count_sessions","arguments":{},"result":null,"error":null,"status":"in_progress"}}
{"type":"item.completed","item":{"id":"item_1","type":"mcp_tool_call","server":"opaline","tool":"count_sessions","arguments":{},"result":{"content":[{"type":"text","text":"42"}],"structured_content":null},"error":null,"status":"completed"}}
{"type":"item.started","item":{"id":"item_2","type":"mcp_tool_call","server":"opaline","tool":"broken","arguments":{},"result":null,"error":null,"status":"in_progress"}}
{"type":"item.completed","item":{"id":"item_2","type":"mcp_tool_call","server":"opaline","tool":"broken","arguments":{},"result":{"content":[{"type":"text","text":"boom"}],"structured_content":null},"error":null,"status":"failed"}}
{"type":"item.completed","item":{"id":"item_3","type":"reasoning","text":"thinking"}}
{"type":"item.completed","item":{"id":"item_4","type":"agent_message","text":"There are **42** sessions."}}
{"type":"turn.completed","usage":{"input_tokens":42644,"output_tokens":194}}`;

test("a recorded Codex run becomes the same progress patch shape as Claude Code: session, separated text and tool states", () => {
	const parse = createCodexStreamParser();
	const buffer = new ProgressBuffer();
	const events = recordedRun.split("\n").flatMap(parse);
	for (const event of events) buffer.add(event);

	expect(buffer.take()).toEqual({
		text: "I’ll check the available Opaline tools.\n\nThere are **42** sessions.",
		tools: [
			{ id: "item_1", name: "count_sessions", state: "done" },
			{ id: "item_2", name: "broken", state: "error" },
		],
		agentSessionId: "01a19d87-8478-7351-80d7-4573adc359c0",
	});
	expect(events.at(-1)).toEqual({ kind: "result", ok: true });
});

test("Codex failures map to a missing session, a login hint, or the first line of the error", () => {
	expect(
		describeCodexFailure(
			"Error: thread/resume: thread/resume failed: no rollout found for thread id 0000 (code -32600)",
		),
	).toBe(SESSION_NOT_FOUND_ERROR);
	expect(
		createCodexStreamParser()(
			JSON.stringify({
				type: "turn.failed",
				error: { message: "unexpected status 401 Unauthorized" },
			}),
		),
	).toEqual([
		{
			kind: "result",
			ok: false,
			error: "Codex is not logged in — run `codex login`",
		},
	]);
});
