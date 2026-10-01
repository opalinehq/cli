import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
	mkdir,
	mkdtemp,
	open,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	captureAndUploadSessionEvidence,
	EVIDENCE_TRANSCRIPT_INPUT_MAX_BYTES,
} from "../lib/session-evidence.js";
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
