import { afterAll, describe, expect, test } from "bun:test";
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import {
	mkdir,
	mkdtemp,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	collectLocalContextBundle,
	createLocalContextSourceEnv,
	getDefaultLocalContextCollectionOptions,
	type LocalContextBundle,
} from "../internal/local-context-source/index.js";
import {
	findMissingTaskOutputs,
	findTaskOutputReferences,
	MAX_TASK_OUTPUT_REFERENCES,
	resolveClaudeTaskOutputsDirectory,
} from "../lib/claude-task-outputs.js";
import { slimTranscriptText } from "../lib/transcript-slim.js";
import {
	readUserAgentSources,
	resolveUserContextRoots,
} from "../lib/user-context.js";

const SESSION = "1077056d-be5a-4927-8cce-10a029a84982";
const DIRECTORY = `/private/tmp/claude-502/-Users-me-repo/${SESSION}/tasks`;
const directories: string[] = [];

afterAll(async () => {
	await Promise.all(
		directories.map((directory) =>
			rm(directory, { force: true, recursive: true }),
		),
	);
});

async function createDirectory(): Promise<string> {
	const directory = await realpath(
		await mkdtemp(join(tmpdir(), "opaline-task-outputs-")),
	);
	directories.push(directory);
	return directory;
}

function line(record: unknown): string {
	return JSON.stringify(record);
}

function toolResult(
	toolUseId: string,
	content: string,
	toolUseResult?: unknown,
): string {
	return line({
		type: "user",
		message: {
			role: "user",
			content: [{ tool_use_id: toolUseId, type: "tool_result", content }],
		},
		...(toolUseResult === undefined ? {} : { toolUseResult }),
	});
}

function notification(body: string): string {
	return line({
		type: "user",
		message: {
			role: "user",
			content: `<task-notification>\n${body}\n</task-notification>`,
		},
	});
}

