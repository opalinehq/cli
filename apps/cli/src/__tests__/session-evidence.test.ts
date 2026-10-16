import { expect, test } from "bun:test";
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import {
	mkdir,
	mkdtemp,
	open,
	readdir,
	readFile,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TranscriptNotDeliveredError } from "../lib/claude-task-output-sweep.js";
import { readPendingRepositoryEvidence } from "../lib/repository-evidence-pending.js";
import {
	captureAndUploadSessionEvidence,
	EVIDENCE_TRANSCRIPT_INPUT_MAX_BYTES,
	EvidenceBudgetError,
	retryPendingSessionEvidence,
} from "../lib/session-evidence.js";
import { startEvidenceProtocolStub } from "./helpers/evidence-protocol-stub.js";
import { createCliFixture, runCli } from "./helpers/ingest-stub.js";

test.each([false, true])(
	"rejects aggregate transcript redaction anomalies before collecting or persisting evidence (child: %s)",
	async (child) => {
		await expect(
			captureAndUploadSessionEvidence({
				credentials: {
					authType: "api-key",
					token: "test",
					apiBaseUrl: "https://example.invalid",
					user: { id: "user", email: "test@example.invalid", name: "Test" },
				},
				hookReceivedAt: new Date().toISOString(),
				lifecycle: "end",
				organizationId: "org",
				request: {
					content: child ? "" : `token=ghp_${"a".repeat(36)}\n`,
					subagents: child
						? [{ agentId: "child", content: `token=ghp_${"a".repeat(36)}\n` }]
						: undefined,
					projectPath: "/missing-evidence-repository",
					sessionId: "session",
					source: "claude_code",
					upload_mode: "hook",
				},
				terminalTranscript: true,
			}),
		).rejects.toThrow(/redaction.*budget/iu);
	},
);

test("rejects oversized file-backed evidence before reading the root or children", async () => {
	const directory = await mkdtemp(join(tmpdir(), "opaline-evidence-size-"));
	try {
		const transcriptPath = join(directory, "large.jsonl");
		const file = await open(transcriptPath, "w");
		await file.truncate(EVIDENCE_TRANSCRIPT_INPUT_MAX_BYTES + 1);
		await file.close();
		await expect(
			captureAndUploadSessionEvidence({
				credentials: {
					authType: "api-key",
					token: "test",
					apiBaseUrl: "https://example.invalid",
					user: { id: "user", email: "test@example.invalid", name: "Test" },
				},
				hookReceivedAt: new Date().toISOString(),
				lifecycle: "end",
				organizationId: "org",
				terminalTranscript: true,
				request: {
					kind: "file",
					metadata: {
						projectPath: "/missing-evidence-repository",
						sessionId: "session",
						source: "claude_code",
					},
					transcriptPath,
					subagents: [
						{ agentId: "child", path: join(directory, "missing-child.jsonl") },
					],
					subagentDiscovery: {
						omittedCount: 0,
						reason: null,
						status: "complete",
					},
				},
			}),
		).rejects.toThrow("input budget");
	} finally {
		await rm(directory, { force: true, recursive: true });
	}
});

test("SessionStart preserves bounded file-backed processing", async () => {
	const fixture = await createCliFixture("claude_code");
	try {
		const configDir = join(fixture.home, ".rudel");
		await writeFile(
			join(configDir, "credentials.json"),
			JSON.stringify({
				authType: "api-key",
				token: "test",
				apiBaseUrl: "https://example.invalid",
				user: { id: "user", email: "test@example.invalid", name: "Test" },
			}),
		);
		await writeFile(
			join(configDir, "projects.json"),
			JSON.stringify({
				projects: { [fixture.projectPath]: { organizationId: "org" } },
			}),
		);
		const file = await open(fixture.transcriptPath, "w");
		await file.truncate(EVIDENCE_TRANSCRIPT_INPUT_MAX_BYTES + 1);
		await file.close();
		const result = await runCli(["hooks", "claude", "session-start"], fixture, {
			stdin: JSON.stringify({
				cwd: fixture.projectPath,
				session_id: fixture.sessionId,
				transcript_path: fixture.transcriptPath,
			}),
		});
		expect(result.exitCode).toBe(0);
		expect(
			await readFile(join(configDir, "logs", "hook-upload.log"), "utf8"),
		).toContain("input budget");
		expect(await readdir(configDir)).not.toContain(
			"repository-evidence-sources",
		);
	} finally {
		await rm(fixture.home, { force: true, recursive: true });
	}
});

