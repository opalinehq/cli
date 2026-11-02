import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { AgentEvent, AgentStreamParser } from "./agent-event.js";

export const ASK_BRIDGE_ENV = "OPALINE_ASK_BRIDGE";
export const ASK_JOB_DIRECTORY_PREFIX = "opaline-ask-";

export const ASK_INSTRUCTIONS = [
	"You are answering a question inside Opaline's web app.",
	"The question is about the coding-agent sessions of the user's Opaline workspace.",
	"Use the opaline MCP tools to find and analyse those sessions instead of answering from memory.",
	"You have no file, shell or web tools.",
	"Answer in Markdown.",
].join(" ");

const KILL_GRACE_MS = 5_000;
const STDERR_TAIL_LENGTH = 4_000;

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

export interface JobDirectory {
	readonly root: string;
	readonly workingDirectory: string;
}

export interface AgentProcessSpec {
	readonly command: string;
	readonly args: readonly string[];
	readonly env?: NodeJS.ProcessEnv;
	readonly prompt: string;
	readonly workingDirectory: string;
	readonly parser: AgentStreamParser;
	readonly describeFailure: (stderr: string) => string | undefined;
	readonly notInstalledError: string;
	readonly displayName: string;
}

export async function withJobDirectory<T>(
	use: (directory: JobDirectory) => Promise<T>,
): Promise<T> {
	const root = await mkdtemp(join(tmpdir(), ASK_JOB_DIRECTORY_PREFIX));
	try {
		const workingDirectory = join(root, "work");
		await mkdir(workingDirectory, { mode: 0o700 });
		return await use({ root, workingDirectory });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

export async function runAgentProcess(
	spec: AgentProcessSpec,
	options: RunAgentOptions,
): Promise<AgentOutcome> {
	const spawnAgent = options.spawnAgent ?? spawnWithPipes;
	const child = spawnAgent(spec.command, spec.args, {
		cwd: spec.workingDirectory,
		env: { ...process.env, ...spec.env, [ASK_BRIDGE_ENV]: "1" },
	});
	const stop = () => terminate(child);
	if (options.signal.aborted) stop();
	options.signal.addEventListener("abort", stop, { once: true });
	try {
		return await collectOutcome(child, spec, options);
	} finally {
		options.signal.removeEventListener("abort", stop);
	}
}

async function collectOutcome(
	child: AgentProcess,
	spec: AgentProcessSpec,
	options: RunAgentOptions,
): Promise<AgentOutcome> {
	let result: Extract<AgentEvent, { kind: "result" }> | undefined;
	const stdoutDone = forEachLine(child.stdout, (line) => {
		for (const event of spec.parser(line)) {
			if (event.kind === "result") result = event;
			options.onEvent(event);
		}
	});
	const stderrTail = collectTail(child.stderr);
	child.stdin?.on("error", () => {});
	child.stdin?.end(spec.prompt);

	const exit = await waitForExit(child);
	if (options.signal.aborted) return { status: "stopped" };
	if ("error" in exit)
		return { status: "failed", error: spawnFailure(exit.error, spec) };
	await stdoutDone;
	if (result)
		return result.ok
			? { status: "done" }
			: { status: "failed", error: result.error };
	return {
		status: "failed",
		error:
			spec.describeFailure(stderrTail()) ??
			`${spec.displayName} stopped unexpectedly (exit code ${exit.code ?? "none"})`,
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

function spawnFailure(error: Error, spec: AgentProcessSpec): string {
	return "code" in error && error.code === "ENOENT"
		? spec.notInstalledError
		: `Could not start ${spec.displayName}: ${error.message}`;
}

function terminate(child: AgentProcess): void {
	child.kill("SIGTERM");
	setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS).unref();
}

const spawnWithPipes: SpawnAgent = (command, args, options) =>
	spawn(command, [...args], {
		cwd: options.cwd,
		env: options.env,
		stdio: ["pipe", "pipe", "pipe"],
	});