describe("Claude Code background task outputs", () => {
	test("links results, every notification shape and Read calls to their task and tool call", () => {
		const main = [
			line({ type: "user", message: { content: "Start the dev server" } }),
			toolResult(
				"toolu_dev",
				`Command running in background with ID: burijxy65. Output is being written to: ${DIRECTORY}/burijxy65.output. Use Read to check it.`,
				{ backgroundTaskId: "burijxy65" },
			),
			toolResult(
				"toolu_ci",
				"Command was moved to the background (ID: b4ntub6w0). You will be notified when it finishes.",
			),
			toolResult("toolu_watch", "Monitor started.", {
				backgroundTaskId: "mon1xq2z3",
			}),
			notification(
				`<task-id>burijxy65</task-id>\n<tool-use-id>toolu_dev</tool-use-id>\n<output-file>${DIRECTORY}/burijxy65.output</output-file>\n<status>killed</status>\n<summary>Dev server (exit code 0)</summary>`,
			),
			// A Monitor event names no tool call: it is resolved from the result
			// that started the task.
			notification(
				"<task-id>mon1xq2z3</task-id>\n<summary>Monitor event: build finished</summary>\n<event>done</event>",
			),
			// One notification for several tasks.
			notification(
				`<task-id>b4ntub6w0</task-id>\n<task-id>burijxy65</task-id>\n<output-file>${DIRECTORY}/b4ntub6w0.output</output-file>\n<status>completed</status>`,
			),
			// An output of another session's directory is not this root's.
			notification(
				"<task-id>other0001</task-id>\n<output-file>/private/tmp/claude-502/-Users-me-repo/other-session/tasks/other0001.output</output-file>",
			),
			line({
				type: "assistant",
				message: {
					role: "assistant",
					content: [
						{
							type: "tool_use",
							id: "toolu_read",
							name: "Read",
							input: { file_path: `${DIRECTORY}/burijxy65.output` },
						},
						{
							type: "tool_use",
							id: "toolu_read_other",
							name: "Read",
							input: { file_path: "/etc/hosts" },
						},
					],
				},
			}),
			`not json, but names ${DIRECTORY}/ignored1.output`,
		].join("\n");
		const child = toolResult(
			"toolu_child",
			`Command running in background with ID: kid000001. Output is being written to: ${DIRECTORY}/rerooted/kid000001.output`,
		);

		expect(
			findTaskOutputReferences(
				[
					{ agentId: null, content: main },
					{ agentId: "agent-1", content: child },
				],
				DIRECTORY,
			),
		).toEqual({
			references: [
				{
					agentId: null,
					recordIndex: 2,
					taskId: "burijxy65",
					path: "burijxy65.output",
					toolUseId: "toolu_dev",
					source: "result",
				},
				{
					agentId: null,
					recordIndex: 3,
					taskId: "b4ntub6w0",
					path: "b4ntub6w0.output",
					toolUseId: "toolu_ci",
					source: "result",
				},
				{
					agentId: null,
					recordIndex: 4,
					taskId: "mon1xq2z3",
					path: "mon1xq2z3.output",
					toolUseId: "toolu_watch",
					source: "result",
				},
				{
					agentId: null,
					recordIndex: 5,
					taskId: "burijxy65",
					path: "burijxy65.output",
					toolUseId: "toolu_dev",
					source: "notification",
				},
				{
					agentId: null,
					recordIndex: 6,
					taskId: "mon1xq2z3",
					path: "mon1xq2z3.output",
					toolUseId: "toolu_watch",
					source: "notification",
				},
				{
					agentId: null,
					recordIndex: 7,
					taskId: "b4ntub6w0",
					path: "b4ntub6w0.output",
					toolUseId: "toolu_ci",
					source: "notification",
				},
				{
					agentId: null,
					recordIndex: 7,
					taskId: "burijxy65",
					path: "burijxy65.output",
					toolUseId: "toolu_dev",
					source: "notification",
				},
				{
					agentId: null,
					recordIndex: 9,
					taskId: "burijxy65",
					path: "burijxy65.output",
					toolUseId: "toolu_dev",
					source: "read",
				},
				{
					agentId: "agent-1",
					recordIndex: 1,
					taskId: "kid000001",
					path: "rerooted/kid000001.output",
					toolUseId: "toolu_child",
					source: "result",
				},
			],
			omitted: 0,
		});
	});

	test("bounds the listed references and counts the rest", () => {
		const content = Array.from(
			{ length: MAX_TASK_OUTPUT_REFERENCES + 3 },
			(_, index) =>
				toolResult(
					`toolu_${index}`,
					`Command running in background with ID: t${index}.`,
				),
		).join("\n");
		const found = findTaskOutputReferences(
			[{ agentId: null, content }],
			DIRECTORY,
		);
		expect(found.references).toHaveLength(MAX_TASK_OUTPUT_REFERENCES);
		expect(found.omitted).toBe(3);
	});

	test("takes the directory from the transcript, for this user and session under a known temporary directory", async () => {
		const temporary = await createDirectory();
		const transcriptPath = `/home/me/.claude/projects/-Users-me-repo/${SESSION}.jsonl`;
		const referenced = join(
			temporary,
			"claude-502",
			"-Users-me-repo",
			SESSION,
			"tasks",
		);
		const mention = (path: string) => ({
			agentId: null,
			content: toolResult(
				"toolu_a",
				`Output is being written to: ${path}/a.output`,
			),
		});
		const resolveWith = (
			streams: Parameters<
				typeof resolveClaudeTaskOutputsDirectory
			>[0]["streams"],
		) =>
			resolveClaudeTaskOutputsDirectory({
				env: { CLAUDE_CODE_TMPDIR: temporary },
				sessionId: SESSION,
				streams,
				temporaryDirectory: "/nonexistent-tmp",
				transcriptPath,
				uid: 502,
			});
		expect(await resolveWith([mention(referenced)])).toBe(referenced);
		// Another user, another session, or a directory outside the known
		// temporary directories is never taken from the transcript.
		const computed = join(
			temporary,
			"claude-502",
			"-Users-me-repo",
			SESSION,
			"tasks",
		);
		for (const path of [
			join(temporary, "claude-501", "-Users-me-repo", SESSION, "tasks"),
			join(temporary, "claude-502", "-Users-me-repo", "other", "tasks"),
			`/home/me/claude-502/-Users-me-repo/${SESSION}/tasks`,
			join(temporary, "claude-502", "..", SESSION, "tasks"),
		])
			expect(await resolveWith([mention(path)])).toBe(computed);
		// Without references: Claude Code's own layout, from the project
		// directory that holds the transcript.
		expect(await resolveWith([])).toBe(computed);
		expect(
			await resolveClaudeTaskOutputsDirectory({
				env: {},
				sessionId: SESSION,
				streams: [],
				transcriptPath,
				uid: 502,
			}),
		).toBe(
			join(
				await realpath("/tmp"),
				"claude-502",
				"-Users-me-repo",
				SESSION,
				"tasks",
			),
		);
		expect(
			await resolveClaudeTaskOutputsDirectory({
				sessionId: SESSION,
				streams: [],
				transcriptPath: "/tmp/renamed.jsonl",
				uid: 502,
			}),
		).toBeNull();
		expect(
			await resolveClaudeTaskOutputsDirectory({
				sessionId: SESSION,
				streams: [],
				transcriptPath,
				uid: null,
			}),
		).toBeNull();
	});

	test("finds the directory in linear time next to long tokens full of slashes", async () => {
		const temporary = await createDirectory();
		const referenced = join(temporary, "claude-502", "-repo", SESSION, "tasks");
		// 4 MiB of base64-like text with a `/` every few characters and no
		// whitespace, then a real reference.
		const payload = "Ab+/Cd9/".repeat(512 * 1024);
		const startedAt = performance.now();
		expect(
			await resolveClaudeTaskOutputsDirectory({
				env: { CLAUDE_CODE_TMPDIR: temporary },
				sessionId: SESSION,
				streams: [
					{
						agentId: null,
						content: `${toolResult("toolu_img", payload)}\n${toolResult("toolu_a", `${payload}/${SESSION}/tasks/x.output written to: ${referenced}/a.output`)}`,
					},
				],
				transcriptPath: `/home/me/.claude/projects/-repo/${SESSION}.jsonl`,
				uid: 502,
			}),
		).toBe(referenced);
		expect(performance.now() - startedAt).toBeLessThan(2_000);
	});

	test("never collects a tasks directory that is a symlink or not this user's", async () => {
		const temporary = await createDirectory();
		const uid = process.getuid?.();
		assert(uid !== undefined);
		const transcriptPath = `/home/me/.claude/projects/-repo/${SESSION}.jsonl`;
		const session = join(temporary, `claude-${uid}`, "-repo", SESSION);
		await mkdir(join(temporary, "elsewhere"), { recursive: true });
		await mkdir(session, { recursive: true });
		await symlink(join(temporary, "elsewhere"), join(session, "tasks"));
		const input = {
			env: { CLAUDE_CODE_TMPDIR: temporary },
			sessionId: SESSION,
			streams: [],
			transcriptPath,
		};
		expect(
			await resolveClaudeTaskOutputsDirectory({ ...input, uid }),
		).toBeNull();
		await rm(join(session, "tasks"));
		await mkdir(join(session, "tasks"));
		expect(await resolveClaudeTaskOutputsDirectory({ ...input, uid })).toBe(
			join(session, "tasks"),
		);
		// A per-user directory named for another uid exists but is not theirs.
		await mkdir(join(temporary, `claude-${uid + 1}`));
		expect(
			await resolveClaudeTaskOutputsDirectory({ ...input, uid: uid + 1 }),
		).toBeNull();
	});

	test("lists referenced task ids whose output is not on disk", async () => {
		const directory = await createDirectory();
		await mkdir(join(directory, "rerooted"));
		await writeFile(join(directory, "present01.output"), "ok\n");
		await writeFile(join(directory, "rerooted", "moved0001.output"), "ok\n");
		await symlink(
			"/home/me/.claude/projects/-repo/s/subagents/agent-a.jsonl",
			join(directory, "agent0001.output"),
		);
		const reference = (taskId: string, path = `${taskId}.output`) => ({
			agentId: null,
			recordIndex: 1,
			taskId,
			path,
			toolUseId: null,
			source: "notification" as const,
		});
		expect(
			await findMissingTaskOutputs(directory, [
				reference("present01"),
				reference("moved0001", "rerooted/moved0001.output"),
				// Named by a notification without an output file, found by the
				// result that named its moved path.
				reference("moved0001"),
				reference("agent0001"),
				reference("zgone0001"),
				reference("agone0001"),
			]),
		).toEqual({
			missingTaskIds: ["agone0001", "zgone0001"],
			missingTaskIdsOmitted: 0,
		});
	});
});

