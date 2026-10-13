import { afterEach, expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isProcessAlive } from "../lib/file-lease.js";
import { listLiveSessionRegistrations } from "../lib/live-session-registry.js";
import {
	type CliFixture,
	codexRolloutPath,
	createCliFixture,
	runCli,
} from "./helpers/ingest-stub.js";
import { startLiveSessionStub } from "./helpers/live-session-stub.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function waitFor(
	condition: () => boolean | Promise<boolean>,
	timeoutMs = 20_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await condition())) {
		if (Date.now() > deadline) throw new Error("Timed out waiting");
		await Bun.sleep(50);
	}
}

/** The live follower's pid from its lease, if one runs. */
async function followerPid(configDir: string): Promise<number | undefined> {
	try {
		const owner = await readFile(
			join(configDir, "live-sessions", "follower.lease", "owner"),
			"utf8",
		);
		const pid = Number(owner.split(":", 1)[0]);
		return Number.isSafeInteger(pid) && isProcessAlive(pid) ? pid : undefined;
	} catch {
		return undefined;
	}
}

function startAgent() {
	const agent = Bun.spawn(["sleep", "120"], {
		stdio: ["ignore", "ignore", "ignore"],
	});
	cleanups.push(async () => {
		agent.kill();
		await agent.exited;
	});
	return agent;
}

async function setup(
	source: "claude_code" | "codex",
	options: { readonly evidencePaused?: boolean } = {},
) {
	// Uploads made by the hooks themselves succeed; live requests are stubbed.
	const stub = startLiveSessionStub({
		intercept: ({ pathname }) =>
			pathname.startsWith("/rpc/liveSession/") ||
			pathname === "/rpc/cli/authStatus"
				? undefined
				: Response.json({ json: { sessionId: "stub", success: true } }),
	});
	const fixture = await createCliFixture(source);
	const configDir = join(fixture.home, ".rudel");
	cleanups.push(async () => {
		stub.stop();
		// The follower outlives the test's agents for a minute: end it.
		const pid = await followerPid(configDir);
		if (pid) process.kill(pid);
		await waitFor(async () => !(await followerPid(configDir)), 10_000).catch(
			() => undefined,
		);
		await rm(fixture.home, { force: true, recursive: true });
	});
	await writeFile(
		join(configDir, "credentials.json"),
		JSON.stringify({
			apiBaseUrl: stub.base,
			authType: "api-key",
			token: "live-hook-token",
			user: { email: "user@example.invalid", id: "user-1", name: "User" },
		}),
	);
	await writeFile(
		join(configDir, "projects.json"),
		JSON.stringify({
			projects: { [fixture.projectPath]: { organizationId: "org-1" } },
		}),
	);
	if (options.evidencePaused)
		await writeFile(
			join(configDir, "repository-evidence-pause.json"),
			JSON.stringify({ until: Date.now() + 3_600_000 }),
		);
	return { configDir, fixture, stub };
}

function sessionStart(
	fixture: CliFixture,
	sessionId: string,
	transcriptPath: string,
	agentPid: number,
	env: Record<string, string> = { OPALINE_LIVE_SESSIONS: "1" },
) {
	return runCli(["hooks", "claude", "session-start"], fixture, {
		env: { CLAUDE_PID: String(agentPid), ...env },
		stdin: JSON.stringify({
			cwd: fixture.projectPath,
			hook_event_name: "SessionStart",
			session_id: sessionId,
			source: "startup",
			transcript_path: transcriptPath,
		}),
	});
}

