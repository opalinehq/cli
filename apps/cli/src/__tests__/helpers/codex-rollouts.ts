import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Fake Codex rollouts laid out like Codex writes them:
 * `<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<local time>-<thread id>.jsonl`.
 */

export interface CodexRolloutOptions {
	readonly threadId: string;
	/** Defaults to the UUIDv7 time of `threadId`. */
	readonly date?: Date;
	readonly cwd?: string;
	/** Spawned subagent of this parent (Codex desktop `thread_spawn`). */
	readonly spawnedBy?: string;
	/** Older shape: only `payload.parent_thread_id`. */
	readonly parentThreadIdOnly?: string;
	/** Guardian approval reviewer attached to this parent. */
	readonly guardianOf?: string;
	readonly userText?: string;
}

/** A UUIDv7-shaped id carrying `milliseconds` as its creation time. */
export function codexThreadId(milliseconds: number): string {
	const time = milliseconds.toString(16).padStart(12, "0");
	const random = Math.floor(Math.random() * 0xfff_ffff_ffff)
		.toString(16)
		.padStart(12, "0");
	return `${time.slice(0, 8)}-${time.slice(8, 12)}-7abc-8def-${random}`;
}

export async function writeCodexRollout(
	codexHome: string,
	options: CodexRolloutOptions,
): Promise<string> {
	const date = options.date ?? new Date(readUuidV7Time(options.threadId));
	const pad = (value: number) => value.toString().padStart(2, "0");
	const directory = join(
		codexHome,
		"sessions",
		date.getFullYear().toString(),
		pad(date.getMonth() + 1),
		pad(date.getDate()),
	);
	await mkdir(directory, { recursive: true });
	const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
	const path = join(directory, `rollout-${stamp}-${options.threadId}.jsonl`);
	const parent =
		options.spawnedBy ?? options.parentThreadIdOnly ?? options.guardianOf;
	const source = options.spawnedBy
		? {
				subagent: {
					thread_spawn: {
						agent_nickname: "Euclid",
						depth: 1,
						parent_thread_id: options.spawnedBy,
					},
				},
			}
		: options.guardianOf
			? { subagent: { other: "guardian" } }
			: "vscode";
	const lines = [
		{
			payload: {
				cwd: options.cwd ?? "/Users/test/Documents/Codex/chat",
				id: options.threadId,
				originator: "Codex Desktop",
				parent_thread_id: parent,
				source,
				thread_source: options.spawnedBy
					? "subagent"
					: options.guardianOf
						? "guardian_review"
						: options.parentThreadIdOnly
							? undefined
							: "user",
			},
			timestamp: date.toISOString(),
			type: "session_meta",
		},
		{
			payload: {
				content: [
					{
						text: options.userText ?? "How many sessions failed last week?",
						type: "input_text",
					},
				],
				role: "user",
				type: "message",
			},
			timestamp: new Date(date.getTime() + 1_000).toISOString(),
			type: "response_item",
		},
	];
	await writeFile(
		path,
		`${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
	);
	return path;
}

/** Append the assistant's answer, as Codex does when a turn ends. */
export async function appendCodexAssistantMessage(
	path: string,
	text: string,
): Promise<void> {
	await appendFile(
		path,
		`${JSON.stringify({
			payload: {
				content: [{ text, type: "output_text" }],
				role: "assistant",
				type: "message",
			},
			timestamp: new Date().toISOString(),
			type: "response_item",
		})}\n`,
	);
}

function readUuidV7Time(id: string): number {
	return Number.parseInt(id.replaceAll("-", "").slice(0, 12), 16);
}