describe("capturing a session's task outputs", () => {
	test("captures real files filtered and slimmed, keeps a large log's tail, and never reads a symlink", async () => {
		const home = await createDirectory();
		const repository = join(home, "repo");
		const tasks = join(home, "tmp", "claude-502", "-repo", SESSION, "tasks");
		const outside = join(home, "outside.txt");
		const secret = `ghp_${"D".repeat(36)}`;
		const outsideSecret = "outside-secret-0123456789";
		await mkdir(repository, { recursive: true });
		execFileSync("git", ["init", "-q"], { cwd: repository });
		await mkdir(join(tasks, "rerooted"), { recursive: true });
		await writeFile(
			join(tasks, "small0001.output"),
			`${"compiled module\n".repeat(20)}token=${secret}\n`,
		);
		// 300 KiB: the first lines are cut, the cut never lands inside a line
		// or a UTF-8 sequence, and the errors at the end are kept.
		const head = "first line of the log\n";
		const filler = "server listening — ready ✓\n".repeat(11_000);
		const tail = "Error: EADDRINUSE: address already in use :::3000\n";
		await writeFile(join(tasks, "large0001.output"), `${head}${filler}${tail}`);
		await writeFile(join(tasks, "rerooted", "moved0001.output"), "moved\n");
		await writeFile(outside, `${outsideSecret}\n`);
		await symlink(outside, join(tasks, "agent0001.output"));
		await symlink(home, join(tasks, "escape"));
		const locations = { home, codexHome: join(home, ".codex") };
		const repositoryRoot = await realpath(repository);
		const bundle = await collectLocalContextBundle(
			repositoryRoot,
			{
				...getDefaultLocalContextCollectionOptions(),
				additionalRoots: await resolveUserContextRoots({
					locations,
					repositoryRoot,
					sources: await readUserAgentSources(locations, repositoryRoot),
					taskOutputsDirectory: tasks,
				}),
				capturePolicy: "session-evidence",
				transformToolResultText: slimTranscriptText,
			},
			createLocalContextSourceEnv(),
		);
		const small = readCaptured(bundle, "small0001.output");
		expect(small.text).toContain("compiled module");
		expect(small.text).not.toContain(secret);
		expect(small.truncation).toBeUndefined();
		expect(readCaptured(bundle, "rerooted/moved0001.output").text).toBe(
			"moved\n",
		);
		const large = readCaptured(bundle, "large0001.output");
		const original = Buffer.byteLength(`${head}${filler}${tail}`);
		expect(large.truncation).toEqual({
			kept: "tail",
			originalByteLength: original,
		});
		expect(large.text.endsWith(tail)).toBe(true);
		expect(large.text.startsWith("server listening — ready ✓\n")).toBe(true);
		expect(large.text).not.toContain(head);
		expect(Buffer.byteLength(large.text)).toBeLessThanOrEqual(256 * 1024);
		expect(large.size).toBe(original);
		// Symlinks (async agents' outputs) are listed, never read or followed.
		for (const path of ["agent0001.output", "escape"]) {
			const entry = bundle.manifest.entries.find(
				(candidate) =>
					candidate.rootId === "claude-task-outputs" && candidate.path === path,
			);
			expect(entry?.kind).toBe("symlink");
		}
		expect(
			bundle.manifest.entries.some(
				(entry) =>
					entry.rootId === "claude-task-outputs" &&
					entry.path.startsWith("escape/"),
			),
		).toBe(false);
		for (const blob of bundle.blobs) {
			expect(blob.content).not.toContain(outsideSecret);
			expect(blob.content).not.toContain(secret);
		}
	});
});

function readCaptured(
	bundle: LocalContextBundle,
	path: string,
): {
	readonly text: string;
	readonly size: number;
	readonly truncation: unknown;
} {
	const entry = bundle.manifest.entries.find(
		(candidate) =>
			candidate.rootId === "claude-task-outputs" && candidate.path === path,
	);
	assert(entry?.kind === "file", `${path} was not listed`);
	assert(entry.content.status === "available", `${path} was not captured`);
	const { blobId } = entry.content;
	const blob = bundle.blobs.find((candidate) => candidate.id === blobId);
	assert(blob);
	return {
		text: blob.content,
		size: entry.size,
		truncation: entry.content.truncation,
	};
}
