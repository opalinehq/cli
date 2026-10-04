import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	mkdir,
	mkdtemp,
	open,
	readdir,
	readFile,
	realpath,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { readRepositoryEvidencePauseUntil } from "../lib/repository-evidence-pause.js";
import { readPendingRepositoryEvidence } from "../lib/repository-evidence-pending.js";
import { codexThreadId, writeCodexRollout } from "./helpers/codex-rollouts.js";
import {
	type CommittedEvidence,
	type EvidenceProtocolStub,
	type EvidenceStubFault,
	startEvidenceProtocolStub,
} from "./helpers/evidence-protocol-stub.js";
import { codexRolloutPath, runCli } from "./helpers/ingest-stub.js";

/**
 * Fault injection for repository-evidence (sidecar) delivery, end to end:
 * real CLI hook processes capture real Git repositories and deliver to a
 * protocol-faithful loopback server. Every scenario checks the invariant that
 * a capture is either delivered complete or still spooled with a retry, and
 * never silently dropped.
 *
 * Runs in its own process (`bun run test:sidecar-faults`, part of `bun run
 * test`): its large transcripts would otherwise skew suites that measure the
 * test process's ArrayBuffer memory.
 */

setDefaultTimeout(120_000);

const MONOREPO_ROOT = resolve(import.meta.dir, "..", "..", "..", "..");
const SOURCE_CLI_PATH = resolve(import.meta.dir, "..", "bin", "cli.ts");
const workspaces: string[] = [];

afterAll(async () => {
	await Promise.all(
		workspaces.map((directory) =>
			rm(directory, { force: true, recursive: true }),
		),
	);
});

const REPOSITORY_FILES = (name: string): Readonly<Record<string, string>> => ({
	"AGENTS.md": `# ${name} agents\nRun the tests before committing.\n${"Repository rule.\n".repeat(2_000)}`,
	"CLAUDE.md": `# ${name}\nSee @docs/conventions.md for conventions.\n`,
	"docs/conventions.md": `Conventions for ${name}.\n`,
	"packages/app/AGENTS.md": `Package rules for ${name}.\n`,
	"packages/app/package.json": `{"name":"${name}-app"}\n`,
	"package.json": `{"name":"${name}"}\n`,
	"src/index.ts": "export const value = 1;\n",
});

const INSTRUCTION_PATHS = [
	"AGENTS.md",
	"CLAUDE.md",
	"docs/conventions.md",
	"packages/app/AGENTS.md",
];

interface Workspace {
	readonly home: string;
	readonly configDir: string;
	readonly repositories: ReadonlyMap<string, string>;
	readonly clockPreload: string;
}

type HookKind = "claude-start" | "claude-end" | "codex";

