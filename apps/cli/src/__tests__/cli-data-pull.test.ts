import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ORPCError } from "@orpc/client";
import { resolvePullDir } from "../commands/count.js";
import type {
	CliDataPullPlan,
	CliDataPullPlanSession,
	CliDataPullTableInput,
	CliDataTable,
} from "../contracts/cli-data.js";
import { countPull } from "../lib/count.js";
import type { DataApi, Progress } from "../lib/data-export.js";
import {
	batchSessions,
	checkPullOptions,
	defaultPullDir,
	type PullEnv,
	parseSessionList,
	runPull,
} from "../lib/pull.js";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "opaline-pull-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

const quiet: Progress = { update: () => {}, warn: () => {}, stop: () => {} };

const session = (
	id: string,
	extra: Partial<CliDataPullPlanSession> = {},
): CliDataPullPlanSession => ({
	sessionId: id,
	source: "claude_code",
	startedAt: "2026-10-10T10:00:00.000Z",
	records: 0,
	bytes: 0,
	...extra,
});

const planOf = (
	sessions: CliDataPullPlanSession[],
	extra: Partial<CliDataPullPlan> = {},
): CliDataPullPlan => ({
	workspace: { id: "org_1", slug: "acme" },
	scope: {
		repository: "github.com/acme/widgets",
		from: "2026-10-01",
		to: "2026-10-31",
	},
	sessions,
	pattern: null,
	notices: [],
	...extra,
});

const record = (sessionId: string, recordIdx: number, text = "x") =>
	JSON.stringify({
		session_id: sessionId,
		agent_id: "",
		turn_idx: 1,
		record_idx: recordIdx,
		block_idx: 0,
		ts: "2026-10-10T10:00:00.000Z",
		kind: "tool_result",
		subtype: "",
		tool_name: "Bash",
		call_id: `c${recordIdx}`,
		text,
	});

type Table = (sessions: string[], attempt: number) => string[];

async function* stream(lines: string[], notices: string[] = []) {
	const text = lines.map((line) => `${line}\n`).join("");
	for (let i = 0; i < text.length; i += 37)
		yield { type: "lines", text: text.slice(i, i + 37) };
	yield {
		type: "done",
		rows: lines.length,
		bytes: Buffer.byteLength(text),
		columns: [],
		notices,
	};
}

function fakeApi(
	plan: CliDataPullPlan,
	tables: Partial<Record<CliDataTable, Table>>,
	override: Partial<
		Record<
			CliDataTable,
			(input: CliDataPullTableInput, attempt: number) => AsyncIterable<unknown>
		>
	> = {},
) {
	const calls: CliDataPullTableInput[] = [];
	const plans: unknown[] = [];
	const attempts = new Map<string, number>();
	const api: DataApi = {
		sql: async () => stream([]),
		pullPlan: async (input) => {
			plans.push(input);
			return plan;
		},
		pullTable: async (input) => {
			calls.push(input);
			const key = `${input.table}:${input.sessions.join(",")}`;
			const attempt = (attempts.get(key) ?? 0) + 1;
			attempts.set(key, attempt);
			const custom = override[input.table];
			if (custom) return custom(input, attempt);
			return stream(tables[input.table]?.(input.sessions, attempt) ?? []);
		},
	};
	return { api, calls, plans };
}

const envOf = (api: DataApi, extra: Partial<PullEnv> = {}): PullEnv => ({
	api,
	cacheRoot: join(root, "cache"),
	version: "9.9.9",
	progress: quiet,
	now: () => new Date("2026-11-07T12:00:00.000Z"),
	sleep: async () => {},
	...extra,
});

