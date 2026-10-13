import { afterEach, expect, test } from "bun:test";
import {
	appendFile,
	chmod,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	symlink,
	unlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tryAcquireFileLease } from "../lib/file-lease.js";
import {
	type LiveSessionFollowerTiming,
	runLiveSessionFollower,
} from "../lib/live-session-follower.js";
import {
	getLiveSessionFollowerLeasePath,
	writeFollowerMarker,
} from "../lib/live-session-launch.js";
import {
	hashLiveSessionLine,
	processLiveSessionLine,
} from "../lib/live-session-lines.js";
import { isLiveSessionPaused } from "../lib/live-session-pause.js";
import {
	type LiveSessionRegistration,
	listLiveSessionRegistrations,
	writeLiveSessionRegistration,
} from "../lib/live-session-registry.js";
import { readProcessStartIdentities } from "../lib/process-identity.js";
import { createTranscriptSlimmer } from "../lib/transcript-slim.js";
import {
	type LiveSessionStub,
	orpcError,
	startLiveSessionStub,
} from "./helpers/live-session-stub.js";

const FAST_TIMING: Partial<LiveSessionFollowerTiming> = {
	backoffInitialMs: 50,
	backoffMaxMs: 200,
	debounceMs: 100,
	finalFlushMs: 5_000,
	finalReadDelayMs: 50,
	identityCheckMs: 100,
	idleExitMs: 300,
	leaseWaitMs: 300,
	authBackoffInitialMs: 300,
	capabilityCheckMs: 200,
	rateLimitBackoffMs: 600,
	requestTimeoutMs: 3_000,
	resetBackoffInitialMs: 100,
	settingsCheckMs: 200,
	tickMs: 50,
};
const SECRET = `ghp_${"a".repeat(36)}`;

interface Fixture {
	readonly home: string;
	readonly configDir: string;
	readonly projectPath: string;
	readonly transcriptDirectory: string;
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function startStub(options: Parameters<typeof startLiveSessionStub>[0] = {}) {
	const stub = startLiveSessionStub(options);
	cleanups.push(() => stub.stop());
	return stub;
}

async function createFixture(stub: LiveSessionStub): Promise<Fixture> {
	const home = await mkdtemp(join(tmpdir(), "opaline-live-"));
	const configDir = join(home, ".rudel");
	const projectPath = join(home, "project");
	const transcriptDirectory = join(home, ".claude", "projects", "-project");
	await mkdir(configDir, { recursive: true });
	await mkdir(projectPath, { recursive: true });
	await mkdir(transcriptDirectory, { recursive: true });
	await writeFile(
		join(configDir, "credentials.json"),
		JSON.stringify({
			apiBaseUrl: stub.base,
			authType: "api-key",
			token: "live-test-token",
			user: { email: "user@example.invalid", id: "user-1", name: "User" },
		}),
	);
	cleanups.push(async () => {
		await chmod(home, 0o700).catch(() => undefined);
		await rm(home, { force: true, recursive: true });
	});
	return { configDir, home, projectPath, transcriptDirectory };
}

function startAgent(): ReturnType<typeof Bun.spawn> {
	const agent = Bun.spawn(["sleep", "120"], {
		stdio: ["ignore", "ignore", "ignore"],
	});
	cleanups.push(async () => {
		agent.kill();
		await agent.exited;
	});
	return agent;
}

function transcriptPath(fixture: Fixture, sessionId: string): string {
	return join(fixture.transcriptDirectory, `${sessionId}.jsonl`);
}

async function subagentDirectory(fixture: Fixture, sessionId: string) {
	const directory = join(fixture.transcriptDirectory, sessionId, "subagents");
	await mkdir(directory, { recursive: true });
	return directory;
}

async function register(
	fixture: Fixture,
	sessionId: string,
	agentPid: number | null,
	overrides: Partial<LiveSessionRegistration> = {},
): Promise<void> {
	await writeLiveSessionRegistration(fixture.configDir, {
		agentPid,
		agentPidSource: agentPid === null ? "none" : "env",
		agentStartIdentity: null,
		cwd: fixture.projectPath,
		organizationId: "org-1",
		sessionId,
		source: "claude_code",
		startedAt: Date.now(),
		transcriptPath: transcriptPath(fixture, sessionId),
		version: 1,
		...overrides,
	});
}

function follow(
	fixture: Fixture,
	timing: Partial<LiveSessionFollowerTiming> = {},
) {
	return runLiveSessionFollower({
		configDir: fixture.configDir,
		timing: { ...FAST_TIMING, ...timing },
		transcriptRoots: {
			claude_code: [join(fixture.home, ".claude", "projects")],
			codex: [join(fixture.home, ".codex", "sessions")],
		},
	});
}

/** A Codex rollout path in today's sessions directory. */
async function codexPath(fixture: Fixture, threadId: string): Promise<string> {
	const now = new Date();
	const directory = join(
		fixture.home,
		".codex",
		"sessions",
		String(now.getFullYear()),
		String(now.getMonth() + 1).padStart(2, "0"),
		String(now.getDate()).padStart(2, "0"),
	);
	await mkdir(directory, { recursive: true });
	return join(directory, `rollout-2026-10-13T10-00-00-${threadId}.jsonl`);
}

function record(index: number, text = `message ${index}`): string {
	return JSON.stringify({
		message: { content: text },
		type: "user",
		uuid: `u${index}`,
	});
}

function jsonl(...lines: string[]): string {
	return lines.map((line) => `${line}\n`).join("");
}

function processed(line: string): string {
	return processLiveSessionLine(
		{ bytes: Buffer.from(line), kind: "line" },
		createTranscriptSlimmer(),
	).text;
}

async function waitFor(
	condition: () => boolean | Promise<boolean>,
	timeoutMs = 10_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await condition())) {
		if (Date.now() > deadline) throw new Error("Timed out waiting");
		await Bun.sleep(20);
	}
}

async function liveSessionFiles(fixture: Fixture): Promise<string[]> {
	return (
		await readdir(join(fixture.configDir, "live-sessions"), {
			recursive: true,
		}).catch(() => [])
	).filter((name) => name.endsWith(".json") || name.endsWith(".lease"));
}

// Streaming ------------------------------------------------------------------