describe("sidecar delivery under faults", () => {
	test("a slow network that exceeds the hook budget hands the spooled capture to the background deliverer", async () => {
		let slow = true;
		const stub = startEvidenceProtocolStub({
			put: () => (slow ? { delayMs: 20_000 } : undefined),
		});
		try {
			const workspace = await createWorkspace(stub, ["alpha"]);
			const startedAt = performance.now();
			const result = await runHook(workspace, "codex", "alpha", "slow-session");
			expect(result.exitCode).toBe(0);
			// The hook returns once its own delivery budget is spent.
			expect(performance.now() - startedAt).toBeLessThan(60_000);
			expect(await readHookLog(workspace)).toContain(
				"delivered in the background",
			);
			expect(stub.committed.size).toBe(0);
			const [pending] = await readPendingRepositoryEvidence(
				workspace.configDir,
			);
			assert(pending);
			// A budget cut is not a server failure: no backoff, delivery stays due.
			expect(pending.next_attempt_at).toBeUndefined();
			slow = false;
			await waitFor(
				async () =>
					stub.committed.size === 1 && (await countPending(workspace)) === 0,
				60_000,
			);
			expectCompleteCapture(only(stub), workspace, "alpha");
			await expectNothingDropped(workspace, stub);
		} finally {
			slow = false;
			stub.stop();
		}
	}, 150_000);

	test("transient 503s on object PUTs are retried inside the hook", async () => {
		const stub = startEvidenceProtocolStub({
			put: (index) => (index < 2 ? { status: 503 } : undefined),
		});
		try {
			const workspace = await createWorkspace(stub, ["alpha"]);
			expect(
				(await runHook(workspace, "claude-end", "alpha", "put-503")).exitCode,
			).toBe(0);
			expect(stub.committed.size).toBe(1);
			expectCompleteCapture(only(stub), workspace, "alpha");
			expect(await readPendingRepositoryEvidence(workspace.configDir)).toEqual(
				[],
			);
			await expectNothingDropped(workspace, stub);
		} finally {
			stub.stop();
		}
	});

	test.each<[string, Parameters<typeof startEvidenceProtocolStub>[0]]>([
		["a 500 on an object PUT", { put: (index) => failFirst(index, 1, 500) }],
		[
			"503s on every init attempt",
			{ init: (index) => failFirst(index, 3, 503) },
		],
		["a 500 on commit", { commit: (index) => failFirst(index, 1, 500) }],
	])(
		"%s keeps the capture spooled with backoff until it is delivered",
		async (_name, faults) => {
			const stub = startEvidenceProtocolStub(faults);
			try {
				const workspace = await createWorkspace(stub, ["alpha"]);
				const now = Date.now();
				expect(
					(
						await runHook(workspace, "codex", "alpha", "server-failure", {
							now,
						})
					).exitCode,
				).toBe(0);
				expect(stub.committed.size).toBe(0);
				const [pending] = await readPendingRepositoryEvidence(
					workspace.configDir,
				);
				assert(pending);
				expect(pending.retry_attempts).toBe(1);
				expect(pending.next_attempt_at).toBe(now + 5 * 60_000);
				// Not due yet: the background deliverer leaves it alone.
				expect((await runDeliverer(workspace, now + 60_000)).exitCode).toBe(0);
				expect(stub.committed.size).toBe(0);
				expect((await runDeliverer(workspace, now + 5 * 60_000)).exitCode).toBe(
					0,
				);
				expect(stub.committed.size).toBe(1);
				expect(stub.counts.conflicts).toBe(0);
				expectCompleteCapture(only(stub), workspace, "alpha");
				expect(
					await readPendingRepositoryEvidence(workspace.configDir),
				).toEqual([]);
				await expectNothingDropped(workspace, stub);
			} finally {
				stub.stop();
			}
		},
		150_000,
	);

	test("a commit that times out is re-planned and committed once inside the hook", async () => {
		const stub = startEvidenceProtocolStub({
			commit: (index) => (index === 0 ? { delayMs: 20_000 } : undefined),
		});
		try {
			const workspace = await createWorkspace(stub, ["alpha"]);
			expect(
				(await runHook(workspace, "codex", "alpha", "commit-timeout")).exitCode,
			).toBe(0);
			expect(stub.counts.commit).toBe(2);
			const capture = only(stub);
			expectCompleteCapture(capture, workspace, "alpha");
			expect(await readPendingRepositoryEvidence(workspace.configDir)).toEqual(
				[],
			);
			await expectNothingDropped(workspace, stub);
		} finally {
			stub.stop();
		}
	}, 60_000);

	test("a hook killed mid-delivery leaves a spooled capture that is resumed", async () => {
		let releaseHang = () => undefined;
		const hang = new Promise<void>((resolve) => {
			releaseHang = resolve;
		});
		let hanging = true;
		const stub = startEvidenceProtocolStub({
			put: () => (hanging ? { hang } : undefined),
		});
		try {
			const workspace = await createWorkspace(stub, ["alpha"]);
			const invocation = buildHook(workspace, "codex", "alpha", "killed");
			await writeTranscript(workspace, "codex", "alpha", "killed");
			const child = Bun.spawn(["bun", SOURCE_CLI_PATH, ...invocation.args], {
				cwd: MONOREPO_ROOT,
				env: cliEnvironment(workspace),
				stdin: "ignore",
				stdout: "ignore",
				stderr: "ignore",
			});
			await waitFor(async () => stub.counts.put > 0, 30_000);
			child.kill("SIGKILL");
			await child.exited;
			hanging = false;
			releaseHang();
			const [pending] = await readPendingRepositoryEvidence(
				workspace.configDir,
			);
			assert(pending);
			expect(pending.next_attempt_at).toBeUndefined();
			// The dead process's delivery lease is recovered immediately.
			expect((await runDeliverer(workspace)).exitCode).toBe(0);
			expect(stub.committed.size).toBe(1);
			expectCompleteCapture(only(stub), workspace, "alpha");
			expect(await readPendingRepositoryEvidence(workspace.configDir)).toEqual(
				[],
			);
			expect(
				await readdir(join(workspace.configDir, "repository-evidence-leases")),
			).toEqual([]);
			await expectNothingDropped(workspace, stub);
		} finally {
			hanging = false;
			releaseHang();
			stub.stop();
		}
	});

	test("eight concurrent hooks across three repositories all end delivered and complete", async () => {
		const stub = startEvidenceProtocolStub({
			put: () => ({ delayMs: 25 }),
		});
		try {
			const workspace = await createWorkspace(stub, ["alpha", "beta", "gamma"]);
			const hooks: readonly [HookKind, string, string][] = [
				["claude-start", "alpha", "alpha-claude"],
				["claude-end", "alpha", "alpha-claude"],
				["codex", "alpha", "alpha-codex"],
				["codex", "beta", "beta-codex"],
				["codex", "beta", "beta-codex"],
				["claude-end", "beta", "beta-claude"],
				["claude-end", "gamma", "gamma-claude"],
				["codex", "gamma", "gamma-codex"],
			];
			for (const [kind, repository, session] of hooks)
				await writeTranscript(workspace, kind, repository, session);
			const results = await Promise.all(
				hooks.map(([kind, repository, session]) =>
					runHook(workspace, kind, repository, session, {
						transcriptWritten: true,
					}),
				),
			);
			expect(results.map((result) => result.exitCode)).toEqual(
				hooks.map(() => 0),
			);
			await waitFor(async () => (await countPending(workspace)) === 0, 60_000);
			const log = await readHookLog(workspace);
			expect(log).not.toContain("Timed out waiting");
			expect(log).not.toContain("was resumed");
			expect(stub.counts.conflicts).toBe(0);
			// Seven sessions; the concurrent checkpoints of beta-codex may be
			// superseded by one another but at least one of them is delivered.
			const sessions = new Set(
				[...stub.committed.values()].map(
					(capture) => capture.input.session.sessionId,
				),
			);
			expect([...sessions].sort()).toEqual(
				[...new Set(hooks.map(([, , session]) => session))].sort(),
			);
			for (const capture of stub.committed.values()) {
				const repository = getRepositoryName(workspace, capture);
				expectCompleteCapture(capture, workspace, repository);
			}
			await expectNothingDropped(workspace, stub);
		} finally {
			stub.stop();
		}
	}, 150_000);

	test("an older pending checkpoint never blocks a newer one and is superseded by it", async () => {
		let failing = true;
		const stub = startEvidenceProtocolStub({
			init: () => (failing ? { status: 400 } : undefined),
		});
		try {
			const workspace = await createWorkspace(stub, ["alpha"]);
			expect(
				(await runHook(workspace, "claude-start", "alpha", "turns")).exitCode,
			).toBe(0);
			for (let turn = 0; turn < 3; turn += 1)
				expect(
					(await runHook(workspace, "codex", "alpha", "turns")).exitCode,
				).toBe(0);
			// Every hook captured and attempted its own capture.
			expect(stub.counts.init).toBe(4);
			const pending = await readPendingRepositoryEvidence(workspace.configDir);
			expect(
				pending
					.map((item) => item.upload.input.capture.timing.lifecycle)
					.sort(),
			).toEqual(["checkpoint", "start"]);
			failing = false;
			expect(
				(await runDeliverer(workspace, Date.now() + 5 * 60_000)).exitCode,
			).toBe(0);
			expect(stub.committed.size).toBe(2);
			await expectNothingDropped(workspace, stub);
		} finally {
			stub.stop();
		}
	});

	test("a server-side capture pause discards the capture, keeps the transcript upload and stops background delivery", async () => {
		let disabled = true;
		const stub = startEvidenceProtocolStub({ disabled: () => disabled });
		try {
			const workspace = await createWorkspace(stub, ["alpha"]);
			expect(
				(await runHook(workspace, "claude-end", "alpha", "paused")).exitCode,
			).toBe(0);
			expect(stub.transcriptUploads).toHaveLength(1);
			expect(stub.committed.size).toBe(0);
			expect(await readPendingRepositoryEvidence(workspace.configDir)).toEqual(
				[],
			);
			expect(
				readRepositoryEvidencePauseUntil(workspace.configDir),
			).toBeGreaterThan(Date.now());
			disabled = false;
			const initsBefore = stub.counts.init;
			expect(
				(await runHook(workspace, "codex", "alpha", "paused-later")).exitCode,
			).toBe(0);
			expect((await runDeliverer(workspace)).exitCode).toBe(0);
			expect(stub.counts.init).toBe(initsBefore);
			expect(stub.transcriptUploads).toHaveLength(2);
		} finally {
			stub.stop();
		}
	});

	test("carries user and plugin context and secret-free agent configuration end to end", async () => {
		const stub = startEvidenceProtocolStub();
		try {
			const workspace = await createWorkspace(stub, ["alpha"]);
			const secret = "sk-live-0123456789abcdefghijklmn";
			const userFiles: Record<string, string> = {
				".claude/CLAUDE.md":
					"# User\nAlways run the linters. See @~/notes/style.md\n",
				"notes/style.md": "House style\n",
				".claude/settings.json": JSON.stringify({
					env: { SERVICE_TOKEN: secret },
					hooks: {
						SessionEnd: [
							{ hooks: [{ type: "command", command: "opaline hooks" }] },
						],
					},
				}),
				".codex/AGENTS.md": "Codex user instructions\n",
				".codex/config.toml": [
					"[mcp_servers.remote]",
					'url = "https://mcp.example"',
					`http_headers = { Authorization = "Bearer ${secret}" }`,
					"",
				].join("\n"),
				"repositories/CLAUDE.md": "Instructions for every repository here\n",
			};
			for (const [path, content] of Object.entries(userFiles)) {
				await mkdir(dirname(join(workspace.home, path)), { recursive: true });
				await writeFile(join(workspace.home, path), content);
			}
			expect(
				(await runHook(workspace, "codex", "alpha", "user-context")).exitCode,
			).toBe(0);
			const capture = only(stub);
			expectCompleteCapture(capture, workspace, "alpha");
			const userFile = (rootId: string, path: string) => {
				const entry = capture.manifest.localContext.entries.find(
					(candidate) => candidate.rootId === rootId && candidate.path === path,
				);
				assert(entry?.content?.blobId, `${rootId}:${path} was not captured`);
				const bytes = capture.objects.get(entry.content.blobId);
				assert(bytes);
				return new TextDecoder().decode(bytes);
			};
			expect(userFile("claude-user-home", "CLAUDE.md")).toBe(
				userFiles[".claude/CLAUDE.md"],
			);
			expect(userFile("home-instructions", "notes/style.md")).toBe(
				"House style\n",
			);
			expect(userFile("home-instructions", "repositories/CLAUDE.md")).toBe(
				userFiles["repositories/CLAUDE.md"],
			);
			expect(userFile("codex-user-home", "AGENTS.md")).toBe(
				"Codex user instructions\n",
			);
			const manifest = JSON.stringify(capture.manifest);
			expect(manifest).toContain('"userConfiguration"');
			expect(manifest).toContain("https://mcp.example");
			for (const bytes of capture.objects.values())
				expect(new TextDecoder().decode(bytes)).not.toContain(secret);
			await expectNothingDropped(workspace, stub);
		} finally {
			stub.stop();
		}
	});

	test("carries the session's saved tool outputs, linked to their records", async () => {
		const stub = startEvidenceProtocolStub();
		try {
			const workspace = await createWorkspace(stub, ["alpha"]);
			const alpha = workspace.repositories.get("alpha");
			assert(alpha);
			const sessionId = "tool-results";
			const transcriptPath = claudeTranscriptPath(workspace, sessionId);
			const toolResults = join(
				dirname(transcriptPath),
				sessionId,
				"tool-results",
			);
			const secret = `ghp_${"C".repeat(36)}`;
			const pixels = Buffer.from(
				Array.from({ length: 3_000 }, (_, index) => (index * 7 + 3) % 256),
			).toString("base64");
			const outputs = {
				"bash-1.txt": `${"build log line\n".repeat(400)}token=${secret}\n`,
				"mcp-2.txt": `${JSON.stringify({ type: "image", data: `data:image/png;base64,${pixels}` })}\n`,
				"unreferenced.txt": "Never referenced\n",
			};
			await mkdir(toolResults, { recursive: true });
			for (const [name, content] of Object.entries(outputs))
				await writeFile(join(toolResults, name), content);
			const persisted = (toolUseId: string, name: string) => ({
				type: "user",
				sessionId,
				cwd: alpha,
				version: "2.1.286",
				entrypoint: "cli",
				timestamp: "2026-10-04T10:00:03.000Z",
				message: {
					role: "user",
					content: [
						{
							tool_use_id: toolUseId,
							type: "tool_result",
							content: `<persisted-output>\nOutput too large. Full output saved to: ${join(toolResults, name)}\n</persisted-output>`,
						},
					],
				},
				toolUseResult: { persistedOutputPath: join(toolResults, name) },
			});
			await mkdir(dirname(transcriptPath), { recursive: true });
			await writeFile(
				transcriptPath,
				`${[
					{
						type: "user",
						sessionId,
						cwd: alpha,
						version: "2.1.286",
						entrypoint: "cli",
						timestamp: "2026-10-04T10:00:01.000Z",
						message: { role: "user", content: "Build it" },
					},
					persisted("toolu_bash", "bash-1.txt"),
					persisted("toolu_mcp", "mcp-2.txt"),
				]
					.map((line) => JSON.stringify(line))
					.join("\n")}\n`,
			);
			expect(
				(
					await runHook(workspace, "claude-end", "alpha", sessionId, {
						transcriptWritten: true,
					})
				).exitCode,
			).toBe(0);
			const capture = only(stub);
			expectCompleteCapture(capture, workspace, "alpha");
			const localContext = capture.manifest.localContext;
			expect(localContext.toolResultReferences).toEqual({
				references: [
					{
						path: "bash-1.txt",
						agentId: null,
						recordIndex: 2,
						toolUseId: "toolu_bash",
					},
					{
						path: "mcp-2.txt",
						agentId: null,
						recordIndex: 3,
						toolUseId: "toolu_mcp",
					},
				],
				omitted: 0,
			});
			const stored = (path: string) => {
				const entry = localContext.entries.find(
					(candidate) =>
						candidate.rootId === "claude-tool-results" &&
						candidate.path === path,
				);
				assert(entry?.content?.blobId, `${path} was not captured`);
				const bytes = capture.objects.get(entry.content.blobId);
				assert(bytes);
				return new TextDecoder().decode(bytes);
			};
			// Secret-filtered, and slimmed like the transcript.
			const log = stored("bash-1.txt");
			expect(log).toContain("build log line");
			expect(log).not.toContain(secret);
			const image = stored("mcp-2.txt");
			expect(image).toContain("opaline-image-omitted:v1;sha256=");
			expect(image).not.toContain(pixels);
			expect(stored("unreferenced.txt")).toBe("Never referenced\n");
			await expectNothingDropped(workspace, stub);
		} finally {
			stub.stop();
		}
	});

	test("a 40 MiB transcript (over the old 32 MiB budget) is captured and delivered whole", async () => {
		const stub = startEvidenceProtocolStub();
		try {
			const workspace = await createWorkspace(stub, ["alpha"]);
			const path = await writeTranscript(
				workspace,
				"codex",
				"alpha",
				"large",
				40 * 1024 * 1024,
			);
			// The transcript upload itself may take another path for a file this
			// size; only the evidence delivery is asserted here.
			await runHook(workspace, "codex", "alpha", "large", {
				transcriptWritten: true,
			});
			await waitFor(async () => (await countPending(workspace)) === 0, 60_000);
			const capture = only(stub);
			expectCompleteCapture(capture, workspace, "alpha");
			expect(capture.manifest.transcriptRevision.watermark.byteOffset).toBe(
				(await stat(path)).size,
			);
			await expectNothingDropped(workspace, stub);
		} finally {
			stub.stop();
		}
	}, 150_000);

	test("chats linked to an analysis capture no repository evidence while marked, in or outside Git", async () => {
		const stub = startEvidenceProtocolStub();
		try {
			const workspace = await createWorkspace(stub, ["alpha"]);
			const alpha = workspace.repositories.get("alpha");
			assert(alpha);
			// A Codex desktop chat folder: not a Git repository, but bound to the
			// same workspace so only the analysis marker can keep it out.
			const desktopChat = join(workspace.home, "Documents", "Codex", "chat");
			await mkdir(desktopChat, { recursive: true });
			await writeFile(
				join(workspace.configDir, "projects.json"),
				JSON.stringify({
					projects: {
						[alpha]: { organizationId: "org" },
						[desktopChat]: { organizationId: "org" },
					},
				}),
			);
			const codexHome = join(workspace.home, ".codex");
			const started = Date.now() - 60 * 60 * 1_000;
			const desktopThread = codexThreadId(started);
			const repositoryThread = codexThreadId(started + 10_000);
			await writeCodexRollout(codexHome, {
				cwd: desktopChat,
				threadId: desktopThread,
				userText: "Which repositories had the most failed sessions?",
			});
			await writeCodexRollout(codexHome, {
				cwd: alpha,
				threadId: repositoryThread,
				userText: "Summarize the failing sessions in this repository.",
			});
			const claudeSession = "5b0c9a52-2d0e-4b8f-9a51-6f2f3c1d7e10";
			const claudeTranscript = join(
				workspace.home,
				".claude",
				"projects",
				"-repositories-alpha",
				`${claudeSession}.jsonl`,
			);
			await mkdir(dirname(claudeTranscript), { recursive: true });
			await writeFile(
				claudeTranscript,
				`${JSON.stringify({
					cwd: alpha,
					message: { content: "How many sessions failed?", role: "user" },
					sessionId: claudeSession,
					timestamp: "2026-10-04T10:00:00.000Z",
					type: "user",
				})}\n`,
			);
			for (const session of [desktopThread, repositoryThread, claudeSession]) {
				const imported = await runCli(
					["import", session, "--analysis", "analysis-1", "--no-related"],
					fixtureFor(workspace),
					{ env: cliEnvironmentOverrides(undefined) },
				);
				expect(imported.exitCode).toBe(0);
			}
			const hooks: Array<{ args: string[]; stdin: string }> = [
				...[
					[desktopThread, desktopChat],
					[repositoryThread, alpha],
				].map(([threadId, cwd]) => ({
					args: [
						"hooks",
						"codex",
						"turn-complete",
						JSON.stringify({
							type: "agent-turn-complete",
							"thread-id": threadId,
							"turn-id": "turn",
							cwd,
							"input-messages": ["test"],
							"last-assistant-message": "done",
						}),
					],
					stdin: "",
				})),
				...(["session-start", "session-end"] as const).map((hook) => ({
					args: ["hooks", "claude", hook],
					stdin: JSON.stringify({
						cwd: alpha,
						session_id: claudeSession,
						transcript_path: claudeTranscript,
						hook_event_name:
							hook === "session-start" ? "SessionStart" : "SessionEnd",
						reason: "other",
					}),
				})),
			];
			for (const hook of hooks) {
				const result = await runCli(hook.args, fixtureFor(workspace), {
					stdin: hook.stdin,
					env: cliEnvironmentOverrides(undefined),
				});
				expect(result.exitCode).toBe(0);
			}

			expect(stub.counts.init).toBe(0);
			expect(await countPending(workspace)).toBe(0);
			expect(await countSpooledCaptures(workspace)).toBe(0);
			// Imports plus the hooks' linked re-uploads of the changed transcript
			// all carried the analysis link; nothing went up unlinked.
			const uploads = stub.transcriptUploads.map(
				(body) => JSON.parse(body).json,
			);
			expect(uploads.length).toBeGreaterThanOrEqual(3);
			expect(
				uploads.filter((upload) => upload.analysisId !== "analysis-1"),
			).toEqual([]);

			// Control: the same repository and binding capture an unmarked chat.
			await runHook(workspace, "claude-end", "alpha", "unmarked");
			await waitFor(async () => (await countPending(workspace)) === 0, 60_000);
			expect(stub.committed.size).toBe(1);
		} finally {
			stub.stop();
		}
	});
});