test("abandons a collected capture and removes its source when pending persistence fails", async () => {
	const fixture = await createCliFixture("claude_code");
	try {
		execFileSync("git", ["init", "--quiet", fixture.projectPath]);
		const repositoryRoot = execFileSync(
			"git",
			["-C", fixture.projectPath, "rev-parse", "--show-toplevel"],
			{ encoding: "utf8" },
		).trim();
		const configDir = join(fixture.home, ".rudel");
		await writeFile(
			join(configDir, "credentials.json"),
			JSON.stringify({
				authType: "api-key",
				token: "test",
				apiBaseUrl: "https://example.invalid",
				user: { id: "user", email: "test@example.invalid", name: "Test" },
			}),
		);
		await writeFile(
			join(configDir, "projects.json"),
			JSON.stringify({
				projects: { [repositoryRoot]: { organizationId: "org" } },
			}),
		);
		const pendingDirectory = join(
			configDir,
			"repository-evidence-pending",
			"v4",
		);
		await mkdir(pendingDirectory, { recursive: true });
		await Promise.all(
			Array.from({ length: 200 }, (_, index) =>
				writeFile(join(pendingDirectory, `${index}.json`), "{}"),
			),
		);
		const result = await runCli(["hooks", "claude", "session-start"], fixture, {
			stdin: JSON.stringify({
				cwd: fixture.projectPath,
				session_id: fixture.sessionId,
				transcript_path: fixture.transcriptPath,
			}),
		});
		expect(result.exitCode).toBe(0);
		expect(
			await readFile(join(configDir, "logs", "hook-upload.log"), "utf8"),
		).toContain("quota exceeded");
		expect(
			await readdir(join(configDir, "repository-evidence-sources")),
		).toEqual([]);
		const spool = join(configDir, "repo-context-spool", "v2");
		const bindings = (await readdir(spool, { withFileTypes: true })).filter(
			(entry) => entry.isDirectory(),
		);
		expect(bindings).toHaveLength(1);
		const captures = await readdir(
			join(spool, bindings[0]?.name ?? "", "captures"),
		);
		expect(
			captures.filter((name) => name.endsWith(".abandoned.json")),
		).toHaveLength(1);
		expect(await readdir(pendingDirectory)).toHaveLength(200);
	} finally {
		await rm(fixture.home, { force: true, recursive: true });
	}
});