test("streams the main and subagent transcripts, filters secrets, and ends with the agent", async () => {
	const stub = startStub();
	const fixture = await createFixture(stub);
	const agent = startAgent();
	const id = "session-a";
	const secretLine = record(1, `export TOKEN=${SECRET}`);
	await writeFile(transcriptPath(fixture, id), jsonl(record(0), secretLine));
	const subagents = await subagentDirectory(fixture, id);
	await writeFile(join(subagents, "agent-a1.jsonl"), jsonl(record(100)));
	await writeFile(join(subagents, "agent-a1.meta.json"), "{}");
	await register(fixture, id, agent.pid);
	const running = follow(fixture);

	await waitFor(
		() => stub.lines(id).length === 2 && stub.lines(id, "a1").length === 1,
	);
	expect(stub.lines(id)[0]).toBe(record(0));
	expect(stub.lines(id)[1]).not.toContain(SECRET);
	expect(stub.lines(id)[1]).toBe(processed(secretLine));
	expect(stub.session(id).streams.has("a1.meta")).toBe(false);
	expect(stub.appends[0]).toMatchObject({
		organizationId: "org-1",
		projectPath: fixture.projectPath,
		sessionId: id,
		source: "claude_code",
	});

	// New complete lines arrive; an unterminated line waits for its newline.
	await appendFile(
		transcriptPath(fixture, id),
		`${record(2)}\n${record(3).slice(0, 10)}`,
	);
	await writeFile(join(subagents, "agent-b2.jsonl"), jsonl(record(200)));
	await waitFor(
		() => stub.lines(id).length === 3 && stub.lines(id, "b2").length === 1,
	);
	await Bun.sleep(300);
	expect(stub.lines(id)).toHaveLength(3);
	await appendFile(transcriptPath(fixture, id), `${record(3).slice(10)}\n`);
	await waitFor(() => stub.lines(id).length === 4);

	// After the agent exits, a final unterminated line is sent only when it
	// is complete JSON; then the session ends and the follower idles out.
	await appendFile(transcriptPath(fixture, id), record(4));
	await appendFile(join(subagents, "agent-a1.jsonl"), '{"partial":');
	agent.kill();
	const result = await running;
	expect(result.reason).toBe("idle");
	expect(stub.lines(id)).toEqual([
		record(0),
		processed(secretLine),
		record(2),
		record(3),
		record(4),
	]);
	expect(stub.lines(id, "a1")).toEqual([record(100)]);
	expect(stub.session(id).ended).toBe(true);
	expect(stub.appends.at(-1)?.ended).toBe(true);
	expect(stub.appends.slice(0, -1).some((append) => append.ended)).toBe(false);
	expect(stub.statusCounts["out-of-sync"]).toBeUndefined();
	expect(await liveSessionFiles(fixture)).toEqual([]);
}, 30_000);

test("follows several sessions at once and ends each with its own agent", async () => {
	const stub = startStub();
	const fixture = await createFixture(stub);
	const first = startAgent();
	const second = startAgent();
	await writeFile(transcriptPath(fixture, "one"), jsonl(record(0)));
	await writeFile(transcriptPath(fixture, "two"), jsonl(record(10)));
	await register(fixture, "one", first.pid);
	await register(fixture, "two", second.pid);
	const running = follow(fixture);
	await waitFor(
		() => stub.lines("one").length === 1 && stub.lines("two").length === 1,
	);
	first.kill();
	await waitFor(() => stub.session("one").ended);
	expect(stub.session("two").ended).toBe(false);
	await appendFile(transcriptPath(fixture, "two"), jsonl(record(11)));
	await waitFor(() => stub.lines("two").length === 2);
	expect(
		(await listLiveSessionRegistrations(fixture.configDir)).map(
			(registration) => registration.sessionId,
		),
	).toEqual(["two"]);
	second.kill();
	expect((await running).reason).toBe("idle");
	expect(stub.session("two").ended).toBe(true);
	expect(
		stub.paths.filter((path) => path === "/rpc/cli/authStatus").length,
	).toBeGreaterThanOrEqual(1);
}, 30_000);

test("a later session of the same Claude Code process ends the previous one", async () => {
	const stub = startStub();
	const fixture = await createFixture(stub);
	const agent = startAgent();
	await writeFile(transcriptPath(fixture, "before-clear"), jsonl(record(0)));
	const startedAt = Date.now();
	await register(fixture, "before-clear", agent.pid, { startedAt });
	const running = follow(fixture);
	await waitFor(() => stub.lines("before-clear").length === 1);
	await writeFile(transcriptPath(fixture, "after-clear"), jsonl(record(1)));
	await register(fixture, "after-clear", agent.pid, {
		hookSource: "clear",
		startedAt: startedAt + 1,
	});
	await waitFor(
		() =>
			stub.session("before-clear").ended &&
			stub.lines("after-clear").length === 1,
	);
	expect(stub.session("after-clear").ended).toBe(false);
	agent.kill();
	expect((await running).reason).toBe("idle");
	expect(stub.session("after-clear").ended).toBe(true);
}, 30_000);

test("resumes after the server's committed lines when the local file still matches", async () => {
	const stub = startStub();
	const fixture = await createFixture(stub);
	const agent = startAgent();
	await writeFile(
		transcriptPath(fixture, "resumed"),
		jsonl(record(0), record(1), record(2)),
	);
	const state = stub.session("resumed");
	state.streams.set("", { generation: 1, lines: [record(0), record(1)] });
	state.ended = true;
	await register(fixture, "resumed", agent.pid, { hookSource: "resume" });
	const running = follow(fixture);
	await waitFor(() => stub.lines("resumed").length === 3);
	expect(stub.appends[0]?.streams).toEqual([
		{
			agentId: null,
			lines: [record(2)],
			previousLineSha256: hashLiveSessionLine(record(1)),
			startLine: 2,
		},
	]);
	expect(state.ended).toBe(false);
	expect(state.streams.get("")?.generation).toBe(1);
	agent.kill();
	await running;
}, 30_000);