async function countSpooledCaptures(workspace: Workspace): Promise<number> {
	const spoolRoot = join(workspace.configDir, "repo-context-spool", "v2");
	let count = 0;
	for (const binding of await readdir(spoolRoot).catch(() => [] as string[])) {
		const captures = await readdir(join(spoolRoot, binding, "captures")).catch(
			() => [] as string[],
		);
		count += captures.filter((name) => name.endsWith(".capture.json")).length;
	}
	return count;
}

function failFirst(
	index: number,
	count: number,
	status: number,
): EvidenceStubFault {
	return index < count ? { status } : undefined;
}

async function createWorkspace(
	stub: EvidenceProtocolStub,
	names: readonly string[],
): Promise<Workspace> {
	const home = await realpath(
		await mkdtemp(join(tmpdir(), "opaline-sidecar-faults-")),
	);
	workspaces.push(home);
	const configDir = join(home, ".rudel");
	await mkdir(configDir, { recursive: true });
	const repositories = new Map<string, string>();
	const projects: Record<string, { organizationId: string }> = {};
	for (const name of names) {
		const root = join(home, "repositories", name);
		for (const [path, content] of Object.entries(REPOSITORY_FILES(name))) {
			await mkdir(dirname(join(root, path)), { recursive: true });
			await writeFile(join(root, path), content);
		}
		for (const args of [
			["init", "-q"],
			["add", "."],
			[
				"-c",
				"user.name=Fixture",
				"-c",
				"user.email=fixture@example.com",
				"commit",
				"-qm",
				"Fixture",
			],
		])
			execFileSync("git", args, { cwd: root });
		await writeFile(join(root, "src/index.ts"), "export const value = 2;\n");
		repositories.set(name, root);
		projects[root] = { organizationId: "org" };
	}
	await writeFile(
		join(configDir, "credentials.json"),
		JSON.stringify({
			apiBaseUrl: stub.base,
			authType: "api-key",
			token: "test",
			user: { id: "user-1", email: "test@example.invalid", name: "Test" },
		}),
	);
	await writeFile(
		join(configDir, "projects.json"),
		JSON.stringify({ projects }),
	);
	const clockPreload = join(home, "clock.ts");
	await writeFile(
		clockPreload,
		"if (process.env.OPALINE_TEST_NOW) Date.now = () => Number(process.env.OPALINE_TEST_NOW);\n",
	);
	return { home, configDir, repositories, clockPreload };
}

