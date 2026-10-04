import { execFile } from "node:child_process";
import { arch, platform, release } from "node:os";
import type { CaptureRuntime } from "../internal/local-context-source/index.js";

/** Each version probe gets this long; a slower or missing tool is null. */
const TOOL_VERSION_TIMEOUT_MS = 1_500;
const MAX_VERSION_OUTPUT_BYTES = 4 * 1024;
const MAX_VERSION_LENGTH = 64;
/** Transcript lines read to find the agent's version. */
const MAX_AGENT_HOST_LINES = 200;

type ToolVersions = CaptureRuntime["tools"];

let toolVersions: Promise<ToolVersions> | undefined;

/**
 * Versions of the capturing machine's OS, the CLI's runtime and common tools,
 * plus the agent that wrote the transcript. Tool probes run in parallel with a
 * short timeout, once per process.
 */
export async function collectCaptureRuntime(
	transcript: string | undefined,
	source: "claude_code" | "codex",
): Promise<CaptureRuntime> {
	toolVersions ??= probeToolVersions();
	return {
		os: { platform: platform(), release: release(), arch: arch() },
		cli:
			typeof process.versions.bun === "string"
				? { runtime: "bun", version: process.versions.bun }
				: { runtime: "node", version: process.versions.node },
		tools: await toolVersions,
		agentHost: readAgentHost(transcript, source),
	};
}

/**
 * The agent version recorded in the transcript: Claude Code writes `version`
 * on its records, Codex writes `cli_version` and `originator` in session_meta.
 */
export function readAgentHost(
	transcript: string | undefined,
	source: "claude_code" | "codex",
): CaptureRuntime["agentHost"] {
	const name = source === "codex" ? "codex" : "claude-code";
	if (transcript === undefined)
		return { name, version: null, originator: null };
	let start = 0;
	for (let line = 0; line < MAX_AGENT_HOST_LINES; line += 1) {
		if (start >= transcript.length) break;
		const end = transcript.indexOf("\n", start);
		const text = transcript.slice(start, end < 0 ? undefined : end);
		start = end < 0 ? transcript.length : end + 1;
		const record = parseRecord(text);
		if (record === null) continue;
		if (source === "codex") {
			if (record.type !== "session_meta") continue;
			const payload = asRecord(record.payload);
			return {
				name,
				version: asVersion(payload?.cli_version),
				originator: asVersion(payload?.originator),
			};
		}
		const version = asVersion(record.version);
		if (version !== null)
			return { name, version, originator: asVersion(record.entrypoint) };
	}
	return { name, version: null, originator: null };
}

async function probeToolVersions(): Promise<ToolVersions> {
	const [node, bun, git, python3] = await Promise.all([
		probeVersion("node", ["--version"]),
		probeVersion("bun", ["--version"]),
		probeVersion("git", ["--version"]),
		probeVersion("python3", ["--version"]),
	]);
	return {
		node,
		bun,
		git,
		python: python3 ?? (await probeVersion("python", ["--version"])),
	};
}

function probeVersion(
	command: string,
	args: readonly string[],
): Promise<string | null> {
	return new Promise((resolve) => {
		execFile(
			command,
			[...args],
			{
				encoding: "utf8",
				maxBuffer: MAX_VERSION_OUTPUT_BYTES,
				timeout: TOOL_VERSION_TIMEOUT_MS,
				windowsHide: true,
			},
			(error, stdout, stderr) => {
				if (error) return resolve(null);
				// Python 2 prints its version on stderr.
				const match = /\d+(?:\.\d+)+(?:[-+.][0-9A-Za-z.-]+)?/u.exec(
					`${stdout}\n${stderr}`,
				);
				resolve(match ? match[0].slice(0, MAX_VERSION_LENGTH) : null);
			},
		);
	});
}

function parseRecord(text: string): Record<string, unknown> | null {
	if (!text.trim().startsWith("{")) return null;
	try {
		return asRecord(JSON.parse(text)) ?? null;
	} catch {
		return null;
	}
}

function asVersion(value: unknown): string | null {
	return typeof value === "string" &&
		value.length > 0 &&
		value.length <= MAX_VERSION_LENGTH &&
		/^[\w.+@/-]+$/u.test(value)
		? value
		: null;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? Object.fromEntries(Object.entries(value))
		: undefined;
}