test("starts a stream over when the server's last line differs or the file is rewritten", async () => {
	const stub = startStub();
	const fixture = await createFixture(stub);
	const agent = startAgent();
	const path = transcriptPath(fixture, "rewritten");
	await writeFile(path, jsonl(record(0), record(1)));
	stub
		.session("rewritten")
		.streams.set("", { generation: 1, lines: [record(0), '{"other":1}'] });
	await register(fixture, "rewritten", agent.pid);
	const running = follow(fixture);
	await waitFor(
		() => stub.appends.length > 0 && stub.lines("rewritten")[1] === record(1),
	);
	expect(stub.appends[0]?.streams[0]).toMatchObject({
		agentId: null,
		previousLineSha256: null,
		reset: true,
		startLine: 0,
	});
	expect(stub.lines("rewritten")).toEqual([record(0), record(1)]);

	await writeFile(path, jsonl(record(9)));
	await waitFor(() => stub.lines("rewritten").length === 1);
	expect(stub.lines("rewritten")).toEqual([record(9)]);
	expect(stub.appends.at(-1)?.streams[0]?.reset).toBe(true);
	agent.kill();
	await running;
}, 30_000);

test("recovers when the server falls out of sync mid-session", async () => {
	const stub = startStub();
	const fixture = await createFixture(stub);
	const agent = startAgent();
	const path = transcriptPath(fixture, "drift");
	await writeFile(path, jsonl(record(0), record(1), record(2)));
	await register(fixture, "drift", agent.pid);
	const running = follow(fixture);
	await waitFor(() => stub.lines("drift").length === 3);
	// The server lost its last committed line.
	stub.session("drift").streams.get("")?.lines.pop();
	await appendFile(path, jsonl(record(3)));
	await waitFor(() => stub.lines("drift").length === 4);
	expect(stub.lines("drift")).toEqual([
		record(0),
		record(1),
		record(2),
		record(3),
	]);
	expect(stub.statusCounts["out-of-sync"]).toBe(1);
	agent.kill();
	await running;
}, 30_000);

test("a retried append whose response was lost is not duplicated", async () => {
	let failed = false;
	const stub = startStub({
		intercept: ({ pathname }) => {
			if (pathname !== "/rpc/liveSession/append" || failed) return undefined;
			failed = true;
			return "commit-then-fail";
		},
	});
	const fixture = await createFixture(stub);
	const agent = startAgent();
	await writeFile(transcriptPath(fixture, "lost"), jsonl(record(0), record(1)));
	await register(fixture, "lost", agent.pid);
	const running = follow(fixture);
	await waitFor(() => stub.appends.length >= 2);
	await appendFile(transcriptPath(fixture, "lost"), jsonl(record(2)));
	await waitFor(() => stub.lines("lost").length === 3);
	agent.kill();
	await running;
	expect(stub.lines("lost")).toEqual([record(0), record(1), record(2)]);
	expect(stub.statusCounts["already-committed"]).toBeGreaterThanOrEqual(1);
}, 30_000);

test("splits backlogs into requests within the byte, line and stream limits", async () => {
	const stub = startStub();
	const fixture = await createFixture(stub);
	const agent = startAgent();
	const id = "large";
	const big = (index: number) => record(index, "x".repeat(400 * 1024));
	await writeFile(
		transcriptPath(fixture, id),
		jsonl(...Array.from({ length: 8 }, (_, index) => big(index))),
	);
	const subagents = await subagentDirectory(fixture, id);
	for (const name of ["many", "many2", "many3"])
		await writeFile(
			join(subagents, `agent-${name}.jsonl`),
			jsonl(...Array.from({ length: 10_050 }, (_, index) => `{"i":${index}}`)),
		);
	await Promise.all(
		Array.from({ length: 70 }, (_, index) =>
			writeFile(
				join(subagents, `agent-s${String(index).padStart(2, "0")}.jsonl`),
				jsonl(`{"s":${index}}`),
			),
		),
	);
	await register(fixture, id, agent.pid);
	const running = follow(fixture);
	await waitFor(
		() =>
			stub.lines(id).length === 8 &&
			stub.lines(id, "many").length === 10_050 &&
			stub.lines(id, "many2").length === 10_050 &&
			stub.lines(id, "many3").length === 10_050 &&
			stub.session(id).streams.size === 74 &&
			[...stub.session(id).streams.values()].every(
				(stream) => stream.lines.length > 0,
			),
		20_000,
	);
	for (const append of stub.appends) {
		const bytes = append.streams
			.flatMap((stream) => stream.lines)
			.reduce((total, line) => total + Buffer.byteLength(line), 0);
		expect(bytes).toBeLessThanOrEqual(1_572_864);
		expect(append.streams.length).toBeLessThanOrEqual(64);
		expect(
			append.streams.reduce((total, stream) => total + stream.lines.length, 0),
		).toBeLessThanOrEqual(20_000);
		for (const stream of append.streams)
			expect(stream.lines.length).toBeLessThanOrEqual(10_000);
	}
	expect(stub.statusCounts["out-of-sync"]).toBeUndefined();
	agent.kill();
	await running;
}, 40_000);

test("replaces lines that are too large to send with an omission marker", async () => {
	const stub = startStub();
	const fixture = await createFixture(stub);
	const agent = startAgent();
	const huge = record(1, "y".repeat(1_100_000));
	await writeFile(
		transcriptPath(fixture, "huge"),
		jsonl(record(0), huge, record(2)),
	);
	await register(fixture, "huge", agent.pid);
	const running = follow(fixture);
	await waitFor(() => stub.lines("huge").length === 3);
	expect(JSON.parse(stub.lines("huge")[1] as string)).toEqual({
		originalBytes: Buffer.byteLength(huge),
		reason: "too-large",
		type: "opaline-live-omitted",
	});
	agent.kill();
	await running;
}, 30_000);

// File and process conditions -------------------------------------------------

