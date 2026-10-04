import { afterEach, describe, expect, test } from "bun:test";
import {
	mkdir,
	mkdtemp,
	realpath,
	rm,
	symlink,
	truncate,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INGEST_MAX_SUBAGENT_COUNT } from "../contracts/ingest.js";
import { discoverClaudeSubagentFiles } from "../internal/agent-adapters/index.js";
import { MAX_RAW_TRANSCRIPT_BYTES } from "../lib/filtered-upload-staging.js";

const fixtureRoots: string[] = [];

afterEach(async () => {
	await Promise.all(
		fixtureRoots
			.splice(0)
			.map((root) => rm(root, { force: true, recursive: true })),
	);
});

describe("Claude subagent discovery", () => {
	test("discovers a native child even when the root did not reference its agent ID", async () => {
		const root = await createFixtureRoot();
		const sessionId = "session-native";
		const childDir = join(root, sessionId, "subagents");
		await mkdir(childDir, { recursive: true });
		await writeFile(
			join(childDir, "agent-child-native.jsonl"),
			`${JSON.stringify({
				agentId: "child-native",
				isSidechain: true,
				sessionId,
				timestamp: "2026-09-21T10:00:00.000Z",
				type: "assistant",
			})}\n`,
		);

		const result = await discoverClaudeSubagentFiles(root, sessionId);

		expect(result.discovery).toEqual({
			omittedCount: 0,
			reason: null,
			status: "complete",
		});
		expect(result.files).toEqual([
			{
				agentId: "child-native",
				path: await realpath(join(childDir, "agent-child-native.jsonl")),
			},
		]);
	});

	test("omits files whose filename identity or root session does not match native records", async () => {
		const root = await createFixtureRoot();
		const sessionId = "session-native";
		const childDir = join(root, sessionId, "subagents");
		await mkdir(childDir, { recursive: true });
		await Promise.all([
			writeFile(
				join(childDir, "agent-wrong-name.jsonl"),
				`${JSON.stringify({
					agentId: "different-native-id",
					sessionId,
				})}\n`,
			),
			writeFile(
				join(childDir, "agent-wrong-session.jsonl"),
				`${JSON.stringify({
					agentId: "wrong-session",
					sessionId: "another-root",
				})}\n`,
			),
		]);

		const result = await discoverClaudeSubagentFiles(root, sessionId);

		expect(result.files).toEqual([]);
		expect(result.discovery.status).toBe("partial");
		expect(result.discovery.omittedCount).toBe(2);
		expect(result.discovery.reason).toContain(
			"filename did not match its native identity",
		);
	});

	test("does not follow a child filename symlink", async () => {
		const root = await createFixtureRoot();
		const outside = await createFixtureRoot();
		const sessionId = "session-native";
		const childDir = join(root, sessionId, "subagents");
		const outsideFile = join(outside, "agent-escape.jsonl");
		await mkdir(childDir, { recursive: true });
		await writeFile(
			outsideFile,
			`${JSON.stringify({ agentId: "escape", sessionId })}\n`,
		);
		await symlink(outsideFile, join(childDir, "agent-escape.jsonl"));

		const result = await discoverClaudeSubagentFiles(root, sessionId);

		expect(result.files).toEqual([]);
		expect(result.discovery).toMatchObject({
			omittedCount: 1,
			status: "partial",
		});
		expect(result.discovery.reason).toContain("could not be safely resolved");
	});

	test("bounds the number of child files inspected", async () => {
		const root = await createFixtureRoot();
		const sessionId = "session-native";
		const childDir = join(root, sessionId, "subagents");
		await mkdir(childDir, { recursive: true });
		await Promise.all(
			Array.from({ length: INGEST_MAX_SUBAGENT_COUNT + 1 }, (_, index) => {
				const agentId = `child-${index.toString().padStart(3, "0")}`;
				return writeFile(
					join(childDir, `agent-${agentId}.jsonl`),
					`${JSON.stringify({ agentId, sessionId })}\n`,
				);
			}),
		);

		const result = await discoverClaudeSubagentFiles(root, sessionId);

		expect(result.files).toHaveLength(INGEST_MAX_SUBAGENT_COUNT);
		expect(result.discovery).toMatchObject({
			omittedCount: 1,
			status: "partial",
		});
		expect(result.discovery.reason).toContain("count limit");
	}, 20_000);

	test("rejects a child file before reading beyond the total byte bound", async () => {
		const root = await createFixtureRoot();
		const sessionId = "session-native";
		const childDir = join(root, sessionId, "subagents");
		const childPath = join(childDir, "agent-oversized.jsonl");
		await mkdir(childDir, { recursive: true });
		await writeFile(childPath, "");
		await truncate(childPath, MAX_RAW_TRANSCRIPT_BYTES + 1);

		const result = await discoverClaudeSubagentFiles(root, sessionId);

		expect(result.files).toEqual([]);
		expect(result.discovery).toMatchObject({
			omittedCount: 1,
			status: "partial",
		});
		expect(result.discovery.reason).toContain("byte limit");
	});
});

async function createFixtureRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "opaline-claude-discovery-"));
	fixtureRoots.push(root);
	return root;
}
