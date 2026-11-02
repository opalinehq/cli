import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname } from "node:path";
import { PassThrough } from "node:stream";
import { getFunctionName } from "convex/server";
import {
	type AnswerDependencies,
	answerMessage,
	BRIDGE_STOPPED_ERROR,
	type ClaimedMessage,
} from "../lib/ask/answer-message.js";
import {
	type AskConvexClient,
	createAskBackend,
} from "../lib/ask/ask-convex.js";
import {
	type AgentProcess,
	CLAUDE_NOT_INSTALLED_ERROR,
	runClaude,
	type SpawnAgent,
} from "../lib/ask/claude-runner.js";
import { NOT_LOGGED_IN_ERROR } from "../lib/ask/claude-stream.js";
import { PendingQueue } from "../lib/ask/pending-queue.js";

const MESSAGE_ID = "message-1";
const MCP_TOKEN = "mcp-secret-token";
const CLAIMED: ClaimedMessage = {
	threadId: "thread-1",
	prompt: "--which sessions failed?",
	provider: "claude",
};

class FakeClaude extends EventEmitter implements AgentProcess {
	readonly stdin = new PassThrough();
	readonly stdout = new PassThrough();
	readonly stderr = new PassThrough();
	readonly killSignals: string[] = [];
	prompt = "";

	constructor() {
		super();
		this.stdin.on("data", (chunk) => {
			this.prompt += chunk.toString();
		});
	}

	print(...lines: unknown[]): void {
		for (const line of lines) this.stdout.write(`${JSON.stringify(line)}\n`);
	}

	exit(code: number | null): void {
		this.stdout.end();
		this.stderr.end();
		setImmediate(() => this.emit("close", code));
	}

	kill(signal?: NodeJS.Signals): boolean {
		this.killSignals.push(signal ?? "SIGTERM");
		this.exit(null);
		return true;
	}
}

interface SpawnCall {
	readonly args: readonly string[];
	readonly cwd: string;
	readonly env: NodeJS.ProcessEnv;
	readonly mcpConfig: string;
	readonly workingDirectoryEntries: string[];
}

function fakeSpawn(behave: (child: FakeClaude) => void) {
	const calls: SpawnCall[] = [];
	const children: FakeClaude[] = [];
	const spawnAgent: SpawnAgent = (_command, args, options) => {
		const configPath = args[args.indexOf("--mcp-config") + 1] ?? "";
		calls.push({
			args,
			...options,
			mcpConfig: readFileSync(configPath, "utf8"),
			workingDirectoryEntries: readdirSync(options.cwd),
		});
		const child = new FakeClaude();
		children.push(child);
		setImmediate(() => behave(child));
		return child;
	};
	return { spawnAgent, calls, children };
}

function fakeConvex(claimResult: ClaimedMessage | null) {
	const mutations: { name: string; args: Record<string, unknown> }[] = [];
	const listeners = new Map<string, (value: unknown) => void>();
	const client = {
		mutation: async (reference: never, args: Record<string, unknown>) => {
			const name = getFunctionName(reference);
			mutations.push({ name, args });
			return name === "ask:claim" ? claimResult : null;
		},
		onUpdate: (
			reference: never,
			_args: unknown,
			callback: (value: unknown) => void,
		) => {
			const name = getFunctionName(reference);
			listeners.set(name, callback);
			return () => listeners.delete(name);
		},
	} as unknown as AskConvexClient;
	return {
		backend: createAskBackend(client),
		calls: (name: string) =>
			mutations.filter((call) => call.name === name).map((call) => call.args),
		emit: (name: string, value: unknown) => listeners.get(name)?.(value),
		isWatching: (name: string) => listeners.has(name),
	};
}

function dependencies(
	convex: ReturnType<typeof fakeConvex>,
	spawnAgent: SpawnAgent,
	stopSignal: AbortSignal = new AbortController().signal,
): AnswerDependencies {
	return {
		backend: convex.backend,
		runAgent: (job, options) => runClaude(job, { ...options, spawnAgent }),
		mcpAccess: async () => ({
			mcpUrl: "https://opaline.test/mcp",
			mcpToken: MCP_TOKEN,
		}),
		stopSignal,
		flushIntervalMs: 5,
	};
}

function combinedProgress(convex: ReturnType<typeof fakeConvex>) {
	const progress = convex.calls("ask:progress");
	return {
		text: progress.map((call) => call.text ?? "").join(""),
		tools: progress.flatMap((call) => (call.tools as unknown[]) ?? []).at(-1),
		agentSessionId: progress.find((call) => call.agentSessionId)
			?.agentSessionId,
	};
}

async function until(condition: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 200 && !condition(); attempt++)
		await new Promise((resolve) => setTimeout(resolve, 5));
	expect(condition()).toBe(true);
}

