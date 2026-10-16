import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	symlink,
	utimes,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	isClaudeTaskOutputSweepDue,
	sweepClaudeTaskOutputs,
	TASK_OUTPUT_SWEEP_MARKER,
	TASK_OUTPUT_SWEEP_MAX_RUNS,
} from "../lib/claude-task-output-sweep.js";
import type { Credentials } from "../lib/credentials.js";
import { getOrCreateCliInstallationId } from "../lib/product-analytics.js";
import { normalizeRepositoryEvidenceEndpoint } from "../lib/repository-evidence-pending.js";
import type { captureAndUploadSessionEvidence } from "../lib/session-evidence.js";
import { planTranscriptRevision } from "../lib/transcript-revision.js";
import { advanceTranscriptRevision } from "../lib/transcript-revision-store.js";

type CaptureInput = Parameters<typeof captureAndUploadSessionEvidence>[0];

const CREDENTIALS: Credentials = {
	apiBaseUrl: "https://api.example.invalid",
	authType: "api-key",
	token: "test",
	user: { id: "user-1", email: "test@example.invalid", name: "Test" },
};
const SLUG = "-repo";
const uid = process.getuid?.() ?? 0;
const previousConfigDir = process.env.OPALINE_CONFIG_DIR;
let root = "";

beforeAll(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "opaline-task-sweep-")));
});

afterAll(async () => {
	if (previousConfigDir === undefined) delete process.env.OPALINE_CONFIG_DIR;
	else process.env.OPALINE_CONFIG_DIR = previousConfigDir;
	await rm(root, { force: true, recursive: true });
});

/**
 * A machine with earlier Claude Code sessions: `delivered` (its transcript
 * revision was delivered, a real output is on disk), `undelivered` (no
 * delivered revision), `agents-only` (only an async agent's symlink),
 * `active` (still being written) and `gone` (no transcript any more).
 */
async function createMachine(name: string) {
	const home = join(root, name);
	const configDir = join(home, "config");
	const repository = join(home, "repository");
	const temporary = join(home, "tmp");
	const projects = join(home, "projects");
	process.env.OPALINE_CONFIG_DIR = configDir;
	await mkdir(repository, { recursive: true });
	execFileSync("git", ["init", "-q"], { cwd: repository });
	await mkdir(configDir, { recursive: true });
	await writeFile(
		join(configDir, "projects.json"),
		JSON.stringify({ projects: { [repository]: { organizationId: "org" } } }),
	);
	const old = new Date(Date.now() - 2 * 60 * 60_000);
	const session = async (
		sessionId: string,
		options: {
			readonly output?: "file" | "symlink";
			readonly transcript?: "old" | "active" | "none";
		},
	) => {
		const tasks = join(temporary, `claude-${uid}`, SLUG, sessionId, "tasks");
		await mkdir(tasks, { recursive: true });
		if (options.output === "symlink")
			await symlink(join(projects, "agent.jsonl"), join(tasks, "a1.output"));
		else await writeFile(join(tasks, "b1.output"), "build ok\n");
		if (options.transcript === "none") return;
		const transcriptPath = join(projects, SLUG, `${sessionId}.jsonl`);
		await mkdir(join(projects, SLUG), { recursive: true });
		await writeFile(
			transcriptPath,
			`${JSON.stringify({ type: "user", sessionId, cwd: repository, timestamp: "2026-10-01T10:00:00.000Z", message: { role: "user", content: "Build" } })}\n`,
		);
		if (options.transcript !== "active") await utimes(transcriptPath, old, old);
	};
	await session("delivered", { transcript: "old" });
	await session("undelivered", { transcript: "old" });
	await session("agents-only", { output: "symlink", transcript: "old" });
	await session("active", { transcript: "active" });
	await session("gone", { transcript: "none" });
	const content = await readFile(join(projects, SLUG, "delivered.jsonl"));
	const scope = {
		actorId: "user-1",
		provider: "claude_code" as const,
		providerInstanceId: getOrCreateCliInstallationId(),
		sessionId: "delivered",
	};
	const plan = await planTranscriptRevision({
		content,
		previous: undefined,
		scope,
		terminal: true,
	});
	await advanceTranscriptRevision(
		plan.manifest,
		{
			endpoint: normalizeRepositoryEvidenceEndpoint(
				`${CREDENTIALS.apiBaseUrl}/rpc`,
			),
			organizationId: "org",
			transcriptScope: scope,
		},
		configDir,
	);
	const calls: CaptureInput[] = [];
	const sweep = (
		options: { readonly budgetMs?: number; readonly fail?: boolean } = {},
	) =>
		sweepClaudeTaskOutputs({
			budgetMs: options.budgetMs,
			capture: async (input) => {
				calls.push(input);
				if (options.fail) throw new Error("offline");
				return undefined;
			},
			configDir,
			credentials: CREDENTIALS,
			env: { CLAUDE_CODE_TMPDIR: temporary },
			projectsDirectory: projects,
		});
	return { calls, configDir, projects, sweep };
}

describe("one-time sweep of earlier sessions' task outputs", () => {
	test("captures each delivered session once, continuing its delivered transcript", async () => {
		const machine = await createMachine("once");
		expect(await isClaudeTaskOutputSweepDue(machine.configDir)).toBe(true);
		expect(await machine.sweep()).toEqual({
			status: "complete",
			captured: 1,
			skipped: 1,
			failed: 0,
		});
		expect(machine.calls).toHaveLength(1);
		const [call] = machine.calls;
		expect(call).toMatchObject({
			backgroundDelivery: "none",
			lifecycle: "checkpoint",
			organizationId: "org",
			requireDeliveredTranscript: true,
			terminalTranscript: true,
			request: {
				kind: "file",
				transcriptPath: join(machine.projects, SLUG, "delivered.jsonl"),
				metadata: { sessionId: "delivered", source: "claude_code" },
			},
		});
		expect(await isClaudeTaskOutputSweepDue(machine.configDir)).toBe(false);
		expect(await machine.sweep()).toMatchObject({ status: "not-due" });
		expect(machine.calls).toHaveLength(1);
	});

	test("an interrupted or failed session is never captured again", async () => {
		const machine = await createMachine("interrupted");
		// A run cut by its budget attempts nothing and continues next time.
		expect(await machine.sweep({ budgetMs: 0 })).toMatchObject({
			status: "partial",
			captured: 0,
		});
		expect(await isClaudeTaskOutputSweepDue(machine.configDir)).toBe(true);
		expect(await machine.sweep({ fail: true })).toEqual({
			status: "complete",
			captured: 0,
			skipped: 1,
			failed: 1,
		});
		const marker = JSON.parse(
			await readFile(join(machine.configDir, TASK_OUTPUT_SWEEP_MARKER), "utf8"),
		);
		expect(marker).toMatchObject({
			version: 1,
			runs: 2,
			attempted: [`${SLUG}/delivered`, `${SLUG}/undelivered`],
		});
		expect(await machine.sweep()).toMatchObject({ status: "not-due" });
		expect(machine.calls).toHaveLength(1);
	});

	test("ends after its last run whatever remains", async () => {
		const machine = await createMachine("bounded");
		for (let run = 1; run < TASK_OUTPUT_SWEEP_MAX_RUNS; run += 1)
			expect(await machine.sweep({ budgetMs: 0 })).toMatchObject({
				status: "partial",
			});
		expect(await machine.sweep({ budgetMs: 0 })).toMatchObject({
			status: "complete",
		});
		expect(await isClaudeTaskOutputSweepDue(machine.configDir)).toBe(false);
		expect(machine.calls).toHaveLength(0);
	});
});