test.each([false, true])(
	"SessionStart registers sessions with one detached follower and keeps its evidence behaviour (evidence paused: %s)",
	async (evidencePaused) => {
		const { configDir, fixture, stub } = await setup("claude_code", {
			evidencePaused,
		});
		const first = startAgent();
		const second = startAgent();
		const secondPath = join(fixture.projectPath, "second-session.jsonl");
		await writeFile(secondPath, '{"type":"user","n":1}\n');
		const startedAt = performance.now();
		const result = await sessionStart(
			fixture,
			fixture.sessionId,
			fixture.transcriptPath,
			first.pid,
		);
		expect(result.exitCode).toBe(0);
		expect(performance.now() - startedAt).toBeLessThan(10_000);
		await waitFor(async () => (await followerPid(configDir)) !== undefined);
		const follower = await followerPid(configDir);
		expect(
			(await sessionStart(fixture, "second-session", secondPath, second.pid))
				.exitCode,
		).toBe(0);
		// The fixture transcript's second line has no newline yet.
		await waitFor(
			() =>
				stub.lines(fixture.sessionId).length === 1 &&
				stub.lines("second-session").length === 1,
		);
		expect(await followerPid(configDir)).toBe(follower);
		const registrations = await listLiveSessionRegistrations(configDir);
		expect(
			registrations.map((registration) => [
				registration.sessionId,
				registration.agentPid,
				registration.agentPidSource,
				registration.hookSource,
			]),
		).toEqual(
			expect.arrayContaining([
				[fixture.sessionId, first.pid, "env", "startup"],
				["second-session", second.pid, "env", "startup"],
			]),
		);
		if (evidencePaused)
			expect(
				stub.paths.filter((path) =>
					path.startsWith("/rpc/repositoryEvidence/"),
				),
			).toEqual([]);

		first.kill();
		await waitFor(() => stub.session(fixture.sessionId).ended);
		expect(stub.lines(fixture.sessionId)).toHaveLength(2);
		expect(stub.session("second-session").ended).toBe(false);
		second.kill();
		await waitFor(() => stub.session("second-session").ended);
		const log = await readFile(
			join(configDir, "logs", "hook-upload.log"),
			"utf8",
		);
		expect(log.match(/Live session follower started/gu)).toHaveLength(1);
		expect(log).toContain(
			`Live session '${fixture.sessionId}' ('claude_code') stopped: 'agent-exited'`,
		);
		// The repository evidence capture still runs (here it fails: the project
		// is not a Git repository) unless evidence capture is paused.
		expect(log.includes("Claude start context capture deferred")).toBe(
			!evidencePaused,
		);
	},
	60_000,
);

test("SessionStart does not register when live updates are turned off locally", async () => {
	const { configDir, fixture, stub } = await setup("claude_code");
	const agent = startAgent();
	const result = await sessionStart(
		fixture,
		fixture.sessionId,
		fixture.transcriptPath,
		agent.pid,
		{},
	);
	expect(result.exitCode).toBe(0);
	await Bun.sleep(1_000);
	expect(await listLiveSessionRegistrations(configDir)).toEqual([]);
	expect(await followerPid(configDir)).toBeUndefined();
	expect(stub.paths.filter((path) => path.includes("liveSession"))).toEqual([]);
}, 30_000);

function codexNotify(fixture: CliFixture, threadId: string) {
	return runCli(
		[
			"hooks",
			"codex",
			"turn-complete",
			JSON.stringify({
				cwd: fixture.projectPath,
				"input-messages": ["test"],
				"last-assistant-message": "done",
				"thread-id": threadId,
				"turn-id": "turn-1",
				type: "agent-turn-complete",
			}),
		],
		fixture,
		{ env: { OPALINE_LIVE_SESSIONS: "1" } },
	);
}

async function writeCodexThread(
	fixture: CliFixture,
	threadId: string,
	payload: Record<string, unknown>,
) {
	const path = codexRolloutPath(fixture.home, threadId);
	await mkdir(join(path, ".."), { recursive: true });
	await writeFile(
		path,
		`${JSON.stringify({ payload: { cwd: fixture.projectPath, id: threadId, ...payload }, type: "session_meta" })}\n`,
	);
}

test("the Codex notify hook registers its thread, but not internal or sub-agent threads", async () => {
	const { configDir, fixture, stub } = await setup("codex");
	await writeCodexThread(fixture, "guardian-thread", {
		parent_thread_id: fixture.sessionId,
		source: { subagent: { other: "guardian" } },
		thread_source: "guardian_review",
	});
	await writeCodexThread(fixture, "child-thread", {
		parent_thread_id: fixture.sessionId,
		source: {
			subagent: { thread_spawn: { parent_thread_id: fixture.sessionId } },
		},
		thread_source: "subagent",
	});
	// Title generation has no rollout; guardian reviews and sub-agents are not
	// sessions of their own.
	for (const threadId of [
		"title-generation-thread",
		"guardian-thread",
		"child-thread",
	])
		await codexNotify(fixture, threadId);
	expect(await listLiveSessionRegistrations(configDir)).toEqual([]);

	expect((await codexNotify(fixture, fixture.sessionId)).exitCode).toBe(0);
	const [registration, ...others] =
		await listLiveSessionRegistrations(configDir);
	expect(others).toEqual([]);
	expect(registration).toMatchObject({
		organizationId: "org-1",
		sessionId: fixture.sessionId,
		source: "codex",
		transcriptPath: codexRolloutPath(fixture.home, fixture.sessionId),
	});
	// The test runner is not a codex process.
	expect(registration?.agentPidSource).toBe("none");
	// The first turn becomes visible once it ends (the fixture's last line has
	// no newline yet).
	await waitFor(() => stub.lines(fixture.sessionId, "", "codex").length === 1);
	// Re-registration on later turns is a no-op.
	await codexNotify(fixture, fixture.sessionId);
	expect(
		(await listLiveSessionRegistrations(configDir)).map(
			(item) => item.startedAt,
		),
	).toEqual([registration?.startedAt as number]);
}, 60_000);
