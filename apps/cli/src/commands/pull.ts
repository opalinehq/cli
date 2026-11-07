import { buildCommand } from "@stricli/core";
import pkg from "../../package.json" with { type: "json" };
import {
	cacheRoot,
	callerPath,
	connectDataApi,
	createProgress,
	errorMessage,
} from "../lib/data-export.js";
import {
	checkPullOptions,
	formatPullSummary,
	PULL_FILES,
	type PullOptions,
	readSessionFile,
	runPull,
} from "../lib/pull.js";

interface PullFlags {
	readonly sessions?: string;
	readonly repo?: string;
	readonly from?: string;
	readonly to?: string;
	readonly pattern?: string;
	readonly out?: string;
	readonly workspace?: string;
}

const width = Math.max(...PULL_FILES.map((f) => f.file.length));

export const PULL_DESCRIPTION = `Selects sessions by id (--sessions), or by repository and session start date
(UTC, --from and --to inclusive), or both (their intersection). With
--pattern, only the sessions behind that pattern (an id from the MCP's patterns
tool, e.g. fc_1a2b3c4d5e), found over the same --repo, --from and --to the
patterns call used (default: the last 30 days), plus pattern.json.

--sessions takes a JSON array of ids, one id per line, or a JSON object with a
"sessions" array (of ids or of {"session_id": ...}).

Writes:
${PULL_FILES.map((f) => `  ${f.file.padEnd(width)}  ${f.description}`).join("\n")}

Default directory: ~/.cache/opaline/pulls/<workspace>/<repo or "sessions">_<from or "all">_<to or "all">[_<pattern>].
The directory is replaced on every pull; ~/.cache/opaline/pulls/LAST names the
latest pull, which opaline count reads by default.`;

async function runPullCommand(flags: PullFlags): Promise<undefined | Error> {
	const cwd = process.cwd();
	let options: PullOptions;
	try {
		const sessionsFile =
			flags.sessions !== undefined
				? callerPath(flags.sessions, cwd)
				: undefined;
		options = {
			...(flags.workspace !== undefined ? { workspace: flags.workspace } : {}),
			...(flags.repo !== undefined ? { repo: flags.repo } : {}),
			...(flags.from !== undefined ? { from: flags.from } : {}),
			...(flags.to !== undefined ? { to: flags.to } : {}),
			...(flags.pattern !== undefined ? { pattern: flags.pattern } : {}),
			...(flags.out !== undefined ? { out: callerPath(flags.out, cwd) } : {}),
			...(sessionsFile !== undefined
				? { sessionsFile, sessions: readSessionFile(sessionsFile) }
				: {}),
		};
	} catch (error) {
		return new Error(errorMessage(error));
	}
	const invalid = checkPullOptions(options);
	if (invalid) return new Error(invalid);
	const api = await connectDataApi();
	if (api instanceof Error) return api;
	try {
		const result = await runPull(options, {
			api,
			cacheRoot: cacheRoot(),
			version: pkg.version,
			progress: createProgress(),
		});
		process.stdout.write(`${formatPullSummary(result)}\n`);
	} catch (error) {
		return new Error(`opaline pull failed: ${errorMessage(error)}`);
	}
}

export const pullCommand = buildCommand({
	loader: async () => ({ default: runPullCommand }),
	parameters: {
		flags: {
			sessions: {
				kind: "parsed",
				parse: String,
				brief:
					'File of session ids (JSON array, one per line, or {"sessions": [...]})',
				optional: true,
			},
			repo: {
				kind: "parsed",
				parse: String,
				brief:
					"runs.repository: github.com/owner/name, or its last parts (owner/name, name)",
				optional: true,
			},
			from: {
				kind: "parsed",
				parse: String,
				brief: "First session start day, YYYY-MM-DD (UTC)",
				optional: true,
			},
			to: {
				kind: "parsed",
				parse: String,
				brief: "Last session start day, YYYY-MM-DD (UTC), inclusive",
				optional: true,
			},
			pattern: {
				kind: "parsed",
				parse: String,
				brief: "Only the evidence sessions of this pattern id",
				optional: true,
			},
			out: {
				kind: "parsed",
				parse: String,
				brief: "Output directory (default: ~/.cache/opaline/pulls/...)",
				optional: true,
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
			"Copy a slice of sessions to local files: every stored record of each session, plus its runs, calls, git events, edges, CI jobs and setup files",
		fullDescription: PULL_DESCRIPTION,
	},
});
