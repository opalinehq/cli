import { afterEach, describe, expect, test } from "bun:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FILTER_VERSION } from "../internal/secret-filter/index.js";
import {
	cleanupStagedUpload,
	createFilteredUploadSources,
	stageFilteredUpload,
} from "../lib/filtered-upload-staging.js";

const temporaryDirectories: string[] = [];
const SCREENSHOT = Buffer.from(
	Array.from({ length: 6_000 }, (_, index) => (index * 31 + 7) % 256),
);
const SCREENSHOT_BASE64 = SCREENSHOT.toString("base64");
const SCREENSHOT_MARKER = `opaline-image-omitted:v1;sha256=${createHash("sha256").update(SCREENSHOT).digest("hex")};bytes=6000;type=image/png`;

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { force: true, recursive: true })),
	);
});

describe("filtered upload staging", () => {
	test("stops stream filtering when the shared capture deadline expires", async () => {
		const directory = await mkdtemp(join(tmpdir(), "opaline-filter-deadline-"));
		temporaryDirectories.push(directory);
		const path = join(directory, "transcript.jsonl");
		await writeFile(path, '{"message":"clean record"}\n'.repeat(50_000));
		await expect(
			stageFilteredUpload(
				{
					main: { kind: "file", path },
					metadata: {
						projectPath: "/test",
						sessionId: "slow",
						source: "claude_code",
					},
					slim: false,
					subagents: [],
				},
				{ deadlineAt: Date.now() + 30, maxInputBytes: 2 * 1024 * 1024 },
			),
		).rejects.toThrow(/budget|aborted/iu);
	});

	test("retains empty child streams when staging evidence attribution", async () => {
		const staged = await stageFilteredUpload(
			{
				main: { kind: "text", content: "{}\n" },
				metadata: {
					projectPath: "/test",
					sessionId: "empty-child",
					source: "claude_code",
				},
				slim: false,
				subagents: [
					{ agentId: "empty", source: { kind: "text", content: "" } },
				],
			},
			{
				deadlineAt: Date.now() + 1000,
				maxInputBytes: 100,
				includeEmptySubagents: true,
			},
		);
		temporaryDirectories.push(staged.directory);
		expect(staged.objects).toHaveLength(2);
		expect(staged.objects[1]?.byteLength).toBe(0);
	});

	test("checks the aggregate source budget before opening transcripts", async () => {
		const sourceDirectory = await mkdtemp(
			join(tmpdir(), "opaline-filter-budget-"),
		);
		temporaryDirectories.push(sourceDirectory);
		const sourcePath = join(sourceDirectory, "transcript.jsonl");
		await writeFile(sourcePath, "not a bounded record".repeat(10));
		await expect(
			stageFilteredUpload(
				{
					main: { kind: "file", path: sourcePath },
					metadata: {
						sessionId: "bounded",
						source: "claude_code",
						projectPath: "/test",
					},
					slim: false,
					subagents: [
						{ agentId: "child", source: { kind: "file", path: sourcePath } },
					],
				},
				{ maxInputBytes: 250, deadlineAt: Date.now() + 1000 },
			),
		).rejects.toThrow("input budget");
	});

	test("checks the capture deadline before reading", async () => {
		await expect(
			stageFilteredUpload(
				{
					main: { kind: "text", content: "{}\n" },
					metadata: {
						sessionId: "expired",
						source: "claude_code",
						projectPath: "/test",
					},
					slim: false,
					subagents: [],
				},
				{ maxInputBytes: 100, deadlineAt: Date.now() - 1 },
			),
		).rejects.toThrow("budget");
	});

	test("filters a file source before creating the upload hash", async () => {
		const sourceDirectory = await mkdtemp(
			join(tmpdir(), "opaline-filter-source-"),
		);
		temporaryDirectories.push(sourceDirectory);
		const sourcePath = join(sourceDirectory, "transcript.jsonl");
		const canary = `AKIA${"A".repeat(16)}`;
		const content = [
			JSON.stringify({ message: `Use ${canary}`, padding: "x".repeat(200) }),
			JSON.stringify({ message: "clean second line" }),
		].join("\n");
		await writeFile(sourcePath, content);

		const staged = await stageFilteredUpload({
			main: { kind: "file", path: sourcePath },
			metadata: {
				filter_version: FILTER_VERSION,
				projectPath: "/test/project",
				sessionId: "filtered-file",
				source: "claude_code",
			},
			slim: false,
			subagents: [],
		});
		temporaryDirectories.push(staged.directory);
		const main = staged.objects[0];
		expect(main?.kind).toBe("main");
		assert(main);
		const filtered = await readFile(main.path, "utf8");

		expect(filtered).not.toContain(canary);
		expect(filtered).toContain("[REDACTED:aws-access-key-id]");
		expect(staged.redactions).toEqual({ "aws-access-key-id": 1 });
		expect(staged.redactedBytes).toBe(Buffer.byteLength(canary));
		expect(main.byteLength).toBe(Buffer.byteLength(filtered));
		expect(main.sha256).toBe(
			createHash("sha256").update(filtered).digest("hex"),
		);
		expect((await stat(staged.directory)).mode & 0o777).toBe(0o700);
		expect((await stat(main.path)).mode & 0o777).toBe(0o600);

		await cleanupStagedUpload(staged);
		temporaryDirectories.splice(
			temporaryDirectories.indexOf(staged.directory),
			1,
		);
	});

	test("detects secrets when a JSONL record crosses read chunks", async () => {
		const sourceDirectory = await mkdtemp(
			join(tmpdir(), "opaline-filter-boundary-"),
		);
		temporaryDirectories.push(sourceDirectory);
		const sourcePath = join(sourceDirectory, "boundary.jsonl");
		const canary = `AKIA${"B".repeat(16)}`;
		const content = JSON.stringify({
			padding: "x".repeat(64 * 1024 - 10),
			secret: canary,
		});
		await writeFile(sourcePath, content);

		const staged = await stageFilteredUpload({
			main: { kind: "file", path: sourcePath },
			metadata: {
				projectPath: "/test/project",
				sessionId: "chunk-boundary",
				source: "codex",
			},
			slim: false,
			subagents: [],
		});
		temporaryDirectories.push(staged.directory);
		const main = staged.objects[0];
		assert(main);
		const filtered = await readFile(main.path, "utf8");

		expect(filtered).not.toContain(canary);
		expect(filtered).toContain("[REDACTED:aws-access-key-id]");
	});

	test("stages main first and subagent objects in agent ID order", async () => {
		const staged = await stageFilteredUpload({
			main: { content: "main", kind: "text" },
			metadata: {
				projectPath: "/test/project",
				sessionId: "sorted-manifest",
				source: "claude_code",
			},
			slim: false,
			subagents: [
				{ agentId: "agent-z", source: { content: "z", kind: "text" } },
				{ agentId: "agent-a", source: { content: "a", kind: "text" } },
			],
		});
		temporaryDirectories.push(staged.directory);

		expect(
			staged.objects.map((object) =>
				object.kind === "main" ? object.kind : object.agentId,
			),
		).toEqual(["main", "agent-a", "agent-z"]);
	});

	test("omits empty subagent objects from the R2 manifest", async () => {
		const sourceDirectory = await mkdtemp(
			join(tmpdir(), "opaline-filter-empty-subagent-"),
		);
		temporaryDirectories.push(sourceDirectory);
		const emptySubagentPath = join(sourceDirectory, "empty.jsonl");
		await writeFile(emptySubagentPath, "");

		const staged = await stageFilteredUpload({
			main: { content: "main", kind: "text" },
			metadata: {
				projectPath: "/test/project",
				sessionId: "empty-subagent",
				source: "claude_code",
			},
			slim: false,
			subagents: [
				{
					agentId: "agent-empty-file",
					source: { kind: "file", path: emptySubagentPath },
				},
				{
					agentId: "agent-empty-text",
					source: { content: "", kind: "text" },
				},
				{
					agentId: "agent-kept",
					source: { content: "kept", kind: "text" },
				},
			],
		});
		temporaryDirectories.push(staged.directory);

		expect(
			staged.objects.map((object) =>
				object.kind === "main" ? object.kind : object.agentId,
			),
		).toEqual(["main", "agent-kept"]);
		expect(staged.aggregateBytes).toBe(Buffer.byteLength("mainkept"));
	});

	test("slims main and subagent streams before secret filtering", async () => {
		const sourceDirectory = await mkdtemp(join(tmpdir(), "opaline-slim-"));
		temporaryDirectories.push(sourceDirectory);
		const mainPath = join(sourceDirectory, "main.jsonl");
		const childPath = join(sourceDirectory, "child.jsonl");
		const canary = `AKIA${"A".repeat(16)}`;
		const output = `deploy with ${canary}\n${"line\n".repeat(400)}`;
		await writeFile(
			mainPath,
			`${[
				JSON.stringify({
					type: "event_msg",
					payload: {
						type: "item_completed",
						item: {
							type: "CommandExecution",
							stdout: output,
							stderr: "",
							aggregated_output: output,
							exit_code: 0,
							formatted_output: output,
						},
					},
				}),
				JSON.stringify({
					type: "response_item",
					payload: {
						type: "function_call_output",
						output: [
							{
								type: "input_image",
								image_url: `data:image/png;base64,${SCREENSHOT_BASE64}`,
							},
						],
					},
				}),
			].join("\n")}\n`,
		);
		await writeFile(
			childPath,
			`${JSON.stringify({
				type: "user",
				message: {
					content: [
						{
							type: "image",
							source: {
								type: "base64",
								media_type: "image/jpeg",
								data: SCREENSHOT_BASE64,
							},
						},
					],
				},
			})}\n`,
		);

		const staged = await stageFilteredUpload(
			createFilteredUploadSources(
				{
					kind: "file",
					metadata: {
						projectPath: "/test",
						sessionId: "slimmed",
						source: "codex",
					},
					subagents: [{ agentId: "child", path: childPath }],
					transcriptPath: mainPath,
				},
				{ slim: true },
			),
		);
		temporaryDirectories.push(staged.directory);
		const [main, child] = staged.objects;
		assert(main && child);
		const mainText = await readFile(main.path, "utf8");
		const childText = await readFile(child.path, "utf8");
		const command = JSON.parse(mainText.split("\n")[0] ?? "").payload.item;

		expect(command).toEqual({
			type: "CommandExecution",
			stderr: "",
			aggregated_output: output.replace(canary, "[REDACTED:aws-access-key-id]"),
			exit_code: 0,
		});
		expect(mainText).not.toContain(SCREENSHOT_BASE64);
		expect(mainText).toContain(SCREENSHOT_MARKER);
		expect(childText).not.toContain(SCREENSHOT_BASE64);
		expect(JSON.parse(childText).message.content[0].source).toEqual({
			type: "base64",
			media_type: "image/jpeg",
			data: SCREENSHOT_MARKER.replace("image/png", "image/jpeg"),
		});
		expect(staged.redactions).toEqual({ "aws-access-key-id": 1 });
		expect(staged.filterInputBytes).toBeLessThan(staged.inputBytes / 2);
		expect(staged.aggregateBytes).toBe(
			Buffer.byteLength(mainText) + Buffer.byteLength(childText),
		);
		expect(main.sha256).toBe(
			createHash("sha256").update(mainText).digest("hex"),
		);
		for (const line of `${mainText}${childText}`.split("\n")) {
			if (line !== "") expect(() => JSON.parse(line)).not.toThrow();
		}
	});

	test("keeps exact bytes when slimming is off for repository evidence", async () => {
		const content = `${JSON.stringify({
			type: "response_item",
			payload: {
				type: "message",
				content: [
					{
						type: "input_image",
						image_url: `data:image/png;base64,${SCREENSHOT_BASE64}`,
					},
				],
			},
		})}\n`;
		const staged = await stageFilteredUpload(
			createFilteredUploadSources(
				{ content, projectPath: "/test", sessionId: "exact", source: "codex" },
				{ slim: false },
			),
		);
		temporaryDirectories.push(staged.directory);
		const main = staged.objects[0];
		assert(main);

		expect(await readFile(main.path, "utf8")).toBe(content);
		expect(staged.filterInputBytes).toBe(staged.inputBytes);
	});
});