test("a claimed question streams the answer to Convex and finishes as done, with the prompt on stdin and the MCP token file removed", async () => {
	const convex = fakeConvex(CLAIMED);
	const claude = fakeSpawn((child) => {
		child.print(
			{ type: "system", subtype: "init", session_id: "session-9" },
			{
				type: "assistant",
				message: {
					id: "m1",
					content: [
						{
							type: "tool_use",
							id: "t1",
							name: "mcp__opaline__find",
							input: {},
						},
					],
				},
			},
			{
				type: "user",
				message: { content: [{ type: "tool_result", tool_use_id: "t1" }] },
			},
			{
				type: "assistant",
				message: { id: "m2", content: [{ type: "text", text: "Two failed." }] },
			},
			{ type: "result", subtype: "success", is_error: false },
		);
		child.exit(0);
	});

	const result = await answerMessage(
		MESSAGE_ID,
		dependencies(convex, claude.spawnAgent),
	);

	expect(result).toEqual({ status: "done" });
	expect(convex.calls("ask:finish")).toEqual([
		{ messageId: MESSAGE_ID, status: "done" },
	]);
	expect(combinedProgress(convex)).toEqual({
		text: "Two failed.",
		tools: { id: "t1", name: "find", state: "done" },
		agentSessionId: "session-9",
	});
	const [call] = claude.calls;
	expect(claude.children[0]?.prompt).toBe(CLAIMED.prompt);
	expect(call?.args).not.toContain(CLAIMED.prompt);
	expect(call?.env.OPALINE_ASK_BRIDGE).toBe("1");
	expect(basename(dirname(call?.cwd ?? ""))).toStartWith("opaline-ask-");
	expect(dirname(dirname(call?.cwd ?? ""))).toBe(tmpdir());
	expect(call?.mcpConfig).toContain(`Bearer ${MCP_TOKEN}`);
	expect(call?.workingDirectoryEntries).toEqual([]);
	expect(existsSync(dirname(call?.cwd ?? ""))).toBe(false);
	expect(convex.isWatching("ask:job")).toBe(false);
});

test("a question another device already took starts no agent and writes nothing", async () => {
	const convex = fakeConvex(null);
	const claude = fakeSpawn(() => {});

	const result = await answerMessage(
		MESSAGE_ID,
		dependencies(convex, claude.spawnAgent),
	);

	expect(result).toEqual({ status: "not-claimed" });
	expect(claude.calls).toHaveLength(0);
	expect(convex.calls("ask:finish")).toHaveLength(0);
});

test("cancelling in the web app kills Claude Code and leaves the cancelled status alone", async () => {
	const convex = fakeConvex(CLAIMED);
	const claude = fakeSpawn((child) =>
		child.print({ type: "system", subtype: "init", session_id: "s" }),
	);

	const answering = answerMessage(
		MESSAGE_ID,
		dependencies(convex, claude.spawnAgent),
	);
	await until(() => claude.children.length === 1);
	convex.emit("ask:job", { status: "running" });
	expect(claude.children[0]?.killSignals).toEqual([]);
	convex.emit("ask:job", { status: "cancelled" });

	expect(await answering).toEqual({ status: "cancelled" });
	expect(claude.children[0]?.killSignals).toEqual(["SIGTERM"]);
	expect(convex.calls("ask:finish")).toHaveLength(0);
});

test("stopping the bridge mid-answer kills Claude Code and fails the message as stopped", async () => {
	const convex = fakeConvex(CLAIMED);
	const claude = fakeSpawn(() => {});
	const stop = new AbortController();

	const answering = answerMessage(
		MESSAGE_ID,
		dependencies(convex, claude.spawnAgent, stop.signal),
	);
	await until(() => claude.children.length === 1);
	stop.abort();

	expect(await answering).toEqual({ status: "stopped" });
	expect(claude.children[0]?.killSignals).toEqual(["SIGTERM"]);
	expect(convex.calls("ask:finish")).toEqual([
		{ messageId: MESSAGE_ID, status: "failed", error: BRIDGE_STOPPED_ERROR },
	]);
});

test("a missing claude binary and a logged-out claude fail with errors a member can act on", async () => {
	const missing = fakeConvex(CLAIMED);
	const notInstalled = fakeSpawn((child) =>
		child.emit(
			"error",
			Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" }),
		),
	);
	await answerMessage(
		MESSAGE_ID,
		dependencies(missing, notInstalled.spawnAgent),
	);
	expect(missing.calls("ask:finish")).toEqual([
		{
			messageId: MESSAGE_ID,
			status: "failed",
			error: CLAUDE_NOT_INSTALLED_ERROR,
		},
	]);

	const loggedOut = fakeConvex(CLAIMED);
	const exitsWithoutResult = fakeSpawn((child) => {
		child.stderr.write("Error: Not logged in · Please run /login\n");
		child.exit(1);
	});
	await answerMessage(
		MESSAGE_ID,
		dependencies(loggedOut, exitsWithoutResult.spawnAgent),
	);
	expect(loggedOut.calls("ask:finish")).toEqual([
		{ messageId: MESSAGE_ID, status: "failed", error: NOT_LOGGED_IN_ERROR },
	]);
});

test("the pending queue answers one question at a time and does not retry one it could not claim", async () => {
	const started: string[] = [];
	const release = new Map<string, () => void>();
	const queue = new PendingQueue(
		(messageId) =>
			new Promise<void>((resolve) => {
				started.push(messageId);
				release.set(messageId, resolve);
			}),
		new AbortController().signal,
		() => {},
	);
	const pending = (ids: string[]) =>
		ids.map((messageId) => ({
			messageId,
			threadId: "t",
			provider: "claude",
			createdAt: 0,
		}));

	queue.update(pending(["a", "b"]));
	queue.update(pending(["a", "b"]));
	expect(started).toEqual(["a"]);

	release.get("a")?.();
	await until(() => started.length === 2);
	expect(started).toEqual(["a", "b"]);

	release.get("b")?.();
	await queue.settled();
	queue.update(pending(["a", "b"]));
	expect(started).toEqual(["a", "b"]);
});