function buildHook(
	workspace: Workspace,
	kind: HookKind,
	repository: string,
	sessionId: string,
): { readonly args: readonly string[]; readonly stdin: string } {
	const cwd = workspace.repositories.get(repository);
	assert(cwd);
	if (kind === "codex")
		return {
			args: [
				"hooks",
				"codex",
				"turn-complete",
				JSON.stringify({
					type: "agent-turn-complete",
					"thread-id": sessionId,
					"turn-id": "turn",
					cwd,
					"input-messages": ["test"],
					"last-assistant-message": "done",
				}),
			],
			stdin: "",
		};
	return {
		args: [
			"hooks",
			"claude",
			kind === "claude-start" ? "session-start" : "session-end",
		],
		stdin: JSON.stringify({
			cwd,
			session_id: sessionId,
			transcript_path: claudeTranscriptPath(workspace, sessionId),
			hook_event_name: kind === "claude-start" ? "SessionStart" : "SessionEnd",
			reason: "other",
		}),
	};
}

async function runHook(
	workspace: Workspace,
	kind: HookKind,
	repository: string,
	sessionId: string,
	options: { readonly now?: number; readonly transcriptWritten?: boolean } = {},
) {
	if (!options.transcriptWritten)
		await writeTranscript(workspace, kind, repository, sessionId);
	const invocation = buildHook(workspace, kind, repository, sessionId);
	return runCli(invocation.args, fixtureFor(workspace), {
		stdin: invocation.stdin,
		env: cliEnvironmentOverrides(options.now),
		preload: options.now === undefined ? undefined : workspace.clockPreload,
	});
}