test.skipIf(process.platform === "win32")(
	"an unreadable transcript is skipped until it can be read",
	async () => {
		const stub = startStub();
		const fixture = await createFixture(stub);
		const agent = startAgent();
		const id = "unreadable";
		await writeFile(transcriptPath(fixture, id), jsonl(record(0)));
		const subagents = await subagentDirectory(fixture, id);
		const locked = join(subagents, "agent-locked.jsonl");
		await writeFile(locked, jsonl(record(1)));
		await chmod(locked, 0o000);
		await register(fixture, id, agent.pid);
		const running = follow(fixture);
		await waitFor(() => stub.lines(id).length === 1);
		await appendFile(transcriptPath(fixture, id), jsonl(record(2)));
		await waitFor(() => stub.lines(id).length === 2);
		if (process.getuid?.() !== 0) expect(stub.lines(id, "locked")).toEqual([]);
		await chmod(locked, 0o600);
		await waitFor(() => stub.lines(id, "locked").length === 1);
		// A subagent file removed while followed does not end the session.
		await rm(locked);
		await appendFile(transcriptPath(fixture, id), jsonl(record(3)));
		await waitFor(() => stub.lines(id).length === 3);
		agent.kill();
		expect((await running).reason).toBe("idle");
	},
	30_000,
);

test.skipIf(process.platform !== "linux" && process.platform !== "darwin")(
	"a reused process id does not keep a session alive",
	async () => {
		const stub = startStub();
		const fixture = await createFixture(stub);
		const agent = startAgent();
		const identity = (await readProcessStartIdentities([agent.pid])).get(
			agent.pid,
		);
		expect(identity).toBeDefined();
		await writeFile(transcriptPath(fixture, "real"), jsonl(record(0)));
		const reusedPath = await codexPath(fixture, "reused");
		await writeFile(reusedPath, jsonl(record(1)));
		await register(fixture, "real", agent.pid, {
			agentStartIdentity: identity ?? null,
		});
		// Registered by an earlier process that had the same id.
		await register(fixture, "reused", agent.pid, {
			agentStartIdentity: `${process.platform}:another start`,
			source: "codex",
			transcriptPath: reusedPath,
		});
		const running = follow(fixture);
		await waitFor(() => stub.session("reused", "codex").ended);
		await Bun.sleep(300);
		expect(stub.session("real").ended).toBe(false);
		expect(stub.lines("real")).toEqual([record(0)]);
		agent.kill();
		await running;
	},
	30_000,
);

test("without the agent process, follows until the transcript is idle", async () => {
	const stub = startStub();
	const fixture = await createFixture(stub);
	// The hook's parent was a short-lived wrapper.
	const wrapper = Bun.spawn(["sleep", "0"]);
	await wrapper.exited;
	const path = transcriptPath(fixture, "orphan");
	await writeFile(path, jsonl(record(0)));
	await register(fixture, "orphan", wrapper.pid, { agentPidSource: "parent" });
	const running = follow(fixture, { orphanIdleMs: 1_500 });
	await waitFor(() => stub.lines("orphan").length === 1);
	for (let index = 1; index <= 3; index += 1) {
		await Bun.sleep(400);
		await appendFile(path, jsonl(record(index)));
	}
	await waitFor(() => stub.lines("orphan").length === 4);
	expect(stub.session("orphan").ended).toBe(false);
	expect((await running).reason).toBe("idle");
	expect(stub.session("orphan").ended).toBe(true);
}, 30_000);

test("waits for the transcript to appear, and gives up when it never does", async () => {
	const stub = startStub();
	const fixture = await createFixture(stub);
	const agent = startAgent();
	await register(fixture, "late", agent.pid);
	await register(fixture, "never", agent.pid, { source: "codex" });
	const running = follow(fixture, { transcriptWaitMs: 1_000 });
	await Bun.sleep(300);
	await writeFile(transcriptPath(fixture, "late"), jsonl(record(0)));
	await waitFor(() => stub.lines("late").length === 1);
	await waitFor(
		async () =>
			!(await listLiveSessionRegistrations(fixture.configDir)).some(
				(registration) => registration.sessionId === "never",
			),
	);
	expect(stub.appends.some((append) => append.sessionId === "never")).toBe(
		false,
	);
	agent.kill();
	await running;
}, 30_000);

test("a registration left behind by a dead agent is flushed and ended", async () => {
	const stub = startStub();
	const fixture = await createFixture(stub);
	const gone = Bun.spawn(["sleep", "0"]);
	await gone.exited;
	await writeFile(
		transcriptPath(fixture, "stale"),
		jsonl(record(0), record(1)),
	);
	// The server has part of it and was never told it ended.
	stub.session("stale").streams.set("", { generation: 1, lines: [record(0)] });
	await register(fixture, "stale", gone.pid, {
		startedAt: Date.now() - 60 * 60_000,
	});
	// And one from more than a week ago is only forgotten.
	await writeFile(transcriptPath(fixture, "ancient"), jsonl(record(2)));
	await register(fixture, "ancient", gone.pid, {
		source: "codex",
		startedAt: Date.now() - 8 * 24 * 60 * 60_000,
	});
	expect((await follow(fixture)).reason).toBe("idle");
	expect(stub.lines("stale")).toEqual([record(0), record(1)]);
	expect(stub.session("stale").ended).toBe(true);
	expect(stub.appends.some((append) => append.sessionId === "ancient")).toBe(
		false,
	);
	expect(await listLiveSessionRegistrations(fixture.configDir)).toEqual([]);
});

// Server answers ----------------------------------------------------------------

test("does nothing when the server does not advertise live sessions", async () => {
	const stub = startStub({ liveSessions: false });
	const fixture = await createFixture(stub);
	const agent = startAgent();
	await writeFile(transcriptPath(fixture, "unsupported"), jsonl(record(0)));
	await register(fixture, "unsupported", agent.pid);
	expect((await follow(fixture)).reason).toBe("unsupported");
	expect(stub.paths).toEqual(["/rpc/cli/authStatus"]);
	expect(await listLiveSessionRegistrations(fixture.configDir)).toEqual([]);
});

