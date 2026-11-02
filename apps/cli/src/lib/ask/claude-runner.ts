import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import {
	type AgentEvent,
	createClaudeStreamParser,
	describeClaudeFailure,
} from "./claude-stream.js";

export const ASK_BRIDGE_ENV = "OPALINE_ASK_BRIDGE";
export const ASK_JOB_DIRECTORY_PREFIX = "opaline-ask-";
export const CLAUDE_NOT_INSTALLED_ERROR = "Claude Code is not installed";

const KILL_GRACE_MS = 5_000;
const STDERR_TAIL_LENGTH = 4_000;

const SYSTEM_PROMPT = [
	"You are answering a question inside Opaline's web app.",
	"The question is about the coding-agent sessions of the user's Opaline workspace.",
	"Use the opaline MCP tools to find and analyse those sessions instead of answering from memory.",
	"You have no file, shell or web tools.",
	"Answer in Markdown.",
].join(" ");

export interface AgentJob {
	readonly prompt: string;
	readonly resumeSessionId?: string;
	readonly mcpUrl: string;
	readonly mcpToken: string;
}

export type AgentOutcome =
	| { readonly status: "done" }
	| { readonly status: "failed"; readonly error: string }
	| { readonly status: "stopped" };

export interface AgentProcess {
	readonly stdin: Writable | null;
	readonly stdout: Readable | null;
	readonly stderr: Readable | null;
	kill(signal?: NodeJS.Signals): boolean;
	once(event: "close", listener: (code: number | null) => void): unknown;
	once(event: "error", listener: (error: Error) => void): unknown;
}

export type SpawnAgent = (
	command: string,
	args: readonly string[],
	options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv },
) => AgentProcess;

export interface RunAgentOptions {
	readonly onEvent: (event: AgentEvent) => void;
	readonly signal: AbortSignal;
	readonly spawnAgent?: SpawnAgent;
}

export type RunAgent = (
	job: AgentJob,
	options: RunAgentOptions,
) => Promise<AgentOutcome>;

interface JobDirectory {
	readonly root: string;
	readonly workingDirectory: string;
	readonly mcpConfigPath: string;
}

export const runClaude: RunAgent = async (job, options) => {
	const directory = await createJobDirectory(job);
	try {
		return await runInDirectory(job, directory, options);
	} finally {
		await rm(directory.root, { recursive: true, force: true });
	}
};

export function claudeArguments(
	job: AgentJob,
	mcpConfigPath: string,
): string[] {
	return [
		"-p",
		"--output-format",
		"stream-json",
		"--verbose",
		"--mcp-config",
		mcpConfigPath,
		"--strict-mcp-config",
		"--allowedTools",
		"mcp__opaline",
		"--tools",
		"",
		"--permission-mode",
		"dontAsk",
		"--permission-prompts",
		"none",
		"--disable-slash-commands",
		"--settings",
		JSON.stringify({ disableAllHooks: true }),
		"--append-system-prompt",
		SYSTEM_PROMPT,
		...(job.resumeSessionId ? ["--resume", job.resumeSessionId] : []),
	];
}

async function createJobDirectory(job: AgentJob): Promise<JobDirectory> {
	const root = await mkdtemp(join(tmpdir(), ASK_JOB_DIRECTORY_PREFIX));
	const workingDirectory = join(root, "work");
	const mcpConfigPath = join(root, "mcp.json");
	await mkdir(workingDirectory, { mode: 0o700 });
	await writeFile(mcpConfigPath, mcpConfig(job), { mode: 0o600 });
	return { root, workingDirectory, mcpConfigPath };
}

function mcpConfig(job: AgentJob): string {
	return JSON.stringify({
		mcpServers: {
			opaline: {
				type: "http",
				url: job.mcpUrl,
				headers: { Authorization: `Bearer ${job.mcpToken}` },
			},
		},
	});
}

async function runInDirectory(
	job: AgentJob,
	directory: JobDirectory,
	options: RunAgentOptions,
): Promise<AgentOutcome> {
	const spawnAgent = options.spawnAgent ?? spawnClaude;
	const child = spawnAgent(
		"claude",
		claudeArguments(job, directory.mcpConfigPath),
		{
			cwd: directory.workingDirectory,
			env: { ...process.env, [ASK_BRIDGE_ENV]: "1" },
		},
	);
	const stop = () => terminate(child);
	if (options.signal.aborted) stop();
	options.signal.addEventListener("abort", stop, { once: true });
	try {
		return await collectOutcome(child, job.prompt, options);
	} finally {
		options.signal.removeEventListener("abort", stop);
	}
}

async function collectOutcome(
	child: AgentProcess,
	prompt: string,
	options: RunAgentOptions,
): Promise<AgentOutcome> {
	const parse = createClaudeStreamParser();
	let result: Extract<AgentEvent, { kind: "result" }> | undefined;
	const stdoutDone = forEachLine(child.stdout, (line) => {
		for (const event of parse(line)) {
			if (event.kind === "result") result = event;
			options.onEvent(event);
		}
	});
	const stderrTail = collectTail(child.stderr);
	child.stdin?.on("error", () => {});
	child.stdin?.end(prompt);

	const exit = await waitForExit(child);
	if (options.signal.aborted) return { status: "stopped" };
	if ("error" in exit)
		return { status: "failed", error: spawnFailure(exit.error) };
	await stdoutDone;
	if (result)
		return result.ok
			? { status: "done" }
			: { status: "failed", error: result.error };
	return {
		status: "failed",
		error:
			describeClaudeFailure(stderrTail()) ??
			`Claude Code stopped unexpectedly (exit code ${exit.code ?? "none"})`,
	};
}

function waitForExit(
	child: AgentProcess,
): Promise<{ readonly code: number | null } | { readonly error: Error }> {
	return new Promise((resolve) => {
		child.once("error", (error) => resolve({ error }));
		child.once("close", (code) => resolve({ code }));
	});
}

function forEachLine(
	stream: Readable | null,
	onLine: (line: string) => void,
): Promise<void> {
	if (!stream) return Promise.resolve();
	const lines = createInterface({ input: stream, crlfDelay: Infinity });
	lines.on("line", onLine);
	return new Promise((resolve) => lines.once("close", resolve));
}

function collectTail(stream: Readable | null): () => string {
	let tail = "";
	stream?.on("data", (chunk: Buffer | string) => {
		tail = (tail + chunk.toString()).slice(-STDERR_TAIL_LENGTH);
	});
	return () => tail;
}

function spawnFailure(error: Error): string {
	return "code" in error && error.code === "ENOENT"
		? CLAUDE_NOT_INSTALLED_ERROR
		: `Could not start Claude Code: ${error.message}`;
}

function terminate(child: AgentProcess): void {
	child.kill("SIGTERM");
	setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS).unref();
}

const spawnClaude: SpawnAgent = (command, args, options) =>
	spawn(command, [...args], {
		cwd: options.cwd,
		env: options.env,
		stdio: ["pipe", "pipe", "pipe"],
	});
