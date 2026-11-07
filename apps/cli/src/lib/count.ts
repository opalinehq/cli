import { createReadStream, readdirSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

export const COUNT_IN = [
	"output",
	"command",
	"prompt",
	"agent_message",
	"any",
] as const;
export const COUNT_UNITS = ["call", "session", "prompt", "message"] as const;
export const COUNT_LEVELS = ["agent", "inner", "all"] as const;
export const COUNT_STREAMS = ["main", "all"] as const;

export type CountIn = (typeof COUNT_IN)[number];
export type CountUnit = (typeof COUNT_UNITS)[number];

export interface CountOptions {
	readonly pattern: string;
	readonly ignoreCase: boolean;
	readonly in: CountIn;
	readonly unit: CountUnit;
	readonly level: (typeof COUNT_LEVELS)[number];
	readonly stream: (typeof COUNT_STREAMS)[number];
	readonly from?: string;
	readonly to?: string;
}

export interface CountRecord {
	readonly session_id: string;
	readonly agent_id: string;
	readonly turn_idx: number;
	readonly record_idx: number;
	readonly block_idx: number;
	readonly ts: string;
	readonly kind: string;
	readonly subtype: string;
	readonly tool_name: string;
	readonly call_id: string;
	readonly text: string;
}

export interface CountExample {
	readonly session: string;
	readonly open: string;
	readonly text: string;
}

export interface CountResult {
	readonly count: number;
	readonly sessions: number;
	readonly definition: string;
	readonly examples: CountExample[];
	readonly scanned: { readonly sessions: number; readonly records: number };
}

const KINDS: Record<Exclude<CountIn, "any">, string> = {
	output: "tool_result",
	command: "tool_call",
	prompt: "user_prompt",
	agent_message: "assistant_text",
};

export function defaultUnit(where: CountIn): CountUnit {
	return where === "output" || where === "command"
		? "call"
		: where === "prompt"
			? "prompt"
			: where === "agent_message"
				? "message"
				: "session";
}

export function checkOptions(options: CountOptions): string | null {
	const calls =
		options.in === "output" || options.in === "command" || options.in === "any";
	if (options.unit === "call" && !calls)
		return "--unit call needs --in output, command or any";
	if (
		options.unit === "prompt" &&
		options.in !== "prompt" &&
		options.in !== "any"
	)
		return "--unit prompt needs --in prompt or any";
	if (
		options.unit === "message" &&
		options.in !== "agent_message" &&
		options.in !== "any"
	)
		return "--unit message needs --in agent_message or any";
	for (const day of [options.from, options.to])
		if (day !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(day))
			return "--from and --to take YYYY-MM-DD";
	try {
		new RegExp(options.pattern, options.ignoreCase ? "iu" : "u");
	} catch (error) {
		return `--pattern is not a valid regular expression: ${(error as Error).message}`;
	}
	return null;
}

const isCall = (record: CountRecord) =>
	record.kind === "tool_call" || record.kind === "tool_result";

export function kindMatches(
	record: CountRecord,
	options: CountOptions,
): boolean {
	const kinds =
		options.in === "any" ? Object.values(KINDS) : [KINDS[options.in]];
	if (!kinds.includes(record.kind)) return false;
	if (record.kind === "user_prompt" && record.subtype === "delegation")
		return false;
	if (options.stream === "main" && record.agent_id !== "") return false;
	if (isCall(record)) {
		const inner = record.subtype === "nested";
		if (options.level === "agent" && inner) return false;
		if (options.level === "inner" && !inner) return false;
	}
	if (options.unit === "call" && !isCall(record)) return false;
	if (options.unit === "prompt" && record.kind !== "user_prompt") return false;
	if (options.unit === "message" && record.kind !== "assistant_text")
		return false;
	return true;
}

function unitKey(record: CountRecord, unit: CountUnit): string {
	if (unit === "session") return record.session_id;
	if (unit === "call")
		return `${record.session_id}\u0000${record.agent_id}\u0000${record.call_id || `r${record.record_idx}`}`;
	return `${record.session_id}\u0000${record.agent_id}\u0000${record.record_idx}\u0000${record.block_idx}`;
}

function snippet(text: string, regex: RegExp): string {
	const match = regex.exec(text);
	const at = match?.index ?? 0;
	const start = Math.max(0, at - 60);
	const end = Math.min(text.length, at + (match?.[0].length ?? 0) + 60);
	return `${start > 0 ? "…" : ""}${text.slice(start, end).replace(/\s+/gu, " ")}${end < text.length ? "…" : ""}`;
}

const UNIT_WORDS: Record<CountUnit, string> = {
	call: "tool calls",
	session: "sessions",
	prompt: "genuine prompts",
	message: "assistant messages",
};

const IN_WORDS: Record<CountIn, string> = {
	output: "whose output (tool_result text)",
	command: "whose command or input (tool_call text)",
	prompt: "whose text (user_prompt, delegations left out)",
	agent_message: "whose text (assistant_text)",
	any: "with a tool call, tool output, genuine prompt or assistant message that",
};

export function definitionOf(options: CountOptions): string {
	const level =
		options.in === "prompt" || options.in === "agent_message"
			? ""
			: options.level === "agent"
				? " the agent made (top-level or Codex script, not the commands a script ran)"
				: options.level === "inner"
					? " a Codex script ran (inner)"
					: " at every level (agent and inner)";
	const subject =
		options.unit === "session"
			? `sessions with ${options.in === "any" ? "a record" : options.in === "prompt" ? "a genuine prompt" : options.in === "agent_message" ? "an assistant message" : `a tool call${level}`}`
			: `${UNIT_WORDS[options.unit]}${options.unit === "call" ? level : ""}`;
	const where = options.in === "any" ? IN_WORDS.any : IN_WORDS[options.in];
	const stream =
		options.stream === "main"
			? "main stream only"
			: "main and subagent streams";
	const window =
		options.from || options.to
			? `; sessions started ${options.from ?? "…"}..${options.to ?? "…"} (UTC)`
			: "";
	return `${subject} ${where} matches /${options.pattern}/${options.ignoreCase ? "i" : ""}; ${stream}${window}`;
}

export class Counter {
	private readonly regex: RegExp;
	private readonly units = new Set<string>();
	private readonly sessions = new Set<string>();
	private readonly examples: CountExample[] = [];
	private scannedSessions = 0;
	private scannedRecords = 0;

	constructor(private readonly options: CountOptions) {
		this.regex = new RegExp(options.pattern, options.ignoreCase ? "iu" : "u");
	}

	startSession(start: string): boolean {
		const day = start.slice(0, 10);
		if (this.options.from && day < this.options.from) return false;
		if (this.options.to && day > this.options.to) return false;
		this.scannedSessions++;
		return true;
	}

	add(record: CountRecord): void {
		this.scannedRecords++;
		if (!kindMatches(record, this.options)) return;
		if (!this.regex.test(record.text ?? "")) return;
		const key = unitKey(record, this.options.unit);
		if (this.units.has(key)) return;
		this.units.add(key);
		this.sessions.add(record.session_id);
		if (
			this.examples.length < 3 &&
			!this.examples.some((e) => e.session === record.session_id)
		)
			this.examples.push({
				session: record.session_id,
				open: `${record.session_id}${record.agent_id ? `:${record.agent_id}` : ""}#${record.turn_idx}`,
				text: snippet(
					record.text,
					new RegExp(
						this.options.pattern,
						this.options.ignoreCase ? "iu" : "u",
					),
				),
			});
	}

	result(): CountResult {
		return {
			count: this.units.size,
			sessions: this.sessions.size,
			definition: definitionOf(this.options),
			examples: this.examples,
			scanned: { sessions: this.scannedSessions, records: this.scannedRecords },
		};
	}
}

export async function countPull(
	dir: string,
	options: CountOptions,
): Promise<CountResult> {
	const counter = new Counter(options);
	const files = readdirSync(join(dir, "sessions"))
		.filter((name) => name.endsWith(".jsonl"))
		.sort();
	for (const name of files) {
		const lines = createInterface({
			input: createReadStream(join(dir, "sessions", name), {
				encoding: "utf8",
			}),
			crlfDelay: Number.POSITIVE_INFINITY,
		});
		let decided: boolean | null = null;
		const waiting: CountRecord[] = [];
		for await (const line of lines) {
			if (!line) continue;
			const record = JSON.parse(line) as CountRecord;
			if (decided === null) {
				if (!record.ts) {
					waiting.push(record);
					continue;
				}
				decided = counter.startSession(record.ts);
				if (!decided) break;
				for (const held of waiting.splice(0)) counter.add(held);
			}
			counter.add(record);
		}
		lines.close();
	}
	return counter.result();
}
