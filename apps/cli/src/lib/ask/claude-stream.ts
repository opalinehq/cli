export type ToolState = "running" | "done" | "error";

export type AgentEvent =
	| { readonly kind: "session"; readonly sessionId: string }
	| { readonly kind: "text"; readonly text: string }
	| {
			readonly kind: "tool";
			readonly id: string;
			readonly name: string;
			readonly state: ToolState;
	  }
	| { readonly kind: "result"; readonly ok: true }
	| { readonly kind: "result"; readonly ok: false; readonly error: string };

const OPALINE_TOOL_PREFIX = "mcp__opaline__";
const MAX_ERROR_LENGTH = 300;

export const SESSION_NOT_FOUND_ERROR =
	"Claude Code could not find this conversation on this computer";

export const NOT_LOGGED_IN_ERROR =
	"Claude Code is not logged in — run `claude` once";

export function createClaudeStreamParser(): (line: string) => AgentEvent[] {
	const toolNames = new Map<string, string>();
	return (line) => {
		const message = parseJsonObject(line);
		if (!message) return [];
		switch (message.type) {
			case "system":
				return sessionEvents(message);
			case "assistant":
				return assistantEvents(message, toolNames);
			case "user":
				return toolResultEvents(message, toolNames);
			case "result":
				return [resultEvent(message)];
			default:
				return [];
		}
	};
}

export function describeClaudeFailure(output: string): string | undefined {
	const text = output.trim();
	if (!text) return undefined;
	if (looksLikeLoginProblem(text)) return NOT_LOGGED_IN_ERROR;
	if (/no conversation found/iu.test(text)) return SESSION_NOT_FOUND_ERROR;
	return shorten(text);
}

function sessionEvents(message: Record<string, unknown>): AgentEvent[] {
	if (message.subtype !== "init" || typeof message.session_id !== "string")
		return [];
	return [{ kind: "session", sessionId: message.session_id }];
}

function assistantEvents(
	message: Record<string, unknown>,
	toolNames: Map<string, string>,
): AgentEvent[] {
	const events: AgentEvent[] = [];
	for (const block of contentBlocks(message)) {
		if (block.type === "text" && typeof block.text === "string" && block.text)
			events.push({ kind: "text", text: block.text });
		if (
			block.type === "tool_use" &&
			typeof block.id === "string" &&
			typeof block.name === "string"
		) {
			const name = displayToolName(block.name);
			toolNames.set(block.id, name);
			events.push({ kind: "tool", id: block.id, name, state: "running" });
		}
	}
	return events;
}

function toolResultEvents(
	message: Record<string, unknown>,
	toolNames: Map<string, string>,
): AgentEvent[] {
	const events: AgentEvent[] = [];
	for (const block of contentBlocks(message)) {
		if (block.type !== "tool_result" || typeof block.tool_use_id !== "string")
			continue;
		const name = toolNames.get(block.tool_use_id);
		if (name === undefined) continue;
		events.push({
			kind: "tool",
			id: block.tool_use_id,
			name,
			state: block.is_error === true ? "error" : "done",
		});
	}
	return events;
}

function resultEvent(message: Record<string, unknown>): AgentEvent {
	if (message.is_error !== true && message.subtype === "success")
		return { kind: "result", ok: true };
	const detail =
		resultText(message) ??
		firstError(message) ??
		describeResultSubtype(message.subtype);
	return {
		kind: "result",
		ok: false,
		error: describeClaudeFailure(detail) ?? describeResultSubtype(undefined),
	};
}

function resultText(message: Record<string, unknown>): string | undefined {
	return typeof message.result === "string" && message.result.trim()
		? message.result
		: undefined;
}

function firstError(message: Record<string, unknown>): string | undefined {
	if (!Array.isArray(message.errors)) return undefined;
	return message.errors.find(
		(error): error is string =>
			typeof error === "string" && error.trim() !== "",
	);
}

function describeResultSubtype(subtype: unknown): string {
	if (subtype === "error_max_turns")
		return "Claude Code stopped after too many turns";
	if (subtype === "error_max_budget_usd")
		return "Claude Code stopped at its spending limit";
	return "Claude Code stopped with an error";
}

function contentBlocks(
	message: Record<string, unknown>,
): Record<string, unknown>[] {
	const inner = message.message;
	if (!isRecord(inner) || !Array.isArray(inner.content)) return [];
	return inner.content.filter(isRecord);
}

function displayToolName(name: string): string {
	return name.startsWith(OPALINE_TOOL_PREFIX)
		? name.slice(OPALINE_TOOL_PREFIX.length)
		: name;
}

function looksLikeLoginProblem(text: string): boolean {
	return /not logged in|please run \/login|invalid api key|oauth token has expired/iu.test(
		text,
	);
}

function shorten(text: string): string {
	const firstLine = text.split("\n").find((line) => line.trim()) ?? text;
	return firstLine.length > MAX_ERROR_LENGTH
		? `${firstLine.slice(0, MAX_ERROR_LENGTH - 1)}…`
		: firstLine;
}

function parseJsonObject(line: string): Record<string, unknown> | undefined {
	try {
		const value: unknown = JSON.parse(line);
		return isRecord(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
