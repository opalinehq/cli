import {
	type AgentEvent,
	type AgentStreamParser,
	firstLineOf,
	isRecord,
	parseJsonObject,
	SESSION_NOT_FOUND_ERROR,
	type ToolState,
} from "./agent-event.js";

export const CODEX_NOT_LOGGED_IN_ERROR =
	"Codex is not logged in — run `codex login`";

export function createCodexStreamParser(): AgentStreamParser {
	return (line) => {
		const event = parseJsonObject(line);
		if (!event) return [];
		switch (event.type) {
			case "thread.started":
				return typeof event.thread_id === "string"
					? [{ kind: "session", sessionId: event.thread_id }]
					: [];
			case "item.started":
			case "item.completed":
				return itemEvents(event.item);
			case "turn.completed":
				return [{ kind: "result", ok: true }];
			case "turn.failed":
				return [
					{
						kind: "result",
						ok: false,
						error:
							describeCodexFailure(errorMessage(event.error)) ??
							"Codex stopped with an error",
					},
				];
			default:
				return [];
		}
	};
}

export function describeCodexFailure(output: string): string | undefined {
	const text = output.trim();
	if (!text) return undefined;
	if (/no rollout found|thread not found/iu.test(text))
		return SESSION_NOT_FOUND_ERROR;
	if (/not logged in|codex login|401 unauthorized|unauthorized/iu.test(text))
		return CODEX_NOT_LOGGED_IN_ERROR;
	return firstLineOf(text.replace(/^error:\s*/iu, ""));
}

function itemEvents(item: unknown): AgentEvent[] {
	if (!isRecord(item) || typeof item.id !== "string") return [];
	if (item.type === "agent_message" && typeof item.text === "string")
		return item.text ? [{ kind: "text", text: item.text }] : [];
	if (item.type === "mcp_tool_call" && typeof item.tool === "string")
		return [
			{ kind: "tool", id: item.id, name: item.tool, state: toolState(item) },
		];
	return [];
}

function toolState(item: Record<string, unknown>): ToolState {
	if (item.status === "in_progress") return "running";
	return item.status === "failed" || item.error ? "error" : "done";
}

function errorMessage(error: unknown): string {
	return isRecord(error) && typeof error.message === "string"
		? error.message
		: "";
}