test("a workspace pause drops that workspace's sessions and is honoured next time", async () => {
	const stub = startStub({
		intercept: ({ pathname, body }) =>
			pathname === "/rpc/liveSession/append" &&
			(body as { organizationId: string }).organizationId === "org-1"
				? orpcError(403, "LIVE_SESSIONS_DISABLED", {
						pauseSeconds: 600,
						scope: "workspace",
					})
				: undefined,
	});
	const fixture = await createFixture(stub);
	const agent = startAgent();
	await writeFile(transcriptPath(fixture, "paused"), jsonl(record(0)));
	await writeFile(transcriptPath(fixture, "other-org"), jsonl(record(1)));
	await register(fixture, "paused", agent.pid);
	const other = startAgent();
	await register(fixture, "other-org", other.pid, {
		organizationId: "org-2",
	});
	const running = follow(fixture);
	await waitFor(() => stub.lines("other-org").length === 1);
	await waitFor(() => isLiveSessionPaused(fixture.configDir, "org-1"));
	expect(isLiveSessionPaused(fixture.configDir, "org-2")).toBe(false);
	await waitFor(
		async () =>
			(await listLiveSessionRegistrations(fixture.configDir)).length === 1,
	);
	// A new registration of the paused workspace is not followed.
	await register(fixture, "paused-again", agent.pid);
	await Bun.sleep(300);
	expect(
		stub.appends.filter((append) => append.sessionId === "paused-again"),
	).toEqual([]);
	agent.kill();
	other.kill();
	await running;
}, 30_000);

test("a global pause ends the follower and is honoured by the next one", async () => {
	const stub = startStub({
		intercept: ({ pathname }) =>
			pathname === "/rpc/liveSession/append"
				? orpcError(403, "LIVE_SESSIONS_DISABLED", {
						pauseSeconds: 600,
						scope: "global",
					})
				: undefined,
	});
	const fixture = await createFixture(stub);
	const agent = startAgent();
	await writeFile(transcriptPath(fixture, "global"), jsonl(record(0)));
	await register(fixture, "global", agent.pid);
	expect((await follow(fixture)).reason).toBe("disabled");
	expect(isLiveSessionPaused(fixture.configDir, "any-org")).toBe(true);
	await register(fixture, "global", agent.pid);
	const requests = stub.paths.length;
	expect((await follow(fixture)).reason).toBe("paused");
	expect(stub.paths).toHaveLength(requests);
}, 30_000);

test("an ownership conflict drops only that session", async () => {
	let conflicts = 0;
	const stub = startStub({
		intercept: ({ pathname, body }) => {
			if (
				pathname !== "/rpc/liveSession/append" ||
				(body as { sessionId: string }).sessionId !== "taken"
			)
				return undefined;
			conflicts += 1;
			return orpcError(409, "SESSION_OWNERSHIP_CONFLICT");
		},
	});
	const fixture = await createFixture(stub);
	const agent = startAgent();
	await writeFile(transcriptPath(fixture, "taken"), jsonl(record(0)));
	await writeFile(transcriptPath(fixture, "mine"), jsonl(record(1)));
	await register(fixture, "taken", agent.pid);
	const other = startAgent();
	await register(fixture, "mine", other.pid);
	const running = follow(fixture);
	await waitFor(() => stub.lines("mine").length === 1);
	await waitFor(
		async () =>
			(await listLiveSessionRegistrations(fixture.configDir)).length === 1,
	);
	await appendFile(transcriptPath(fixture, "taken"), jsonl(record(2)));
	await Bun.sleep(300);
	expect(conflicts).toBe(1);
	agent.kill();
	other.kill();
	await running;
}, 30_000);

test("backs off on server errors and rate limits, then delivers", async () => {
	let failures = 0;
	let limited = 0;
	const stub = startStub({
		intercept: ({ pathname }) => {
			if (pathname !== "/rpc/liveSession/append") return undefined;
			if (failures < 2) {
				failures += 1;
				// A proxy's plain 503, then the API's typed retryable one.
				return failures === 1
					? new Response("unavailable", { status: 503 })
					: orpcError(503, "SERVICE_UNAVAILABLE");
			}
			if (limited < 1) {
				limited += 1;
				return orpcError(429, "TOO_MANY_REQUESTS");
			}
			return undefined;
		},
	});
	const fixture = await createFixture(stub);
	const agent = startAgent();
	await writeFile(transcriptPath(fixture, "busy"), jsonl(record(0)));
	await register(fixture, "busy", agent.pid);
	const running = follow(fixture);
	const started = Date.now();
	await waitFor(() => stub.lines("busy").length === 1);
	expect(failures).toBe(2);
	expect(limited).toBe(1);
	// The 429 waited the rate-limit backoff (600 ms here).
	expect(Date.now() - started).toBeGreaterThanOrEqual(550);
	agent.kill();
	expect((await running).reason).toBe("idle");
}, 30_000);

test("a 401 re-reads credentials and continues with a new token, forgetting nothing", async () => {
	const stub = startStub({
		intercept: ({ pathname, headers }) =>
			pathname.startsWith("/rpc/liveSession/") &&
			headers.get("x-api-key") === "live-test-token"
				? orpcError(401, "UNAUTHORIZED")
				: undefined,
	});
	const fixture = await createFixture(stub);
	const agent = startAgent();
	await writeFile(transcriptPath(fixture, "rotated"), jsonl(record(0)));
	await register(fixture, "rotated", agent.pid);
	const running = follow(fixture);
	await waitFor(() => stub.paths.includes("/rpc/liveSession/state"));
	await Bun.sleep(500);
	expect(stub.lines("rotated")).toEqual([]);
	expect(await listLiveSessionRegistrations(fixture.configDir)).toHaveLength(1);
	// A new login replaces the token.
	const credentials = JSON.parse(
		await readFile(join(fixture.configDir, "credentials.json"), "utf8"),
	);
	await writeFile(
		join(fixture.configDir, "credentials.json"),
		JSON.stringify({ ...credentials, token: "rotated-token" }),
	);
	await waitFor(() => stub.lines("rotated").length === 1);
	agent.kill();
	expect((await running).reason).toBe("idle");
}, 30_000);