function runDeliverer(
	workspace: Workspace,
	now: number | undefined = undefined,
) {
	return runCli(["hooks", "evidence-deliver"], fixtureFor(workspace), {
		env: cliEnvironmentOverrides(now),
		preload: now === undefined ? undefined : workspace.clockPreload,
	});
}

function fixtureFor(workspace: Workspace) {
	return {
		home: workspace.home,
		projectPath: workspace.home,
		sessionId: "unused",
		transcriptPath: "unused",
	};
}

function cliEnvironmentOverrides(now: number | undefined) {
	return {
		OPALINE_ALLOW_INSECURE_ENDPOINT: "1",
		RUDEL_ALLOW_INSECURE_ENDPOINT: "1",
		...(now === undefined ? {} : { OPALINE_TEST_NOW: String(now) }),
	};
}

function cliEnvironment(workspace: Workspace): Record<string, string> {
	const environment: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env))
		if (value !== undefined) environment[key] = value;
	return {
		...environment,
		HOME: workspace.home,
		USERPROFILE: workspace.home,
		OPALINE_CONFIG_DIR: workspace.configDir,
		RUDEL_CONFIG_DIR: workspace.configDir,
		POSTHOG_ENABLED: "false",
		...cliEnvironmentOverrides(undefined),
	};
}

