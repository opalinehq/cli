import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ORPCError } from "@orpc/client";
import type { CliDataSqlInput } from "../contracts/cli-data.js";
import {
	checkDataExport,
	type DataApi,
	describeDataError,
	LineSplitter,
	resolveWorkspace,
	withErrorContext,
} from "../lib/data-export.js";
import { formatSqlSummary, runSql } from "../lib/sql-export.js";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "opaline-sql-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function sqlApi(
	chunks: (input: CliDataSqlInput) => AsyncIterable<unknown>,
	seen: CliDataSqlInput[] = [],
): DataApi {
	return {
		sql: async (input) => {
			seen.push(input);
			return chunks(input);
		},
		pullPlan: async () => {
			throw new Error("unused");
		},
		pullTable: async () => {
			throw new Error("unused");
		},
	};
}

describe("opaline sql", () => {
	test("streams JSONL to <file>.partial and renames it once done", async () => {
		const seen: CliDataSqlInput[] = [];
		const out = join(root, "deep", "rows.jsonl");
		let partialSeen = false;
		const api = sqlApi(
			() =>
				(async function* () {
					yield { type: "lines", text: '{"a":1}\n' };
					partialSeen = existsSync(`${out}.partial`) && !existsSync(out);
					yield { type: "lines", text: '{"a":2}\n' };
					yield {
						type: "done",
						rows: 2,
						bytes: 16,
						columns: ["a"],
						notices: ["Rows are scoped to your sessions."],
					};
				})(),
			seen,
		);
		const result = await runSql(
			{ query: "SELECT 1", out, workspace: "acme" },
			api,
		);
		expect(seen).toEqual([
			{ workspace: "acme", query: "SELECT 1", format: "jsonl" },
		]);
		expect(partialSeen).toBe(true);
		expect(readFileSync(out, "utf8")).toBe('{"a":1}\n{"a":2}\n');
		expect(existsSync(`${out}.partial`)).toBe(false);
		expect(formatSqlSummary(result)).toBe(
			`Wrote 2 rows (16 B) to ${out}\nRows are scoped to your sessions.`,
		);
	});

	test("asks for CSV by the extension", async () => {
		const seen: CliDataSqlInput[] = [];
		const out = join(root, "rows.CSV");
		const api = sqlApi(
			() =>
				(async function* () {
					yield { type: "lines", text: "a\n1\n" };
					yield {
						type: "done",
						rows: 1,
						bytes: 4,
						columns: ["a"],
						notices: [],
					};
				})(),
			seen,
		);
		await runSql({ query: "SELECT 1 AS a", out }, api);
		expect(seen[0]?.format).toBe("csv");
		expect(seen[0] && "workspace" in seen[0]).toBe(false);
		expect(readFileSync(out, "utf8")).toBe("a\n1\n");
	});

	test("an error mid-stream keeps the previous file and removes the partial one", async () => {
		const out = join(root, "rows.jsonl");
		writeFileSync(out, "previous\n");
		const api = withErrorContext(
			sqlApi(() =>
				(async function* () {
					yield { type: "lines", text: '{"a":1}\n' };
					throw new ORPCError("EXPORT_TOO_LARGE", {
						status: 413,
						message: "The result is larger than 1 GiB; narrow the query.",
					});
				})(),
			),
			"https://opaline.so",
		);
		await expect(runSql({ query: "SELECT 1", out }, api)).rejects.toThrow(
			"The result is larger than 1 GiB; narrow the query.",
		);
		expect(readFileSync(out, "utf8")).toBe("previous\n");
		expect(existsSync(`${out}.partial`)).toBe(false);
	});

	test("refuses other extensions and streams that never finish", async () => {
		const api = sqlApi(() =>
			(async function* () {
				yield { type: "lines", text: "x\n" };
			})(),
		);
		await expect(
			runSql({ query: "SELECT 1", out: join(root, "rows.json") }, api),
		).rejects.toThrow("--out must end in .jsonl or .csv");
		await expect(
			runSql({ query: "SELECT 1", out: join(root, "rows.jsonl") }, api),
		).rejects.toThrow("The server ended the export before it finished.");
		expect(existsSync(join(root, "rows.jsonl"))).toBe(false);
	});
});

describe("data export capability and errors", () => {
	test("an ambiguous workspace names --workspace, and a flag wins over saved defaults", async () => {
		expect(
			describeDataError(
				new ORPCError("BAD_REQUEST", {
					message: "Choose an organization with --org or opaline set-org",
				}),
				"https://opaline.so",
			),
		).toContain("--workspace <slug>");
		expect(await resolveWorkspace("acme", tmpdir())).toBe("acme");
	});

	const statusClient = (status: () => Promise<unknown>) => ({
		cli: {
			authStatus: status as () => Promise<{
				capabilities?: { dataExport?: true };
			}>,
		},
	});

	test("servers without dataExport are reported, not called", async () => {
		expect(
			await checkDataExport(
				statusClient(async () => ({ capabilities: { dataExport: true } })),
				"https://opaline.so",
			),
		).toBeUndefined();
		expect(
			(
				await checkDataExport(
					statusClient(async () => ({ capabilities: {} })),
					"https://opaline.so",
				)
			)?.message,
		).toBe(
			"The Opaline server at https://opaline.so does not support data export yet.",
		);
		expect(
			(
				await checkDataExport(
					statusClient(async () => {
						throw new ORPCError("UNAUTHORIZED", { status: 401 });
					}),
					"https://opaline.so",
				)
			)?.message,
		).toBe(
			"Session expired or invalid. Run `opaline login` to re-authenticate.",
		);
		expect(
			(
				await checkDataExport(
					statusClient(async () => {
						throw new TypeError("fetch failed");
					}),
					"http://localhost:1",
				)
			)?.message,
		).toBe("Could not reach http://localhost:1: fetch failed");
	});

	test("line splitting keeps lines that span chunks", () => {
		const splitter = new LineSplitter();
		expect(splitter.push('{"a"')).toEqual([]);
		expect(splitter.push(':1}\r\n{"b":2}\n{')).toEqual(['{"a":1}', '{"b":2}']);
		expect(splitter.end()).toEqual(["{"]);
	});
});