describe("opaline pull", () => {
	test("splits records per session, writes every table, dedupes GitHub rows across batches and records the pull", async () => {
		const ids = Array.from(
			{ length: 201 },
			(_, i) => `s${String(i).padStart(3, "0")}`,
		);
		const plan = planOf(
			ids.map((id, i) => session(id, i < 3 ? { records: 2, bytes: 400 } : {})),
			{ notices: ["plan notice"] },
		);
		const records: Record<string, string[]> = {
			s000: [record("s000", 1, "a\nb"), record("s000", 2)],
			s001: [record("s001", 1), record("s001", 2, "ünïcode")],
			s002: [record("s002", 1), record("s002", 2)],
		};
		const { api, calls, plans } = fakeApi(plan, {
			records: (sessions) => sessions.flatMap((id) => records[id] ?? []),
			runs: (sessions) =>
				sessions.map((id) => JSON.stringify({ session_id: id, turn_idx: 1 })),
			github_repositories: () => [
				JSON.stringify({ repository_id: "r1", full_name: "acme/widgets" }),
			],
			ci_jobs: () => [JSON.stringify({ ci_run_id: "run1", job_id: "j1" })],
			git: (sessions) =>
				sessions.slice(0, 1).map((id) => JSON.stringify({ session_id: id })),
		});
		const result = await runPull(
			{ repo: "acme/widgets", from: "2026-10-01", to: "2026-10-31" },
			envOf(api, { recordsBatchBytes: 800 }),
		);
		const dir = join(
			root,
			"cache",
			"pulls",
			"acme",
			"widgets_2026-10-01_2026-10-31",
		);
		expect(result.dir).toBe(dir);
		expect(plans).toEqual([
			{ repository: "acme/widgets", from: "2026-10-01", to: "2026-10-31" },
		]);
		const recordCalls = calls.filter((c) => c.table === "records");
		expect(recordCalls.map((c) => c.sessions.length)).toEqual([2, 199]);
		expect(calls.every((c) => c.workspace === "org_1")).toBe(true);
		expect(
			calls.filter((c) => c.table === "runs").map((c) => c.sessions.length),
		).toEqual([200, 1]);

		expect(readdirSync(join(dir, "sessions")).sort()).toEqual([
			"s000.jsonl",
			"s001.jsonl",
			"s002.jsonl",
		]);
		expect(readFileSync(join(dir, "sessions", "s001.jsonl"), "utf8")).toBe(
			`${records.s001?.join("\n")}\n`,
		);
		expect(
			readFileSync(join(dir, "runs.jsonl"), "utf8").trim().split("\n"),
		).toHaveLength(201);
		expect(readFileSync(join(dir, "github_repositories.jsonl"), "utf8")).toBe(
			`${JSON.stringify({ repository_id: "r1", full_name: "acme/widgets" })}\n`,
		);
		expect(
			readFileSync(join(dir, "ci_jobs.jsonl"), "utf8").split("\n"),
		).toHaveLength(2);
		expect(
			readFileSync(join(dir, "git.jsonl"), "utf8").trim().split("\n"),
		).toHaveLength(2);
		expect(existsSync(join(dir, "edges.jsonl"))).toBe(true);
		expect(existsSync(join(dir, "pattern.json"))).toBe(false);

		const manifest = JSON.parse(
			readFileSync(join(dir, "MANIFEST.json"), "utf8"),
		);
		expect(manifest.cli_version).toBe("9.9.9");
		expect(manifest.created_at).toBe("2026-11-07T12:00:00.000Z");
		expect(manifest.workspace).toEqual({ id: "org_1", slug: "acme" });
		expect(manifest.scope).toEqual({
			repository: "github.com/acme/widgets",
			from: "2026-10-01",
			to: "2026-10-31",
		});
		expect(manifest.counts.records).toBe(6);
		expect(manifest.files["sessions/<session_id>.jsonl"]).toMatchObject({
			files: 3,
			rows: 6,
		});
		expect(manifest.files["runs.jsonl"].rows).toBe(201);
		expect(manifest.files["github_repositories.jsonl"]).toMatchObject({
			rows: 1,
			description: "the workspace's connected GitHub repositories",
		});
		expect(manifest.files["git.jsonl"].description).toBe(
			"git_events view rows",
		);
		expect(manifest.sessions).toHaveLength(201);
		expect(manifest.notices).toEqual(["plan notice"]);
		expect(readFileSync(join(root, "cache", "pulls", "LAST"), "utf8")).toBe(
			`${dir}\n`,
		);
		expect(resolvePullDir(undefined, root, join(root, "cache"))).toBe(dir);
		const counted = await countPull(dir, {
			pattern: "ünïcode",
			ignoreCase: false,
			in: "output",
			unit: "call",
			level: "agent",
			stream: "all",
		});
		expect(counted.count).toBe(1);
		expect(
			readdirSync(join(root, "cache", "pulls", "acme")).filter((name) =>
				name.startsWith("."),
			),
		).toEqual([]);
	});

	test("a failed batch is retried from scratch and leaves no partial lines behind", async () => {
		const plan = planOf([
			session("s1", { records: 2, bytes: 10 }),
			session("s2", { records: 1, bytes: 10 }),
		]);
		const lines = [record("s1", 1), record("s1", 2), record("s2", 1)];
		const warnings: string[] = [];
		const slept: number[] = [];
		const { api } = fakeApi(
			plan,
			{},
			{
				records: (_input, attempt) =>
					(async function* () {
						yield { type: "lines", text: `${lines[0]}\n${lines[1]}\n` };
						if (attempt < 3) throw new TypeError("fetch failed");
						yield { type: "lines", text: `${lines[2]}\n` };
						yield { type: "done", rows: 3, bytes: 1, columns: [], notices: [] };
					})(),
				runs: (_input, attempt) =>
					(async function* () {
						yield { type: "lines", text: '{"session_id":"s1"}\n' };
						if (attempt === 1)
							throw new ORPCError("INTERNAL_SERVER_ERROR", { status: 500 });
						yield { type: "lines", text: '{"session_id":"s2"}\n' };
						yield {
							type: "done",
							rows: 2,
							bytes: 1,
							columns: [],
							notices: ["cut"],
						};
					})(),
			},
		);
		const result = await runPull(
			{ sessions: ["s1", "s2"] },
			envOf(api, {
				progress: { ...quiet, warn: (m) => warnings.push(m) },
				sleep: async (ms) => {
					slept.push(ms);
				},
			}),
		);
		expect(slept).toEqual([1000, 4000, 1000]);
		expect(warnings[0]).toContain("records batch 1/1 failed (fetch failed)");
		expect(readFileSync(join(result.dir, "sessions", "s1.jsonl"), "utf8")).toBe(
			`${lines[0]}\n${lines[1]}\n`,
		);
		expect(readFileSync(join(result.dir, "runs.jsonl"), "utf8")).toBe(
			'{"session_id":"s1"}\n{"session_id":"s2"}\n',
		);
		expect(result.files["runs.jsonl"]).toEqual({ rows: 2, bytes: 40 });
		expect(result.notices).toEqual(["runs: cut"]);
		expect(result.dir).toBe(
			join(root, "cache", "pulls", "acme", "widgets_2026-10-01_2026-10-31"),
		);
	});

	test("a refusal is not retried, keeps the previous pull and cleans up", async () => {
		const plan = planOf([session("s1", { records: 1, bytes: 10 })]);
		const ok = fakeApi(plan, { records: () => [record("s1", 1)] });
		const first = await runPull({ sessions: ["s1"] }, envOf(ok.api));
		writeFileSync(join(first.dir, "notes.txt"), "mine");
		let attempts = 0;
		const refusing = fakeApi(
			plan,
			{},
			{
				calls: () => {
					attempts++;
					throw new ORPCError("PULL_TOO_LARGE", {
						status: 413,
						message: "This pull reads more than the export limit.",
					});
				},
			},
		);
		await expect(
			runPull({ sessions: ["s1"] }, envOf(refusing.api)),
		).rejects.toThrow("This pull reads more than the export limit.");
		expect(attempts).toBe(1);
		expect(readFileSync(join(first.dir, "notes.txt"), "utf8")).toBe("mine");
		expect(
			readdirSync(join(root, "cache", "pulls", "acme")).filter((n) =>
				n.startsWith("."),
			),
		).toEqual([]);

		const again = await runPull({ sessions: ["s1"] }, envOf(ok.api));
		expect(again.dir).toBe(first.dir);
		expect(existsSync(join(first.dir, "notes.txt"))).toBe(false);
	});

	test("a stream that ends before done fails after two retries", async () => {
		const plan = planOf([session("s1", { records: 1, bytes: 10 })]);
		let attempts = 0;
		const { api } = fakeApi(
			plan,
			{},
			{
				records: () => {
					attempts++;
					return (async function* () {
						yield { type: "lines", text: `${record("s1", 1)}\n` };
					})();
				},
			},
		);
		await expect(runPull({ sessions: ["s1"] }, envOf(api))).rejects.toThrow(
			"The server ended the export before it finished.",
		);
		expect(attempts).toBe(3);
		expect(existsSync(join(root, "cache", "pulls", "LAST"))).toBe(false);
	});

	test("--pattern writes pattern.json and names the directory after the pattern", async () => {
		const plan = planOf([session("s1", { records: 1, bytes: 10 })], {
			scope: { repository: null, from: "2026-10-08", to: "2026-11-06" },
			pattern: { id: "fc_1a2b3c4d5e", kind: "failed_command", runs: [] },
		});
		const { api, plans } = fakeApi(plan, { records: () => [record("s1", 1)] });
		const result = await runPull({ pattern: "fc_1a2b3c4d5e" }, envOf(api));
		expect(plans).toEqual([{ pattern: "fc_1a2b3c4d5e" }]);
		expect(result.dir).toBe(
			join(
				root,
				"cache",
				"pulls",
				"acme",
				"sessions_2026-10-08_2026-11-06_fc_1a2b3c4d5e",
			),
		);
		expect(
			JSON.parse(readFileSync(join(result.dir, "pattern.json"), "utf8")),
		).toEqual({
			id: "fc_1a2b3c4d5e",
			scope: { repository: null, from: "2026-10-08", to: "2026-11-06" },
			sessions: ["s1"],
			pattern: { id: "fc_1a2b3c4d5e", kind: "failed_command", runs: [] },
		});
	});

	test("--out refuses a directory that is not an earlier pull, and an empty plan says why", async () => {
		const out = join(root, "mine");
		mkdirSync(out);
		writeFileSync(join(out, "keep.txt"), "x");
		const { api } = fakeApi(planOf([session("s1")]), {});
		await expect(
			runPull({ sessions: ["s1"], out }, envOf(api)),
		).rejects.toThrow("is not an earlier pull");
		expect(readFileSync(join(out, "keep.txt"), "utf8")).toBe("x");

		const empty = fakeApi(
			planOf([], { notices: ["No runs in this window."] }),
			{},
		);
		await expect(
			runPull({ repo: "widgets" }, envOf(empty.api)),
		).rejects.toThrow(
			"No sessions selected (repositories are keyed like github.com/owner/name). No runs in this window.",
		);
	});

	test("removes temp directories that a killed pull left behind", async () => {
		const plan = planOf([session("s1", { records: 1, bytes: 10 })]);
		const { api } = fakeApi(plan, { records: () => [record("s1", 1)] });
		const parent = join(root, "cache", "pulls", "acme");
		const name = "widgets_2026-10-01_2026-10-31";
		mkdirSync(join(parent, `.${name}.partial-999999999-abcd`, "sessions"), {
			recursive: true,
		});
		mkdirSync(join(parent, `.${name}.partial-${process.pid}-live`));
		mkdirSync(join(parent, ".other.partial-999999999-abcd"));
		await runPull({ sessions: ["s1"] }, envOf(api));
		expect(readdirSync(parent).sort()).toEqual(
			[
				`.${name}.partial-${process.pid}-live`,
				".other.partial-999999999-abcd",
				name,
			].sort(),
		);
	});

	test("records the planned and received record counts when they differ", async () => {
		const plan = planOf([session("s1", { records: 3, bytes: 10 })]);
		const { api } = fakeApi(plan, { records: () => [record("s1", 1)] });
		const result = await runPull({ sessions: ["s1"] }, envOf(api));
		expect(result.notices).toEqual([
			"records: 1 sessions returned a different number of records than planned (first: s1, planned 3, got 1)",
		]);
	});
});

