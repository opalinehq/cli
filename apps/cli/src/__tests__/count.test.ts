import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type CountOptions,
	checkOptions,
	countPull,
	defaultUnit,
	definitionOf,
} from "../lib/count.js";

const dir = mkdtempSync(join(tmpdir(), "opaline-count-"));

const record = (session: string, extra: Record<string, unknown>) => ({
	session_id: session,
	agent_id: "",
	turn_idx: 1,
	record_idx: 0,
	block_idx: 0,
	ts: "2026-10-10T10:00:00.000Z",
	kind: "meta",
	subtype: "",
	tool_name: "",
	call_id: "",
	text: "",
	...extra,
});

beforeAll(() => {
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(join(dir, "sessions"), { recursive: true });
	const s1 = [
		record("s1", { ts: "", kind: "meta", text: "no time" }),
		record("s1", {
			record_idx: 1,
			kind: "user_prompt",
			text: "please fix the build",
			turn_idx: 1,
		}),
		record("s1", {
			record_idx: 2,
			kind: "tool_call",
			tool_name: "Bash",
			call_id: "c1",
			text: "grep -r foo --include=*.ts",
		}),
		record("s1", {
			record_idx: 3,
			kind: "tool_result",
			call_id: "c1",
			text: "(eval):1: no matches found: --include=*.ts",
		}),
		record("s1", {
			record_idx: 3,
			block_idx: 1,
			kind: "tool_result",
			call_id: "c1",
			text: "(eval):1: no matches found: again",
		}),
		record("s1", {
			record_idx: 4,
			kind: "tool_call",
			tool_name: "Bash",
			call_id: "c2",
			text: "rg foo",
		}),
		record("s1", {
			record_idx: 5,
			kind: "tool_result",
			call_id: "c2",
			text: "(eval):1: no matches found: x",
		}),
		record("s1", {
			agent_id: "a1",
			record_idx: 0,
			kind: "user_prompt",
			subtype: "delegation",
			text: "please fix the build too",
		}),
		record("s1", {
			agent_id: "a1",
			record_idx: 1,
			kind: "tool_result",
			call_id: "c3",
			text: "(eval):1: no matches found: sub",
		}),
		record("s1", {
			agent_id: "a1",
			record_idx: 2,
			kind: "assistant_text",
			text: "Someone else is editing this file.",
		}),
	];
	const s2 = [
		record("s2", {
			ts: "2026-10-12T09:00:00.000Z",
			kind: "user_prompt",
			subtype: "queued",
			text: "Please FIX it",
		}),
		record("s2", {
			ts: "2026-10-12T09:00:01.000Z",
			record_idx: 1,
			kind: "tool_call",
			subtype: "script",
			tool_name: "exec",
			call_id: "x1",
			text: "exec_command({cmd: 'rg foo'})",
		}),
		record("s2", {
			ts: "2026-10-12T09:00:02.000Z",
			record_idx: 2,
			kind: "tool_result",
			subtype: "nested",
			call_id: "x1-1",
			text: "(eval):1: no matches found: inner",
		}),
	];
	const s3 = [
		record("s3", {
			ts: "2026-09-01T00:00:00.000Z",
			kind: "tool_result",
			call_id: "o1",
			text: "(eval):1: no matches found: old",
		}),
	];
	writeFileSync(
		join(dir, "sessions", "s1.jsonl"),
		`${s1.map((r) => JSON.stringify(r)).join("\n")}\n`,
	);
	writeFileSync(
		join(dir, "sessions", "s2.jsonl"),
		`${s2.map((r) => JSON.stringify(r)).join("\n")}\n`,
	);
	writeFileSync(
		join(dir, "sessions", "s3.jsonl"),
		`${s3.map((r) => JSON.stringify(r)).join("\n")}\n`,
	);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const options = (extra: Partial<CountOptions>): CountOptions => ({
	pattern: "no matches found",
	ignoreCase: false,
	in: "output",
	unit: "call",
	level: "agent",
	stream: "all",
	...extra,
});

test("calls count each tool call once however many result blocks match, the agent's calls by default", async () => {
	const result = await countPull(dir, options({}));
	expect(result.count).toBe(4);
	expect(result.sessions).toBe(2);
	expect(result.examples.map((e) => e.open)).toEqual(["s1#1", "s3#1"]);
	expect(result.examples[0]?.text).toContain("no matches found");
});

test("level inner counts only the commands a script ran; all counts both", async () => {
	expect((await countPull(dir, options({ level: "inner" }))).count).toBe(1);
	expect((await countPull(dir, options({ level: "all" }))).count).toBe(5);
});

test("stream main leaves subagent streams out", async () => {
	expect((await countPull(dir, options({ stream: "main" }))).count).toBe(3);
});

test("from and to keep sessions by their first timed record", async () => {
	const result = await countPull(
		dir,
		options({ level: "all", from: "2026-10-01", to: "2026-10-31" }),
	);
	expect(result.count).toBe(4);
	expect(result.scanned.sessions).toBe(2);
});

test("prompts are genuine: delegations are left out, queued prompts are in", async () => {
	const result = await countPull(
		dir,
		options({ pattern: "fix", ignoreCase: true, in: "prompt", unit: "prompt" }),
	);
	expect(result.count).toBe(2);
	expect(result.sessions).toBe(2);
});

test("sessions and assistant messages", async () => {
	expect(
		(await countPull(dir, options({ unit: "session", level: "all" }))).count,
	).toBe(3);
	const said = await countPull(
		dir,
		options({
			pattern: "[Ss]omeone else",
			in: "agent_message",
			unit: "message",
		}),
	);
	expect(said.count).toBe(1);
	expect(said.examples[0]?.open).toBe("s1:a1#1");
});

test("the definition says unit, level, stream, text and window, ready to quote", () => {
	expect(definitionOf(options({ from: "2026-10-06", to: "2026-11-03" }))).toBe(
		"tool calls the agent made (top-level or Codex script, not the commands a script ran) whose output (tool_result text) matches /no matches found/; main and subagent streams; sessions started 2026-10-06..2026-11-03 (UTC)",
	);
	expect(
		definitionOf(
			options({
				in: "prompt",
				unit: "prompt",
				stream: "main",
				ignoreCase: true,
				pattern: "fix",
			}),
		),
	).toBe(
		"genuine prompts whose text (user_prompt, delegations left out) matches /fix/i; main stream only",
	);
	expect(definitionOf(options({ unit: "session" }))).toBe(
		"sessions with a tool call the agent made (top-level or Codex script, not the commands a script ran) whose output (tool_result text) matches /no matches found/; main and subagent streams",
	);
});

test("options are checked before anything is read", () => {
	expect(checkOptions(options({ in: "prompt", unit: "call" }))).toBe(
		"--unit call needs --in output, command or any",
	);
	expect(checkOptions(options({ pattern: "(" }))).toContain(
		"not a valid regular expression",
	);
	expect(checkOptions(options({ from: "10/06" }))).toBe(
		"--from and --to take YYYY-MM-DD",
	);
	expect(defaultUnit("agent_message")).toBe("message");
});