test("a malformed 200 response is transient, and a plain 403 drops only that session", async () => {
	let malformed = 0;
	const stub = startStub({
		intercept: ({ pathname, body }) => {
			if (pathname !== "/rpc/liveSession/append") return undefined;
			if ((body as { sessionId: string }).sessionId === "forbidden")
				return new Response("forbidden", { status: 403 });
			if (malformed < 2) {
				malformed += 1;
				return malformed === 1
					? new Response("<html>gateway</html>", { status: 200 })
					: Response.json({ json: {} });
			}
			return undefined;
		},
	});
	const fixture = await createFixture(stub);
	await writeFile(transcriptPath(fixture, "flaky"), jsonl(record(0)));
	await writeFile(transcriptPath(fixture, "forbidden"), jsonl(record(1)));
	const agent = startAgent();
	await register(fixture, "flaky", agent.pid);
	await register(fixture, "forbidden", startAgent().pid);
	const running = follow(fixture);
	await waitFor(() => stub.lines("flaky").length === 1);
	expect(malformed).toBe(2);
	await waitFor(
		async () =>
			(await listLiveSessionRegistrations(fixture.configDir)).length === 1,
	);
	agent.kill();
	expect((await running).reason).toBe("idle");
}, 30_000);

test("stops when the user logs out or the repository is turned off", async () => {
	const stub = startStub();
	const fixture = await createFixture(stub);
	const agent = startAgent();
	await writeFile(transcriptPath(fixture, "off"), jsonl(record(0)));
	await register(fixture, "off", agent.pid);
	const running = follow(fixture);
	await waitFor(() => stub.lines("off").length === 1);
	await writeFile(
		join(fixture.configDir, "auto-upload.json"),
		JSON.stringify({ repositories: {}, version: 1 }),
	);
	await waitFor(
		async () =>
			(await listLiveSessionRegistrations(fixture.configDir)).length === 0,
	);
	expect(stub.session("off").ended).toBe(false);
	await rm(join(fixture.configDir, "auto-upload.json"));
	await register(fixture, "on", agent.pid);
	await writeFile(transcriptPath(fixture, "on"), jsonl(record(1)));
	await waitFor(() => stub.lines("on").length === 1);
	await rm(join(fixture.configDir, "credentials.json"));
	expect((await running).reason).toBe("not-authenticated");
}, 30_000);

test("only one follower runs per machine", async () => {
	const stub = startStub();
	const fixture = await createFixture(stub);
	const agent = startAgent();
	await writeFile(transcriptPath(fixture, "single"), jsonl(record(0)));
	await register(fixture, "single", agent.pid);
	const lease = await tryAcquireFileLease(
		getLiveSessionFollowerLeasePath(fixture.configDir),
	);
	expect(lease).not.toBeNull();
	// This process now holds the lease like a follower does.
	await writeFollowerMarker(fixture.configDir);
	expect((await follow(fixture)).reason).toBe("already-running");
	// The server is asked first; the lease is taken only once it answered.
	expect(stub.paths).toEqual(["/rpc/cli/authStatus"]);
	await lease?.release();
	const running = follow(fixture);
	await waitFor(() => stub.lines("single").length === 1);
	agent.kill();
	expect((await running).reason).toBe("idle");
}, 30_000);

// Codex ---------------------------------------------------------------------------

interface CodexFixture {
	readonly dayDirectory: string;
	rollout(threadId: string, meta: Record<string, unknown>): string;
}

function codexRollouts(fixture: Fixture): CodexFixture {
	const now = new Date();
	const dayDirectory = join(
		fixture.home,
		".codex",
		"sessions",
		String(now.getFullYear()),
		String(now.getMonth() + 1).padStart(2, "0"),
		String(now.getDate()).padStart(2, "0"),
	);
	return {
		dayDirectory,
		rollout: (threadId) =>
			join(dayDirectory, `rollout-2026-10-13T10-00-00-${threadId}.jsonl`),
	};
}

function codexMeta(threadId: string, parent?: string): string {
	return JSON.stringify({
		payload: {
			cwd: "/project",
			id: threadId,
			...(parent
				? {
						parent_thread_id: parent,
						source: {
							subagent: {
								thread_spawn: { depth: 1, parent_thread_id: parent },
							},
						},
						thread_source: "subagent",
					}
				: { source: "cli", thread_source: "user" }),
		},
		timestamp: "2026-10-13T10:00:00.000Z",
		type: "session_meta",
	});
}

function responseItem(text: string): string {
	return JSON.stringify({
		payload: {
			content: [{ text, type: "output_text" }],
			role: "assistant",
			type: "message",
		},
		timestamp: "2026-10-13T10:00:01.000Z",
		type: "response_item",
	});
}

function compacted(...items: string[]): string {
	return JSON.stringify({
		payload: {
			message: "summary",
			replacement_history: items.map((item) => JSON.parse(item).payload),
		},
		timestamp: "2026-10-13T10:00:02.000Z",
		type: "compacted",
	});
}

test("streams a Codex thread and its sub-agent rollouts, ending once idle without a codex process", async () => {
	const stub = startStub();
	const fixture = await createFixture(stub);
	const codex = codexRollouts(fixture);
	await mkdir(codex.dayDirectory, { recursive: true });
	const thread = "019a0000-0000-7000-8000-000000000001";
	const child = "019a0000-0000-7000-8000-000000000002";
	const unrelated = "019a0000-0000-7000-8000-000000000003";
	const main = codex.rollout(thread, {});
	await writeFile(main, jsonl(codexMeta(thread), responseItem("hello")));
	await register(fixture, thread, null, {
		source: "codex",
		transcriptPath: main,
	});
	const running = follow(fixture, { codexOrphanIdleMs: 2_000 });
	await waitFor(() => stub.lines(thread, "", "codex").length === 2);
	await writeFile(
		codex.rollout(child, {}),
		jsonl(codexMeta(child, thread), responseItem("from child")),
	);
	await writeFile(
		codex.rollout(unrelated, {}),
		jsonl(codexMeta(unrelated, "019a0000-0000-7000-8000-00000000ffff")),
	);
	await waitFor(() => stub.lines(thread, child, "codex").length === 2);
	expect(stub.session(thread, "codex").streams.has(unrelated)).toBe(false);
	await appendFile(main, jsonl(responseItem("more")));
	await waitFor(() => stub.lines(thread, "", "codex").length === 3);
	expect((await running).reason).toBe("idle");
	expect(stub.session(thread, "codex").ended).toBe(true);
	expect(stub.appends[0]?.source).toBe("codex");
}, 30_000);

