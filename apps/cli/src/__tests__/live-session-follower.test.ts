import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	appendFile,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tryAcquireFileLease } from "../lib/file-lease.js";
import {
	type LiveSessionFollowerOptions,
	runLiveSessionFollower,
} from "../lib/live-session-follower.js";
import {
	hashLiveSessionLine,
	processLiveSessionLine,
} from "../lib/live-session-lines.js";
import { isLiveSessionPaused } from "../lib/live-session-pause.js";
import { createTranscriptSlimmer } from "../lib/transcript-slim.js";
import {
	type LiveSessionStub,
	orpcError,
	startLiveSessionStub,
} from "./helpers/live-session-stub.js";

const FAST_TIMING = {
	backoffInitialMs: 50,
	backoffMaxMs: 200,
	debounceMs: 100,
	finalReadDelayMs: 50,
	finalFlushMs: 5_000,
	leaseWaitMs: 300,
	settingsCheckMs: 200,
	startTimeCheckMs: 200,
	tickMs: 50,
} as const;
const SECRET = `ghp_${"a".repeat(36)}`;

interface Fixture {
	readonly home: string;
	readonly configDir: string;
	readonly projectPath: string;
	readonly sessionId: string;
	readonly transcriptPath: string;
	readonly subagentDirectory: string;
	readonly agent: ReturnType<typeof Bun.spawn>;
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function createFixture(stub: LiveSessionStub): Promise<Fixture> {
	const home = await mkdtemp(join(tmpdir(), "opaline-live-"));
	const configDir = join(home, ".rudel");
	const projectPath = join(home, "project");
	const sessionId = "live-session-1";
	const transcriptDirectory = join(home, ".claude", "projects", "-project");
	const transcriptPath = join(transcriptDirectory, `${sessionId}.jsonl`);
	const subagentDirectory = join(transcriptDirectory, sessionId, "subagents");
	await mkdir(configDir, { recursive: true });
	await mkdir(projectPath, { recursive: true });
	await mkdir(subagentDirectory, { recursive: true });
	await writeFile(
		join(configDir, "credentials.json"),
		JSON.stringify({
			apiBaseUrl: stub.base,
			authType: "api-key",
			token: "live-test-token",
			user: { email: "user@example.invalid", id: "user-1", name: "User" },
		}),
	);
	const agent = Bun.spawn(["sleep", "120"], {
		stdio: ["ignore", "ignore", "ignore"],
	});
	cleanups.push(async () => {
		agent.kill();
		await agent.exited;
		await rm(home, { force: true, recursive: true });
	});
	return {
		agent,
		configDir,
		home,
		projectPath,
		sessionId,
		subagentDirectory,
		transcriptPath,
	};
}

function startStub(options: Parameters<typeof startLiveSessionStub>[0] = {}) {
	const stub = startLiveSessionStub(options);
	cleanups.push(() => stub.stop());
	return stub;
}

function follow(
	fixture: Fixture,
	overrides: Partial<LiveSessionFollowerOptions> = {},
) {
	return runLiveSessionFollower({
		agentPid: fixture.agent.pid,
		configDir: fixture.configDir,
		cwd: fixture.projectPath,
		organizationId: "org-1",
		sessionId: fixture.sessionId,
		startedAt: Date.now(),
		timing: FAST_TIMING,
		transcriptPath: fixture.transcriptPath,
		...overrides,
	});
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

function mainLines(stub: LiveSessionStub): string[] {
	return stub.streams.get("")?.lines ?? [];
}

test("streams the main and subagent transcripts, filters secrets, and ends with the agent", async () => {
	const stub = startStub();
	const fixture = await createFixture(stub);
	const secretLine = record(1, `export TOKEN=${SECRET}`);
	await writeFile(fixture.transcriptPath, jsonl(record(0), secretLine));
	const subagentPath = join(fixture.subagentDirectory, "agent-a1.jsonl");
	await writeFile(subagentPath, jsonl(record(100)));
	await writeFile(join(fixture.subagentDirectory, "agent-a1.meta.json"), "{}");
	const running = follow(fixture);

	await waitFor(
		() =>
			mainLines(stub).length === 2 &&
			stub.streams.get("a1")?.lines.length === 1,
	);
	expect(mainLines(stub)[0]).toBe(record(0));
	expect(mainLines(stub)[1]).not.toContain(SECRET);
	expect(mainLines(stub)[1]).toBe(processed(secretLine));
	expect(stub.streams.has("a1.meta")).toBe(false);
	const first = stub.appends[0];
	expect(first).toMatchObject({
		organizationId: "org-1",
		projectPath: fixture.projectPath,
		sessionId: fixture.sessionId,
	});

	// New complete lines arrive; an unterminated line waits for its newline.
	await appendFile(
		fixture.transcriptPath,
		`${record(2)}\n${record(3).slice(0, 10)}`,
	);
	await writeFile(
		join(fixture.subagentDirectory, "agent-b2.jsonl"),
		jsonl(record(200)),
	);
	await waitFor(
		() =>
			mainLines(stub).length === 3 &&
			stub.streams.get("b2")?.lines.length === 1,
	);
	await Bun.sleep(300);
	expect(mainLines(stub)).toHaveLength(3);
	await appendFile(fixture.transcriptPath, `${record(3).slice(10)}\n`);
	await waitFor(() => mainLines(stub).length === 4);
	expect(mainLines(stub)[3]).toBe(record(3));

	// A final unterminated line is sent after the agent exits only when it is
	// complete JSON.
	await appendFile(fixture.transcriptPath, record(4));
	await appendFile(subagentPath, '{"partial":');
	fixture.agent.kill();
	const result = await running;
	expect(result.reason).toBe("agent-exited");
	expect(mainLines(stub)).toEqual([
		record(0),
		processed(secretLine),
		record(2),
		record(3),
		record(4),
	]);
	expect(stub.streams.get("a1")?.lines).toEqual([record(100)]);
	expect(stub.ended).toBe(true);
	expect(stub.appends.at(-1)?.ended).toBe(true);
	expect(stub.appends.slice(0, -1).some((append) => append.ended)).toBe(false);
	expect(stub.statusCounts["out-of-sync"]).toBeUndefined();
	expect(
		(await readdir(join(fixture.configDir, "live-sessions"))).filter(
			(name) => name.endsWith(".lease") || name.startsWith("agent-"),
		),
	).toEqual([]);
}, 30_000);

test("resumes after the server's committed lines when the local file still matches", async () => {
	const stub = startStub();
	const fixture = await createFixture(stub);
	await writeFile(
		fixture.transcriptPath,
		jsonl(record(0), record(1), record(2)),
	);
	stub.streams.set("", { generation: 1, lines: [record(0), record(1)] });
	stub.ended = true;
	const running = follow(fixture);
	await waitFor(() => mainLines(stub).length === 3);
	expect(stub.appends[0]?.streams).toEqual([
		{
			agentId: null,
			lines: [record(2)],
			previousLineSha256: hashLiveSessionLine(record(1)),
			startLine: 2,
		},
	]);
	expect(stub.ended).toBe(false);
	expect(stub.streams.get("")?.generation).toBe(1);
	fixture.agent.kill();
	expect((await running).reason).toBe("agent-exited");
}, 30_000);

test("starts a stream over when the server's last line differs from the local file", async () => {
	const stub = startStub();
	const fixture = await createFixture(stub);
	await writeFile(fixture.transcriptPath, jsonl(record(0), record(1)));
	stub.streams.set("", { generation: 1, lines: [record(0), '{"other":1}'] });
	const running = follow(fixture);
	await waitFor(() => stub.appends.length > 0 && mainLines(stub).length === 2);
	expect(stub.appends[0]?.streams[0]).toMatchObject({
		agentId: null,
		previousLineSha256: null,
		reset: true,
		startLine: 0,
	});
	expect(mainLines(stub)).toEqual([record(0), record(1)]);
	expect(stub.streams.get("")?.generation).toBe(2);

	// A rewritten (shorter) file starts over as well.
	await writeFile(fixture.transcriptPath, jsonl(record(9)));
	await waitFor(() => mainLines(stub).length === 1);
	expect(mainLines(stub)).toEqual([record(9)]);
	expect(stub.appends.at(-1)?.streams[0]?.reset).toBe(true);
	fixture.agent.kill();
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
	await writeFile(fixture.transcriptPath, jsonl(record(0), record(1)));
	const running = follow(fixture);
	await waitFor(() => stub.appends.length >= 2);
	await appendFile(fixture.transcriptPath, jsonl(record(2)));
	await waitFor(() => mainLines(stub).length === 3);
	fixture.agent.kill();
	await running;
	expect(mainLines(stub)).toEqual([record(0), record(1), record(2)]);
	expect(stub.statusCounts["already-committed"]).toBeGreaterThanOrEqual(1);
}, 30_000);

test("splits large backlogs into requests within the protocol limits", async () => {
	const stub = startStub();
	const fixture = await createFixture(stub);
	const big = (index: number) => record(index, "x".repeat(400 * 1024));
	await writeFile(
		fixture.transcriptPath,
		jsonl(...Array.from({ length: 12 }, (_, index) => big(index))),
	);
	const running = follow(fixture);
	await waitFor(() => mainLines(stub).length === 12);
	for (const append of stub.appends) {
		const bytes = append.streams
			.flatMap((stream) => stream.lines)
			.reduce((total, line) => total + Buffer.byteLength(line), 0);
		expect(bytes).toBeLessThanOrEqual(1_572_864);
	}
	expect(stub.appends.length).toBeGreaterThanOrEqual(4);
	fixture.agent.kill();
	await running;
}, 30_000);

test("replaces lines that are too large to send with an omission marker", async () => {
	const stub = startStub();
	const fixture = await createFixture(stub);
	const huge = record(1, "y".repeat(1_100_000));
	await writeFile(fixture.transcriptPath, jsonl(record(0), huge, record(2)));
	const running = follow(fixture);
	await waitFor(() => mainLines(stub).length === 3);
	expect(JSON.parse(mainLines(stub)[1] as string)).toEqual({
		originalBytes: Buffer.byteLength(huge),
		reason: "too-large",
		type: "opaline-live-omitted",
	});
	fixture.agent.kill();
	await running;
}, 30_000);

test("does nothing when the server does not advertise live sessions", async () => {
	const stub = startStub({ liveSessions: false });
	const fixture = await createFixture(stub);
	await writeFile(fixture.transcriptPath, jsonl(record(0)));
	const result = await follow(fixture);
	expect(result.reason).toBe("unsupported");
	expect(stub.paths).toEqual(["/rpc/cli/authStatus"]);
});

test("a server pause stops the follower and is honoured by the next one", async () => {
	const stub = startStub({
		intercept: ({ pathname }) =>
			pathname === "/rpc/liveSession/append"
				? orpcError(403, "LIVE_SESSIONS_DISABLED", {
						pauseSeconds: 600,
						scope: "workspace",
					})
				: undefined,
	});
	const fixture = await createFixture(stub);
	await writeFile(fixture.transcriptPath, jsonl(record(0)));
	expect((await follow(fixture)).reason).toBe("disabled");
	expect(isLiveSessionPaused(fixture.configDir, "org-1")).toBe(true);
	expect(isLiveSessionPaused(fixture.configDir, "org-2")).toBe(false);
	const requests = stub.paths.length;
	expect((await follow(fixture)).reason).toBe("paused");
	expect(stub.paths).toHaveLength(requests);
	expect((await follow(fixture, { organizationId: "org-2" })).reason).not.toBe(
		"paused",
	);
}, 30_000);

test("stops on an ownership conflict without retrying", async () => {
	const stub = startStub({
		intercept: ({ pathname }) =>
			pathname === "/rpc/liveSession/append"
				? orpcError(409, "SESSION_OWNERSHIP_CONFLICT")
				: undefined,
	});
	const fixture = await createFixture(stub);
	await writeFile(fixture.transcriptPath, jsonl(record(0)));
	expect((await follow(fixture)).reason).toBe("ownership-conflict");
	expect(
		stub.paths.filter((path) => path === "/rpc/liveSession/append"),
	).toHaveLength(1);
});

test("retries server errors with backoff and delivers afterwards", async () => {
	let failures = 0;
	const stub = startStub({
		intercept: ({ pathname }) => {
			if (pathname !== "/rpc/liveSession/append" || failures >= 2)
				return undefined;
			failures += 1;
			return new Response("unavailable", { status: 503 });
		},
	});
	const fixture = await createFixture(stub);
	await writeFile(fixture.transcriptPath, jsonl(record(0)));
	const running = follow(fixture);
	await waitFor(() => mainLines(stub).length === 1);
	expect(failures).toBe(2);
	fixture.agent.kill();
	expect((await running).reason).toBe("agent-exited");
}, 30_000);

test("only one follower runs per session", async () => {
	const stub = startStub();
	const fixture = await createFixture(stub);
	await writeFile(fixture.transcriptPath, jsonl(record(0)));
	const lease = await tryAcquireFileLease(
		join(
			fixture.configDir,
			"live-sessions",
			`${createHash("sha256").update(fixture.sessionId).digest("hex")}.lease`,
		),
	);
	expect(lease).not.toBeNull();
	expect((await follow(fixture)).reason).toBe("already-following");
	expect(stub.paths).toEqual(["/rpc/cli/authStatus"]);
	await lease?.release();
	const running = follow(fixture);
	await waitFor(() => mainLines(stub).length === 1);
	fixture.agent.kill();
	expect((await running).reason).toBe("agent-exited");
}, 30_000);

test("a later session in the same agent process ends the previous one", async () => {
	const stub = startStub();
	const fixture = await createFixture(stub);
	await writeFile(fixture.transcriptPath, jsonl(record(0)));
	const startedAt = Date.now();
	const running = follow(fixture, { startedAt });
	await waitFor(() => mainLines(stub).length === 1);
	await writeFile(
		join(fixture.configDir, "live-sessions", `agent-${fixture.agent.pid}.json`),
		JSON.stringify({ sessionId: "live-session-2", startedAt: startedAt + 1 }),
	);
	expect((await running).reason).toBe("session-replaced");
	expect(stub.ended).toBe(true);
}, 30_000);

test("stops when the repository is turned off", async () => {
	const stub = startStub();
	const fixture = await createFixture(stub);
	await writeFile(fixture.transcriptPath, jsonl(record(0)));
	const running = follow(fixture);
	await waitFor(() => mainLines(stub).length === 1);
	await writeFile(
		join(fixture.configDir, "auto-upload.json"),
		JSON.stringify({ repositories: {}, version: 1 }),
	);
	expect((await running).reason).toBe("repository-disabled");
	expect(stub.ended).toBe(false);
}, 30_000);

test("waits for the transcript to appear", async () => {
	const stub = startStub();
	const fixture = await createFixture(stub);
	const running = follow(fixture);
	await Bun.sleep(300);
	await writeFile(fixture.transcriptPath, jsonl(record(0)));
	await waitFor(() => mainLines(stub).length === 1);
	fixture.agent.kill();
	expect((await running).reason).toBe("agent-exited");
}, 30_000);

test("gives up when the transcript never appears", async () => {
	const stub = startStub();
	const fixture = await createFixture(stub);
	const result = await follow(fixture, {
		timing: { ...FAST_TIMING, transcriptWaitMs: 300 },
	});
	expect(result.reason).toBe("transcript-missing");
	expect(stub.appends).toEqual([]);
}, 30_000);

test("keeps no state for an agent that already exited", async () => {
	const stub = startStub();
	const fixture = await createFixture(stub);
	fixture.agent.kill();
	await fixture.agent.exited;
	expect((await follow(fixture)).reason).toBe("agent-exited");
	expect(stub.paths).toEqual([]);
	expect(
		await readFile(join(fixture.configDir, "credentials.json"), "utf8"),
	).toContain("live-test-token");
});
