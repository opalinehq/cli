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

export type AgentStreamParser = (line: string) => AgentEvent[];

export const SESSION_NOT_FOUND_ERROR =
	"This conversation is not on this computer";

const MAX_ERROR_LENGTH = 300;

export function firstLineOf(text: string): string {
	const firstLine = text.split("\n").find((line) => line.trim()) ?? text;
	return firstLine.length > MAX_ERROR_LENGTH
		? `${firstLine.slice(0, MAX_ERROR_LENGTH - 1)}…`
		: firstLine;
}

export function parseJsonObject(
	line: string,
): Record<string, unknown> | undefined {
	try {
		const value: unknown = JSON.parse(line);
		return isRecord(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