test("a resumed Codex stream slims later records exactly like an uninterrupted one", async () => {
	const lines = [
		codexMeta("019a0000-0000-7000-8000-00000000000a"),
		responseItem("first answer"),
		responseItem("second answer"),
		JSON.stringify({ payload: { type: "turn_end" }, type: "event_msg" }),
		compacted(responseItem("first answer"), responseItem("second answer")),
	];
	const thread = "019a0000-0000-7000-8000-00000000000a";
	const runOnce = async (preset?: string[]) => {
		const stub = startStub();
		const fixture = await createFixture(stub);
		const codex = codexRollouts(fixture);
		await mkdir(codex.dayDirectory, { recursive: true });
		const main = codex.rollout(thread, {});
		await writeFile(main, jsonl(...lines));
		if (preset)
			stub
				.session(thread, "codex")
				.streams.set("", { generation: 1, lines: preset });
		const agent = startAgent();
		await register(fixture, thread, agent.pid, {
			agentPidSource: "ancestor",
			source: "codex",
			transcriptPath: main,
		});
		const running = follow(fixture);
		await waitFor(
			() => stub.lines(thread, "", "codex").length === lines.length,
		);
		agent.kill();
		await running;
		return stub;
	};
	const uninterrupted = await runOnce();
	const sent = uninterrupted.lines(thread, "", "codex");
	// Slimming dropped the history that repeats earlier records.
	expect(sent[4]).not.toContain("replacement_history");
	const resumed = await runOnce(sent.slice(0, 4));
	expect(resumed.appends[0]?.streams[0]?.startLine).toBe(4);
	expect(resumed.lines(thread, "", "codex")).toEqual(sent);
}, 40_000);

// Hardening -----------------------------------------------------------------------

test("a server that never agrees cannot cause a reset storm", async () => {
	const stub = startStub({
		// Always one line ahead of what was sent.
		transformAppendResult: (streams) =>
			streams.map((stream) => ({
				...stream,
				committedLines: stream.committedLines + 1,
				status: "appended",
			})),
	});
	const fixture = await createFixture(stub);
	const agent = startAgent();
	await writeFile(transcriptPath(fixture, "liar"), jsonl(record(0), record(1)));
	await register(fixture, "liar", agent.pid);
	const started = Date.now();
	const result = follow(fixture, { resetBackoffInitialMs: 200 });
	await waitFor(
		async () =>
			(await listLiveSessionRegistrations(fixture.configDir)).length === 0,
		20_000,
	);
	const appends = stub.appends.filter((append) => append.sessionId === "liar");
	// Five resets with growing pauses, then the session is dropped.
	expect(appends.filter((append) => append.streams[0]?.reset)).toHaveLength(5);
	expect(appends.length).toBeLessThanOrEqual(20);
	expect(Date.now() - started).toBeGreaterThanOrEqual(200 + 400 + 800);
	agent.kill();
	expect((await result).reason).toBe("idle");
}, 40_000);

test.skipIf(process.platform === "win32")(
	"FIFOs, swapped symlinks and paths outside the transcript directory are never read",
	async () => {
		const stub = startStub();
		const fixture = await createFixture(stub);
		const agent = startAgent();
		const id = "guarded";
		await writeFile(transcriptPath(fixture, id), jsonl(record(0)));
		const subagents = await subagentDirectory(fixture, id);
		const fifo = join(subagents, "agent-fifo.jsonl");
		Bun.spawnSync(["mkfifo", fifo]);
		// Removed on its own first: a recursive removal may open it and block.
		cleanups.push(() => unlink(fifo).catch(() => undefined));
		const swapped = join(subagents, "agent-swap.jsonl");
		await writeFile(swapped, jsonl(record(1)));
		const outside = join(fixture.home, "outside.jsonl");
		await writeFile(outside, jsonl('{"secret":"outside"}'));
		await register(fixture, id, agent.pid);
		// A crafted registration pointing outside the Claude projects directory.
		await register(fixture, "crafted", startAgent().pid, {
			transcriptPath: outside,
		});
		const running = follow(fixture);
		await waitFor(
			() => stub.lines(id).length === 1 && stub.lines(id, "swap").length === 1,
		);
		await rm(swapped);
		await symlink(outside, swapped);
		await appendFile(transcriptPath(fixture, id), jsonl(record(2)));
		await waitFor(() => stub.lines(id).length === 2);
		await Bun.sleep(300);
		expect(stub.lines(id, "swap")).toEqual([record(1)]);
		expect(stub.session(id).streams.has("fifo")).toBe(false);
		expect(stub.appends.some((append) => append.sessionId === "crafted")).toBe(
			false,
		);
		expect(JSON.stringify(stub.appends)).not.toContain("outside");
		agent.kill();
		expect((await running).reason).toBe("idle");
	},
	30_000,
);

test("a session whose agent already exited at registration is flushed and ended at once", async () => {
	const stub = startStub();
	const fixture = await createFixture(stub);
	const path = await codexPath(fixture, "exec-thread");
	await writeFile(path, jsonl(record(0), record(1)));
	await register(fixture, "exec-thread", null, {
		agentPidSource: "exited",
		source: "codex",
		transcriptPath: path,
	});
	const started = Date.now();
	const result = await follow(fixture);
	expect(result.reason).toBe("idle");
	expect(stub.lines("exec-thread", "", "codex")).toHaveLength(2);
	expect(stub.session("exec-thread", "codex").ended).toBe(true);
	expect(Date.now() - started).toBeLessThan(5_000);
}, 30_000);

test("a lease left as a regular file does not keep the follower from starting", async () => {
	const stub = startStub();
	const fixture = await createFixture(stub);
	const agent = startAgent();
	await mkdir(join(fixture.configDir, "live-sessions"), { recursive: true });
	await writeFile(getLiveSessionFollowerLeasePath(fixture.configDir), "junk");
	await writeFile(transcriptPath(fixture, "lease-file"), jsonl(record(0)));
	await register(fixture, "lease-file", agent.pid);
	const running = follow(fixture);
	await waitFor(() => stub.lines("lease-file").length === 1);
	agent.kill();
	expect((await running).reason).toBe("idle");
}, 30_000);