describe("pull options", () => {
	test("session files: JSON array, lines, or an object of ids or rows", () => {
		expect(parseSessionList('["a","b","a"]', "f")).toEqual(["a", "b"]);
		expect(parseSessionList("a\n# note\n\nb\r\n", "f")).toEqual(["a", "b"]);
		expect(
			parseSessionList('{"sessions":[{"session_id":"a"},"b"]}', "f"),
		).toEqual(["a", "b"]);
		expect(() => parseSessionList('{"ids":[]}', "f")).toThrow(
			'f: expected a JSON array or an object with a "sessions" array',
		);
		expect(() => parseSessionList('["../etc"]', "f")).toThrow(
			'f: 1 entries are not session ids (first: "../etc")',
		);
	});

	test("checks flags before calling the server", () => {
		expect(checkPullOptions({})).toContain("pull needs --sessions");
		expect(checkPullOptions({ from: "10/01" })).toBe(
			"--from must be YYYY-MM-DD",
		);
		expect(
			checkPullOptions({ pattern: "fc_1a2b3c4d5e", sessions: ["a"] }),
		).toBe("--pattern picks the sessions itself; leave out --sessions");
		expect(checkPullOptions({ pattern: "nope" })).toContain(
			"--pattern takes a pattern id",
		);
		expect(
			checkPullOptions({
				sessions: Array.from({ length: 5001 }, (_, i) => `s${i}`),
				sessionsFile: "ids.txt",
			}),
		).toBe("pull takes at most 5,000 sessions; ids.txt names 5,001");
		expect(checkPullOptions({ repo: "widgets" })).toBeNull();
	});

	test("records batches stay under the byte budget and 200 sessions; a large session goes alone", () => {
		const sizes = [10, 10, 100, 5, 5];
		const batches = batchSessions(
			sizes.map((bytes, i) => session(`s${i}`, { bytes })),
			30,
		);
		expect(batches.map((b) => b.map((s) => s.sessionId))).toEqual([
			["s0", "s1"],
			["s2"],
			["s3", "s4"],
		]);
		expect(
			batchSessions(
				Array.from({ length: 401 }, (_, i) => session(`s${i}`)),
				1,
			).map((b) => b.length),
		).toEqual([200, 200, 1]);
	});

	test("default directories", () => {
		const plan = planOf([], {
			scope: { repository: null, from: null, to: null },
		});
		expect(defaultPullDir("/c", plan, {})).toBe(
			"/c/pulls/acme/sessions_all_all",
		);
		expect(
			defaultPullDir(
				"/c",
				{ ...plan, workspace: { id: "org", slug: "../x" } },
				{
					repo: "github.com/acme/w idgets/",
					from: "2026-10-01",
				},
			),
		).toBe("/c/pulls/x/w-idgets_2026-10-01_all");
	});

	test("count reads the last pull unless --pull is given", () => {
		const cache = join(root, "cache");
		expect(resolvePullDir(undefined, root, cache)).toBeInstanceOf(Error);
		expect(resolvePullDir("p", root, cache)).toBe(join(root, "p"));
	});
});
