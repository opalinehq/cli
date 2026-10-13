import { afterEach, expect, test } from "bun:test";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createCliFixture, runCli } from "./helpers/ingest-stub.js";
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

async function setup(options: { readonly evidencePaused: boolean }) {
	const stub = startLiveSessionStub();
	cleanups.push(() => stub.stop());
	const fixture = await createCliFixture("claude_code");
	const configDir = join(fixture.home, ".rudel");
	const agent = Bun.spawn(["sleep", "120"], {
		stdio: ["ignore", "ignore", "ignore"],
	});
	cleanups.push(async () => {
		agent.kill();
		await agent.exited;
		// Give the follower time to notice and release its files.
		await waitFor(async () => !(await hasLease(configDir)), 10_000).catch(
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
	return { agent, configDir, fixture, stub };
}

async function hasLease(configDir: string): Promise<boolean> {
	try {
		return (await readdir(join(configDir, "live-sessions"))).some((name) =>
			name.endsWith(".lease"),
		);
	} catch {
		return false;
	}
}

test.each([false, true])(
	"SessionStart starts a detached follower and keeps its evidence behaviour (evidence paused: %s)",
	async (evidencePaused) => {
		const { agent, configDir, fixture, stub } = await setup({
			evidencePaused,
		});
		const startedAt = performance.now();
		const result = await runCli(["hooks", "claude", "session-start"], fixture, {
			env: { CLAUDE_PID: String(agent.pid), OPALINE_LIVE_SESSIONS: "1" },
			stdin: JSON.stringify({
				cwd: fixture.projectPath,
				hook_event_name: "SessionStart",
				session_id: fixture.sessionId,
				source: "startup",
				transcript_path: fixture.transcriptPath,
			}),
		});
		const hookMs = performance.now() - startedAt;
		expect(result.exitCode).toBe(0);
		expect(hookMs).toBeLessThan(10_000);

		// The fixture transcript's second line has no newline yet.
		await waitFor(() => (stub.streams.get("")?.lines.length ?? 0) === 1);
		expect(await hasLease(configDir)).toBe(true);
		const evidenceRequests = stub.paths.filter((path) =>
			path.startsWith("/rpc/repositoryEvidence/"),
		);
		if (evidencePaused) expect(evidenceRequests).toEqual([]);

		agent.kill();
		await waitFor(() => stub.ended);
		expect(stub.streams.get("")?.lines).toHaveLength(2);
		await waitFor(async () => !(await hasLease(configDir)));
		const log = await readFile(
			join(configDir, "logs", "hook-upload.log"),
			"utf8",
		);
		expect(log).toContain(
			`Live session updates for '${fixture.sessionId}' started ('startup'`,
		);
		expect(log).toContain("stopped: 'agent-exited'");
		// The repository evidence capture still runs (here it fails: the project
		// is not a Git repository) unless evidence capture is paused.
		expect(log.includes("Claude start context capture deferred")).toBe(
			!evidencePaused,
		);
	},
	60_000,
);

test("SessionStart does not start a follower when live updates are turned off locally", async () => {
	const { agent, configDir, fixture, stub } = await setup({
		evidencePaused: true,
	});
	const result = await runCli(["hooks", "claude", "session-start"], fixture, {
		env: { CLAUDE_PID: String(agent.pid) },
		stdin: JSON.stringify({
			cwd: fixture.projectPath,
			session_id: fixture.sessionId,
			transcript_path: fixture.transcriptPath,
		}),
	});
	expect(result.exitCode).toBe(0);
	await Bun.sleep(1_500);
	expect(stub.paths).toEqual([]);
	expect(await hasLease(configDir)).toBe(false);
}, 30_000);