function claudeTranscriptPath(workspace: Workspace, sessionId: string): string {
	return join(workspace.home, "transcripts", `${sessionId}.jsonl`);
}

async function writeTranscript(
	workspace: Workspace,
	kind: HookKind,
	repository: string,
	sessionId: string,
	minimumBytes = 0,
): Promise<string> {
	const cwd = workspace.repositories.get(repository);
	assert(cwd);
	const path =
		kind === "codex"
			? codexRolloutPath(workspace.home, sessionId)
			: claudeTranscriptPath(workspace, sessionId);
	await mkdir(dirname(path), { recursive: true });
	const lines =
		kind === "codex"
			? [
					{
						type: "session_meta",
						timestamp: "2026-10-04T10:00:00.000Z",
						payload: { id: sessionId, cwd },
					},
					{
						timestamp: "2026-10-04T10:00:01.000Z",
						type: "response_item",
						payload: {
							content: [{ text: "Fix the build", type: "input_text" }],
							role: "user",
							type: "message",
						},
					},
				]
			: [
					{
						type: "user",
						sessionId,
						cwd,
						timestamp: "2026-10-04T10:00:01.000Z",
						message: { role: "user", content: "Fix the build" },
					},
				];
	const handle = await open(path, "w");
	try {
		await handle.write(
			`${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
		);
		// Large transcripts are written line by line: one huge string written
		// at once leaves ArrayBuffer memory that skews later memory-bound suites.
		const filler = Buffer.from(
			`${JSON.stringify({
				timestamp: "2026-10-04T10:00:02.000Z",
				type: "response_item",
				payload: {
					content: [{ text: "x".repeat(64 * 1024), type: "output_text" }],
					role: "assistant",
					type: "message",
				},
			})}\n`,
		);
		for (let written = 0; written < minimumBytes; written += filler.byteLength)
			await handle.write(filler);
	} finally {
		await handle.close();
	}
	return path;
}

function only(stub: EvidenceProtocolStub): CommittedEvidence {
	const [capture] = stub.committed.values();
	assert(capture);
	expect(stub.committed.size).toBe(1);
	return capture;
}

function getRepositoryName(
	workspace: Workspace,
	capture: CommittedEvidence,
): string {
	const instructions = readCommittedFile(capture, "CLAUDE.md");
	for (const name of workspace.repositories.keys())
		if (instructions.startsWith(`# ${name}\n`)) return name;
	throw new Error("Capture does not belong to a fixture repository");
}

/**
 * A delivered capture is complete: every coverage area and every facet of the
 * repository root is complete, and each instruction file (including the file
 * CLAUDE.md imports) is stored byte for byte as it is on disk.
 */
function expectCompleteCapture(
	capture: CommittedEvidence,
	workspace: Workspace,
	repository: string,
): void {
	expect(
		capture.input.coverage.filter((item) => item.status !== "complete"),
	).toEqual([]);
	expect(
		capture.manifest.contextIndex.facets.filter(
			(facet) => facet.coverage !== "complete",
		),
	).toEqual([]);
	const root = workspace.repositories.get(repository);
	assert(root);
	const files = REPOSITORY_FILES(repository);
	for (const path of INSTRUCTION_PATHS) {
		const onDisk = files[path];
		assert(onDisk !== undefined);
		expect(sha256(readCommittedFile(capture, path))).toBe(sha256(onDisk));
	}
}

function readCommittedFile(capture: CommittedEvidence, path: string): string {
	const entry = capture.manifest.localContext.entries.find(
		(candidate) => candidate.rootId === "repository" && candidate.path === path,
	);
	assert(entry?.content?.blobId, `${path} was not captured`);
	const bytes = capture.objects.get(entry.content.blobId);
	assert(bytes, `${path} blob was not delivered`);
	return new TextDecoder().decode(bytes);
}

/**
 * Every capture written to the local spool ends in exactly one of three
 * states: accepted (delivered to the server), pending (spooled with a retry)
 * or abandoned because a newer capture of the same session superseded it and
 * that newer capture is itself accepted or pending.
 */
async function expectNothingDropped(
	workspace: Workspace,
	stub: EvidenceProtocolStub,
): Promise<void> {
	const pending = await readPendingRepositoryEvidence(workspace.configDir);
	const pendingIds = new Set(
		pending.map((item) => item.upload.input.capture.contextId),
	);
	const spoolRoot = join(workspace.configDir, "repo-context-spool", "v2");
	// Grouped by repository root: with product analytics disabled (as in these
	// tests) every CLI process gets a new installation ID and spool binding.
	const records: {
		readonly repository: string;
		readonly captureId: string;
		readonly capturedAt: string;
		readonly lifecycle: string;
		readonly state: "accepted" | "abandoned" | "spooled";
	}[] = [];
	for (const binding of await readdir(spoolRoot)) {
		if (binding.startsWith(".")) continue;
		const captures = join(spoolRoot, binding, "captures");
		const names = await readdir(captures).catch(() => [] as string[]);
		for (const name of names.filter((item) => item.endsWith(".capture.json"))) {
			const record = JSON.parse(await readFile(join(captures, name), "utf8"));
			const prefix = name.slice(0, -".capture.json".length);
			records.push({
				repository: record.manifest.roots[0].absolutePath,
				captureId: record.captureId,
				capturedAt: record.capturedAt,
				lifecycle: record.captureLifecycle,
				state: names.includes(`${prefix}.accepted.json`)
					? "accepted"
					: names.includes(`${prefix}.abandoned.json`)
						? "abandoned"
						: "spooled",
			});
		}
	}
	expect(records.length).toBeGreaterThan(0);
	for (const record of records) {
		if (record.state === "accepted") {
			expect(stub.committed.has(record.captureId)).toBe(true);
		} else if (record.state === "spooled") {
			expect(pendingIds.has(record.captureId)).toBe(true);
		} else {
			// Superseded: only a checkpoint, and only by a newer capture of the
			// same repository that is delivered or still spooled.
			expect(record.lifecycle).toBe("checkpoint");
			expect(
				records.some(
					(newer) =>
						newer.repository === record.repository &&
						newer.state !== "abandoned" &&
						newer.capturedAt >= record.capturedAt &&
						(newer.lifecycle === "checkpoint" || newer.lifecycle === "end"),
				),
			).toBe(true);
		}
	}
}

/** Pending captures by file count; cheap enough to poll (no parsing). */
async function countPending(workspace: Workspace): Promise<number> {
	const names = await readdir(
		join(workspace.configDir, "repository-evidence-pending", "v4"),
	).catch(() => [] as string[]);
	return names.filter((name) => name.endsWith(".json")).length;
}

async function readHookLog(workspace: Workspace): Promise<string> {
	return readFile(
		join(workspace.configDir, "logs", "hook-upload.log"),
		"utf8",
	).catch(() => "");
}

async function waitFor(
	condition: () => Promise<boolean>,
	timeoutMs: number,
): Promise<void> {
	const deadline = performance.now() + timeoutMs;
	while (!(await condition())) {
		if (performance.now() >= deadline)
			throw new Error(`Condition not reached within ${timeoutMs}ms`);
		await Bun.sleep(100);
	}
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}