test("a hook that spent its budget spools the capture for background delivery instead of losing it", async () => {
	const home = await realpath(
		await mkdtemp(join(tmpdir(), "opaline-evidence-budget-")),
	);
	const previousConfigDir = process.env.OPALINE_CONFIG_DIR;
	const previousInsecure = process.env.OPALINE_ALLOW_INSECURE_ENDPOINT;
	const stub = startEvidenceProtocolStub();
	try {
		const repository = join(home, "repository");
		await mkdir(repository, { recursive: true });
		await writeFile(join(repository, "AGENTS.md"), "Instructions\n");
		execFileSync("git", ["init", "--quiet", repository]);
		const configDir = join(home, "config");
		process.env.OPALINE_CONFIG_DIR = configDir;
		process.env.OPALINE_ALLOW_INSECURE_ENDPOINT = "1";
		const credentials = {
			authType: "api-key" as const,
			token: "test",
			apiBaseUrl: stub.base,
			user: { id: "user", email: "test@example.invalid", name: "Test" },
		};
		const capture = captureAndUploadSessionEvidence({
			backgroundDelivery: "none",
			credentials,
			// The hook received its input two minutes ago: no inline delivery.
			hookReceivedAt: new Date(Date.now() - 120_000).toISOString(),
			lifecycle: "checkpoint",
			organizationId: "org",
			request: {
				content: '{"type":"session_meta","payload":{"id":"budget"}}\n',
				projectPath: repository,
				sessionId: "budget-session",
				source: "codex",
				upload_mode: "hook",
			},
			terminalTranscript: false,
		});
		await expect(capture).rejects.toBeInstanceOf(EvidenceBudgetError);
		expect(stub.counts.init).toBe(0);
		const [pending] = await readPendingRepositoryEvidence(configDir);
		assert(pending);
		expect(pending.next_attempt_at).toBeUndefined();
		expect(await retryPendingSessionEvidence(credentials)).toBe(1);
		expect(stub.committed.size).toBe(1);
		expect(await readPendingRepositoryEvidence(configDir)).toEqual([]);
	} finally {
		stub.stop();
		if (previousConfigDir === undefined) delete process.env.OPALINE_CONFIG_DIR;
		else process.env.OPALINE_CONFIG_DIR = previousConfigDir;
		if (previousInsecure === undefined)
			delete process.env.OPALINE_ALLOW_INSECURE_ENDPOINT;
		else process.env.OPALINE_ALLOW_INSECURE_ENDPOINT = previousInsecure;
		await rm(home, { force: true, recursive: true });
	}
});

