import { buildCommand } from "@stricli/core";
import {
	callerPath,
	connectDataApi,
	errorMessage,
	resolveWorkspace,
} from "../lib/data-export.js";
import { formatSqlSummary, runSql, sqlFormatOf } from "../lib/sql-export.js";

interface SqlFlags {
	readonly out: string;
	readonly workspace?: string;
}

export const SQL_DESCRIPTION = `Runs one read-only SELECT (or WITH) over the views the MCP's sql tool exposes
(runs, calls, events, prompts, git_events, edges, setup_files, ci_jobs,
session_links, setup_snapshots, finding_runs, run_answers), scoped to the
workspace exactly as sql is, with its per-query memory and time limits but no
row cap. Columns and their meanings: the MCP's schema tool.

--out takes .jsonl (one JSON object per row) or .csv (with a header row). The
rows stream to <file>.partial, renamed to <file> once the query finished.`;

async function runSqlCommand(
	flags: SqlFlags,
	query: string,
): Promise<undefined | Error> {
	const out = callerPath(flags.out, process.cwd());
	if (!sqlFormatOf(out)) return new Error("--out must end in .jsonl or .csv");
	if (query.trim() === "")
		return new Error("sql takes one quoted SELECT. See 'opaline sql --help'.");
	const api = await connectDataApi();
	if (api instanceof Error) return api;
	try {
		const workspace = await resolveWorkspace(flags.workspace, process.cwd());
		const result = await runSql(
			{
				query,
				out,
				...(workspace !== undefined ? { workspace } : {}),
			},
			api,
		);
		process.stdout.write(`${formatSqlSummary(result)}\n`);
	} catch (error) {
		return new Error(errorMessage(error));
	}
}

export const sqlCommand = buildCommand({
	loader: async () => ({ default: runSqlCommand }),
	parameters: {
		positional: {
			kind: "tuple",
			parameters: [
				{
					brief: "One read-only SELECT or WITH query, quoted",
					parse: String,
					placeholder: "query",
				},
			],
		},
		flags: {
			out: {
				kind: "parsed",
				parse: String,
				brief: "Output file: .jsonl (one JSON object per row) or .csv",
			},
			workspace: {
				kind: "parsed",
				parse: String,
				brief: "Workspace slug or id (default: your default workspace)",
				optional: true,
			},
		},
	},
	docs: {
		brief:
			"Run one read-only SELECT over the MCP's views and write every row to a file",
		fullDescription: SQL_DESCRIPTION,
	},
});
