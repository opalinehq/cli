import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildCommand } from "@stricli/core";
import {
	COUNT_IN,
	COUNT_LEVELS,
	COUNT_STREAMS,
	COUNT_UNITS,
	type CountIn,
	type CountOptions,
	type CountUnit,
	checkOptions,
	countPull,
	defaultUnit,
} from "../lib/count.js";
import {
	cacheRoot,
	callerPath,
	errorMessage,
	lastPullPath,
} from "../lib/data-export.js";

interface CountFlags {
	readonly pattern: string;
	readonly in?: CountIn;
	readonly unit?: CountUnit;
	readonly level?: CountOptions["level"];
	readonly stream?: CountOptions["stream"];
	readonly from?: string;
	readonly to?: string;
	readonly ignoreCase: boolean;
	readonly pull?: string;
}

export const COUNT_DESCRIPTION = `Streams sessions/<id>.jsonl of a pull (default: the latest pull, named in
~/.cache/opaline/pulls/LAST) and prints one JSON object:
{count, sessions, definition, examples[3], scanned}.
Paste the definition next to the number it backs.

--in: output (tool results), command (tool call input), prompt (genuine
prompts: typed by a person, delegations left out), agent_message (assistant
text), any. Default: output.
--unit: call (distinct tool calls; the default for output and command),
prompt, message, or session.
--level: agent (default: calls the agent made, top-level or a Codex script),
inner (commands a Codex script ran) or all.
--stream: all (default: main and subagent streams) or main.
--from, --to: only sessions whose first record falls on these UTC days.`;

export function resolvePullDir(
	flag: string | undefined,
	cwd: string,
	root: string,
): string | Error {
	if (flag !== undefined) return callerPath(flag, cwd);
	const last = lastPullPath(root);
	if (!existsSync(last))
		return new Error(
			"No pull yet: run opaline pull first, or pass --pull <dir>",
		);
	const dir = readFileSync(last, "utf8").trim();
	if (dir === "")
		return new Error(
			`${last} is empty: run opaline pull, or pass --pull <dir>`,
		);
	return dir;
}

async function runCountCommand(flags: CountFlags): Promise<undefined | Error> {
	const where = flags.in ?? "output";
	const options: CountOptions = {
		pattern: flags.pattern,
		ignoreCase: flags.ignoreCase,
		in: where,
		unit: flags.unit ?? defaultUnit(where),
		level: flags.level ?? "agent",
		stream: flags.stream ?? "all",
		...(flags.from !== undefined ? { from: flags.from } : {}),
		...(flags.to !== undefined ? { to: flags.to } : {}),
	};
	const invalid = checkOptions(options);
	if (invalid) return new Error(invalid);
	const pull = resolvePullDir(flags.pull, process.cwd(), cacheRoot());
	if (pull instanceof Error) return pull;
	if (!existsSync(join(pull, "sessions")))
		return new Error(
			`${pull} has no sessions/ directory: run opaline pull first, or pass --pull <dir>`,
		);
	try {
		const result = await countPull(pull, options);
		process.stdout.write(
			`${JSON.stringify(
				{
					count: result.count,
					sessions: result.sessions,
					definition: result.definition,
					examples: result.examples,
					scanned: result.scanned,
				},
				null,
				1,
			)}\n`,
		);
	} catch (error) {
		return new Error(`opaline count failed: ${errorMessage(error)}`);
	}
}

export const countCommand = buildCommand({
	loader: async () => ({ default: runCountCommand }),
	parameters: {
		flags: {
			pattern: {
				kind: "parsed",
				parse: String,
				brief:
					"JavaScript regular expression matched against each record's text",
			},
			in: {
				kind: "enum",
				values: COUNT_IN,
				brief: "Which text to match (default: output)",
				optional: true,
			},
			unit: {
				kind: "enum",
				values: COUNT_UNITS,
				brief: "What to count (default: call for output and command)",
				optional: true,
			},
			level: {
				kind: "enum",
				values: COUNT_LEVELS,
				brief:
					"Calls the agent made (default), commands a Codex script ran, or both",
				optional: true,
			},
			stream: {
				kind: "enum",
				values: COUNT_STREAMS,
				brief: "Main and subagent streams (default), or the main stream only",
				optional: true,
			},
			from: {
				kind: "parsed",
				parse: String,
				brief: "Only sessions whose first record is on or after this UTC day",
				optional: true,
			},
			to: {
				kind: "parsed",
				parse: String,
				brief: "Only sessions whose first record is on or before this UTC day",
				optional: true,
			},
			ignoreCase: {
				kind: "boolean",
				brief: "Match regardless of case",
				default: false,
			},
			pull: {
				kind: "parsed",
				parse: String,
				brief: "The pull directory (default: the latest pull)",
				optional: true,
			},
		},
		aliases: { i: "ignoreCase" },
	},
	docs: {
		brief:
			"Count the calls, prompts or sessions whose text matches a regex in a pull, with a definition to quote next to the number",
		fullDescription: COUNT_DESCRIPTION,
	},
});