test("carries a Claude session's task outputs, and a capture that must continue a delivered transcript sends none of it again", async () => {
	const home = await realpath(
		await mkdtemp(join(tmpdir(), "opaline-evidence-tasks-")),
	);
	const saved = {
		config: process.env.OPALINE_CONFIG_DIR,
		insecure: process.env.OPALINE_ALLOW_INSECURE_ENDPOINT,
		temporary: process.env.CLAUDE_CODE_TMPDIR,
	};
	const stub = startEvidenceProtocolStub();
	try {
		const repository = join(home, "repository");
		await mkdir(repository, { recursive: true });
		await writeFile(join(repository, "AGENTS.md"), "Instructions\n");
		execFileSync("git", ["init", "--quiet", repository]);
		process.env.OPALINE_CONFIG_DIR = join(home, "config");
		process.env.OPALINE_ALLOW_INSECURE_ENDPOINT = "1";
		process.env.CLAUDE_CODE_TMPDIR = join(home, "tmp");
		const uid = process.getuid?.() ?? 0;
		const sessionId = "task-session";
		const tasks = join(
			home,
			"tmp",
			`claude-${uid}`,
			"-repo",
			sessionId,
			"tasks",
		);
		await mkdir(tasks, { recursive: true });
		await writeFile(join(tasks, "bg0000001.output"), "Server ready\n");
		await symlink(join(home, "agent.jsonl"), join(tasks, "ag0000001.output"));
		const transcriptPath = join(
			home,
			"projects",
			"-repo",
			`${sessionId}.jsonl`,
		);
		await mkdir(join(home, "projects", "-repo"), { recursive: true });
		await writeFile(
			transcriptPath,
			`${[
				{
					type: "user",
					timestamp: "2026-10-01T10:00:00.000Z",
					message: { role: "user", content: "Start the server" },
				},
				{
					type: "user",
					timestamp: "2026-10-01T10:00:01.000Z",
					message: {
						role: "user",
						content: [
							{
								tool_use_id: "toolu_server",
								type: "tool_result",
								content: `Command running in background with ID: bg0000001. Output is being written to: ${tasks}/bg0000001.output`,
							},
						],
					},
				},
				{
					type: "user",
					timestamp: "2026-10-01T10:00:02.000Z",
					message: {
						role: "user",
						content: `<task-notification>\n<task-id>gone00001</task-id>\n<output-file>${tasks}/gone00001.output</output-file>\n<status>failed</status>\n</task-notification>`,
					},
				},
			]
				.map((record) => JSON.stringify(record))
				.join("\n")}\n`,
		);
		const credentials = {
			authType: "api-key" as const,
			token: "test",
			apiBaseUrl: stub.base,
			user: { id: "user", email: "test@example.invalid", name: "Test" },
		};
		const capture = (requireDeliveredTranscript: boolean) =>
			captureAndUploadSessionEvidence({
				backgroundDelivery: "none",
				credentials,
				hookReceivedAt: new Date().toISOString(),
				lifecycle: requireDeliveredTranscript ? "checkpoint" : "end",
				...(requireDeliveredTranscript
					? { captureReason: "task-output-sweep" as const }
					: {}),
				organizationId: "org",
				request: {
					kind: "file",
					metadata: {
						projectPath: repository,
						sessionId,
						source: "claude_code",
					},
					subagentDiscovery: {
						omittedCount: 0,
						reason: null,
						status: "complete",
					},
					subagents: [],
					transcriptPath,
				},
				requireDeliveredTranscript,
				terminalTranscript: true,
			});
		// Nothing was delivered yet: the capture is discarded, not spooled.
		await expect(capture(true)).rejects.toBeInstanceOf(
			TranscriptNotDeliveredError,
		);
		expect(stub.counts.init).toBe(0);
		expect(await readPendingRepositoryEvidence(join(home, "config"))).toEqual(
			[],
		);
		const first = await capture(false);
		assert(first);
		const delivered = stub.committed.get(first.contextId);
		assert(delivered);
		const localContext = delivered.manifest.localContext;
		// A capture at the session's own time carries no reason.
		expect(localContext.captureReason).toBeUndefined();
		expect(localContext.taskOutputReferences).toEqual({
			references: [
				{
					agentId: null,
					recordIndex: 2,
					taskId: "bg0000001",
					path: "bg0000001.output",
					toolUseId: "toolu_server",
					source: "result",
				},
				{
					agentId: null,
					recordIndex: 3,
					taskId: "gone00001",
					path: "gone00001.output",
					toolUseId: null,
					source: "notification",
				},
			],
			omitted: 0,
			missingTaskIds: ["gone00001"],
			missingTaskIdsOmitted: 0,
		});
		const output = localContext.entries.find(
			(entry) =>
				entry.rootId === "claude-task-outputs" &&
				entry.path === "bg0000001.output",
		);
		assert(output?.content?.blobId);
		expect(
			new TextDecoder().decode(delivered.objects.get(output.content.blobId)),
		).toBe("Server ready\n");
		// An async agent's output is a symlink to its transcript: never read.
		expect(
			localContext.entries.some(
				(entry) =>
					entry.rootId === "claude-task-outputs" &&
					entry.path === "ag0000001.output" &&
					entry.kind !== "symlink",
			),
		).toBe(false);
		const second = await capture(true);
		assert(second);
		const continued = stub.committed.get(second.contextId);
		assert(continued);
		expect(
			continued.input.objects.filter(
				(object) => object.kind === "transcript-chunk",
			),
		).toEqual([]);
		expect(continued.input.capture.timing.lifecycle).toBe("checkpoint");
		expect(continued.manifest.localContext.captureReason).toBe(
			"task-output-sweep",
		);
	} finally {
		stub.stop();
		for (const [key, value] of [
			["OPALINE_CONFIG_DIR", saved.config],
			["OPALINE_ALLOW_INSECURE_ENDPOINT", saved.insecure],
			["CLAUDE_CODE_TMPDIR", saved.temporary],
		] as const)
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		await rm(home, { force: true, recursive: true });
	}
}, 30_000);
