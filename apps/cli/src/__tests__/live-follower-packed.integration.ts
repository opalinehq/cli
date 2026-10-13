import { afterAll, expect, test } from "bun:test";
import {
	appendFile,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBuiltCli } from "./helpers/cli-e2e.js";
import { startLiveSessionStub } from "./helpers/live-session-stub.js";

/**
 * Packed-artifact smoke for the live session follower on every CI platform:
 * the installed CLI's SessionStart hook starts the follower through the
 * launcher; the hook and launcher exit, the follower keeps running, syncs
 * lines, and exits after the (fake) agent process is gone.
 *
 *   OPALINE_PACKED_CLI=/abs/path/to/package/dist/cli.js \
 *     bun test ./src/__tests__/live-follower-packed.integration.ts
 */

const cleanups: (() => Promise<void> | void)[] = [];
afterAll(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as { code?: string }).code !== "ESRCH";
	}
}

async function waitFor(
	condition: () => boolean | Promise<boolean>,
	timeoutMs: number,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await condition())) {
		if (Date.now() > deadline) throw new Error("Timed out waiting");
		await Bun.sleep(100);
	}
}

test("the packed follower outlives its launcher, syncs, and exits after the agent", async () => {
	const cliPath = process.env.OPALINE_PACKED_CLI;
	expect(cliPath).toBeTruthy();
	const stub = startLiveSessionStub();
	const home = await mkdtemp(join(tmpdir(), "opaline-live-packed-"));
	const configDir = join(home, ".rudel");
	const projectPath = join(home, "project");
	const sessionId = "packed-live-session";
	// Claude Code keeps transcripts under ~/.claude/projects.
	const transcripts = join(home, ".claude", "projects", "-project");
	const transcriptPath = join(transcripts, `${sessionId}.jsonl`);
	await mkdir(configDir, { recursive: true });
	await mkdir(projectPath, { recursive: true });
	await mkdir(transcripts, { recursive: true });
	await writeFile(
		join(configDir, "credentials.json"),
		JSON.stringify({
			apiBaseUrl: stub.base,
			authType: "api-key",
			token: "packed-live-token",
			user: { email: "user@example.invalid", id: "user-1", name: "User" },
		}),
	);
	await writeFile(
		join(configDir, "projects.json"),
		JSON.stringify({
			projects: { [projectPath]: { organizationId: "org-1" } },
		}),
	);
	await writeFile(transcriptPath, '{"type":"user","n":0}\n');
	// A stand-in for the Claude Code process, on every platform.
	const agent = Bun.spawn(["node", "-e", "setTimeout(() => {}, 600000)"], {
		stdio: ["ignore", "ignore", "ignore"],
	});
	const leaseOwner = join(
		configDir,
		"live-sessions",
		"follower.lease",
		"owner",
	);
	let followerPid: number | undefined;
	cleanups.push(async () => {
		agent.kill();
		if (followerPid && isAlive(followerPid)) process.kill(followerPid);
		stub.stop();
		await rm(home, { force: true, recursive: true }).catch(() => undefined);
	});

	const result = await runBuiltCli(["hooks", "claude", "session-start"], {
		cliPath,
		configDir,
		env: { CLAUDE_PID: String(agent.pid), OPALINE_LIVE_SESSIONS: "1" },
		home,
		stdin: JSON.stringify({
			cwd: projectPath,
			hook_event_name: "SessionStart",
			session_id: sessionId,
			source: "startup",
			transcript_path: transcriptPath,
		}),
	});
	expect(result.exitCode).toBe(0);

	// The hook (and its launcher) have exited; the follower runs on.
	await waitFor(async () => {
		try {
			followerPid = Number(
				(await readFile(leaseOwner, "utf8")).split(":", 1)[0],
			);
			return Number.isSafeInteger(followerPid) && isAlive(followerPid);
		} catch {
			return false;
		}
	}, 30_000);
	await waitFor(() => stub.lines(sessionId).length === 1, 30_000);
	await appendFile(transcriptPath, '{"type":"assistant","n":1}\n');
	await waitFor(() => stub.lines(sessionId).length === 2, 30_000);
	expect(isAlive(followerPid as number)).toBe(true);

	agent.kill();
	await agent.exited;
	await waitFor(() => stub.session(sessionId).ended, 30_000);
	// With no sessions left, the follower exits after a minute.
	await waitFor(() => !isAlive(followerPid as number), 120_000);
	expect(stub.lines(sessionId)).toEqual([
		'{"type":"user","n":0}',
		'{"type":"assistant","n":1}',
	]);
}, 240_000);