test("requests are split by their JSON-escaped size", async () => {
	const stub = startStub();
	const fixture = await createFixture(stub);
	const agent = startAgent();
	// Control characters expand six-fold when JSON-escaped.
	const control = (index: number) =>
		`{"i":${index},"text":"${"\u0001".repeat(250_000)}"}`;
	await writeFile(
		transcriptPath(fixture, "escaped"),
		jsonl(...Array.from({ length: 8 }, (_, index) => control(index))),
	);
	await register(fixture, "escaped", agent.pid);
	const running = follow(fixture);
	await waitFor(() => stub.lines("escaped").length === 8);
	for (const append of stub.appends)
		expect(JSON.stringify(append.streams).length).toBeLessThanOrEqual(
			3_600_000,
		);
	// 2 MB of raw lines alone would fit in two requests.
	expect(stub.appends.length).toBeGreaterThanOrEqual(4);
	agent.kill();
	await running;
}, 30_000);

test("a hanging request of one session does not delay another session", async () => {
	let release: (() => void) | undefined;
	const hanging = new Promise<void>((resolve) => {
		release = resolve;
	});
	const stub = startStub({
		intercept: async ({ pathname, body }) => {
			if (
				pathname === "/rpc/liveSession/append" &&
				(body as { sessionId: string }).sessionId === "slow"
			)
				await hanging;
			return undefined;
		},
	});
	cleanups.push(() => release?.());
	const fixture = await createFixture(stub);
	const slowAgent = startAgent();
	const fastAgent = startAgent();
	await writeFile(transcriptPath(fixture, "slow"), jsonl(record(0)));
	await writeFile(transcriptPath(fixture, "fast"), jsonl(record(1)));
	await register(fixture, "slow", slowAgent.pid);
	await register(fixture, "fast", fastAgent.pid);
	const running = follow(fixture, { requestTimeoutMs: 20_000 });
	await waitFor(() => stub.lines("fast").length === 1);
	await Bun.sleep(200);
	const killedAt = Date.now();
	fastAgent.kill();
	await waitFor(() => stub.session("fast").ended);
	expect(Date.now() - killedAt).toBeLessThan(3_000);
	release?.();
	await waitFor(() => stub.lines("slow").length === 1);
	slowAgent.kill();
	await running;
}, 40_000);

test("inside an agent sandbox the follower does not start", async () => {
	const stub = startStub();
	const fixture = await createFixture(stub);
	const agent = startAgent();
	await writeFile(transcriptPath(fixture, "sandboxed"), jsonl(record(0)));
	await register(fixture, "sandboxed", agent.pid);
	const previous = process.env.CODEX_SANDBOX;
	process.env.CODEX_SANDBOX = "seatbelt";
	try {
		expect((await follow(fixture)).reason).toBe("sandboxed");
	} finally {
		if (previous === undefined) delete process.env.CODEX_SANDBOX;
		else process.env.CODEX_SANDBOX = previous;
	}
	expect(stub.paths).toEqual([]);
	expect(await listLiveSessionRegistrations(fixture.configDir)).toHaveLength(1);
	expect(await liveSessionFiles(fixture)).not.toContain("follower.lease");
});

test("without network the follower never takes the lease, and gives it up after repeated failures", async () => {
	const stub = startStub();
	const fixture = await createFixture(stub);
	stub.stop();
	const agent = startAgent();
	await writeFile(transcriptPath(fixture, "offline"), jsonl(record(0)));
	await register(fixture, "offline", agent.pid);
	expect((await follow(fixture)).reason).toBe("capability-unconfirmed");
	expect(await liveSessionFiles(fixture)).not.toContain("follower.lease");
	expect(await listLiveSessionRegistrations(fixture.configDir)).toHaveLength(1);
}, 30_000);

test("a follower that fails unexpectedly hands its sessions to a successor", async () => {
	const stub = startStub();
	const fixture = await createFixture(stub);
	const agent = startAgent();
	await writeFile(transcriptPath(fixture, "handed-over"), jsonl(record(0)));
	await register(fixture, "handed-over", agent.pid);
	let respawned = 0;
	const result = await runLiveSessionFollower({
		configDir: fixture.configDir,
		respawn: () => {
			respawned += 1;
		},
		timing: FAST_TIMING,
		transcriptRoots: {
			get claude_code(): string[] {
				throw new Error("unexpected fault");
			},
			codex: [],
		},
	});
	expect(result.reason).toBe("failed");
	expect(respawned).toBe(1);
	expect(await listLiveSessionRegistrations(fixture.configDir)).toHaveLength(1);
	expect(await liveSessionFiles(fixture)).not.toContain("follower.lease");
});

test.skipIf(
	(process.platform !== "linux" && process.platform !== "darwin") ||
		process.getuid?.() === 0,
)(
	"an agent process it may not signal (EPERM) ends by transcript idleness",
	async () => {
		const root = Bun.spawnSync(["ps", "-A", "-o", "pid=,user="])
			.stdout.toString()
			.split("\n")
			.map((line) => line.trim().split(/\s+/u))
			.find(([pid, user]) => user === "root" && Number(pid) > 1)?.[0];
		if (!root) return;
		const stub = startStub();
		const fixture = await createFixture(stub);
		const path = transcriptPath(fixture, "foreign");
		await writeFile(path, jsonl(record(0)));
		await register(fixture, "foreign", Number(root));
		const result = await follow(fixture, { orphanIdleMs: 1_000 });
		expect(result.reason).toBe("idle");
		expect(stub.lines("foreign")).toEqual([record(0)]);
		expect(stub.session("foreign").ended).toBe(true);
	},
	30_000,
);

test("a lease held by a process that is not a follower is taken over", async () => {
	const stub = startStub();
	const fixture = await createFixture(stub);
	const agent = startAgent();
	// A fresh lease naming a live process that never acts as a follower (a
	// reused PID): no follower marker.
	const lease = getLiveSessionFollowerLeasePath(fixture.configDir);
	await mkdir(lease, { recursive: true });
	await writeFile(join(lease, "owner"), `${agent.pid}:not-a-follower`);
	await writeFile(transcriptPath(fixture, "reclaimed"), jsonl(record(0)));
	await register(fixture, "reclaimed", agent.pid);
	const running = follow(fixture, { leaseWaitMs: 5_000 });
	await waitFor(() => stub.lines("reclaimed").length === 1);
	agent.kill();
	expect((await running).reason).toBe("idle");
}, 30_000);
