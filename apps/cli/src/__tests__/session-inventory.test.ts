import { afterEach, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClaudeCodeAdapter } from "../internal/agent-adapters/index.js";
import { getGitInfo } from "../lib/git-info.js";
import { resolveUploadRepositoryIdentity } from "../lib/repository-discovery.js";
import {
	collectSessionInventory,
	countTranscriptLines,
} from "../lib/session-inventory.js";

const originalConfig = process.env.OPALINE_CONFIG_DIR;
const fixtures: string[] = [];
afterEach(async () => {
	if (originalConfig === undefined) delete process.env.OPALINE_CONFIG_DIR;
	else process.env.OPALINE_CONFIG_DIR = originalConfig;
	await Promise.all(
		fixtures
			.splice(0)
			.map((path) => rm(path, { recursive: true, force: true })),
	);
});

test("counts the non-empty lines the server counts, a last line without a newline included", async () => {
	const root = await mkdtemp(join(tmpdir(), "opaline-inventory-lines-"));
	fixtures.push(root);
	const path = join(root, "a.jsonl");
	await writeFile(path, '{"a":1}\n\n  \t\r\n{"b":2}\r\n{"c":3}');
	expect(await countTranscriptLines(path)).toEqual({ lines: 3, bytes: 30 });
});

test("lists only sessions the upload settings allow, with counts and no content, and recounts a session that grew", async () => {
	const root = await mkdtemp(join(tmpdir(), "opaline-inventory-"));
	fixtures.push(root);
	const config = join(root, "config");
	await mkdir(config);
	process.env.OPALINE_CONFIG_DIR = config;
	const allowed = await repository(root, "allowed");
	const disabled = await repository(root, "disabled");
	const scratch = join(root, "scratch");
	await mkdir(scratch);
	const key = async (path: string) =>
		resolveUploadRepositoryIdentity(path, await getGitInfo(path)).repoKey;
	await writeFile(
		join(config, "auto-upload.json"),
		JSON.stringify({
			version: 1,
			defaultOrganizationId: "org_default",
			repositories: {
				[await key(allowed)]: { label: "allowed", sources: ["claude_code"] },
				[await key(disabled)]: { label: "disabled", sources: [] },
				[await key(scratch)]: { label: "scratch", sources: ["claude_code"] },
			},
		}),
	);
	const claude = createClaudeCodeAdapter({ homeDir: root });
	const project = (path: string) =>
		join(root, ".claude", "projects", path.replace(/\//g, "-"));
	const main = await session(project(allowed), "s-main", allowed, [
		prompt("2026-11-01T10:00:00.000Z", allowed),
		"",
		reply("2026-11-01T10:00:05.000Z", allowed, []),
	]);
	await mkdir(join(project(allowed), "s-main", "subagents"), {
		recursive: true,
	});
	await writeFile(
		join(project(allowed), "s-main", "subagents", "agent-a1.jsonl"),
		`${JSON.stringify({ agentId: "a1", sessionId: "s-main", type: "user", timestamp: "2026-11-01T10:00:01.000Z", message: { role: "user", content: "go" } })}\n`,
	);
	await session(project(allowed), "s-empty", allowed, [
		JSON.stringify({ type: "summary", summary: "no timestamps", cwd: allowed }),
	]);
	await session(project(disabled), "s-off", disabled, [
		prompt("2026-11-01T11:00:00.000Z", disabled),
	]);
	await session(project(scratch), "s-scratch-off", scratch, [
		prompt("2026-11-01T12:00:00.000Z", scratch),
		reply("2026-11-01T12:00:01.000Z", scratch, [
			{ name: "Edit", input: { file_path: join(disabled, "index.ts") } },
		]),
	]);
	await session(project(scratch), "s-scratch", scratch, [
		prompt("2026-11-01T13:00:00.000Z", scratch),
	]);

	const first = await collectSessionInventory({
		adapters: [claude],
		configDir: config,
		cwd: allowed,
	});
	const listed = first.flatMap((group) => group.sessions);
	expect(listed.map((entry) => entry.sessionId).sort()).toEqual([
		"s-main",
		"s-scratch",
	]);
	const counted = listed.find((entry) => entry.sessionId === "s-main");
	expect(counted).toMatchObject({
		source: "claude_code",
		mainLines: 2,
		subagentLines: 1,
		subagentFiles: 1,
		startedAt: "2026-11-01T10:00:00.000Z",
	});
	expect(Object.keys(counted ?? {}).sort()).toEqual([
		"mainBytes",
		"mainLines",
		"modifiedAt",
		"sessionId",
		"source",
		"startedAt",
		"subagentBytes",
		"subagentFiles",
		"subagentLines",
	]);

	await appendFile(main, `\n${reply("2026-11-01T10:01:00.000Z", allowed, [])}`);
	const second = await collectSessionInventory({
		adapters: [claude],
		configDir: config,
		cwd: allowed,
	});
	expect(
		second
			.flatMap((group) => group.sessions)
			.find((entry) => entry.sessionId === "s-main")?.mainLines,
	).toBe(3);
});

async function repository(root: string, name: string): Promise<string> {
	const path = join(root, name);
	await mkdir(path);
	for (const command of [
		["git", "init", "--quiet", path],
		[
			"git",
			"-C",
			path,
			"remote",
			"add",
			"origin",
			`https://github.com/acme/${name}.git`,
		],
	]) {
		const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
		expect(await child.exited).toBe(0);
	}
	return path;
}

async function session(
	directory: string,
	id: string,
	cwd: string,
	lines: string[],
): Promise<string> {
	await mkdir(directory, { recursive: true });
	const path = join(directory, `${id}.jsonl`);
	await writeFile(
		path,
		lines
			.map((line) =>
				line.includes('"cwd"') || line === ""
					? line
					: line.replace("{", `{"cwd":${JSON.stringify(cwd)},`),
			)
			.join("\n"),
	);
	return path;
}

function prompt(timestamp: string, cwd: string): string {
	return JSON.stringify({
		type: "user",
		cwd,
		timestamp,
		message: { role: "user", content: "hello" },
	});
}

function reply(
	timestamp: string,
	cwd: string,
	tools: { name: string; input: Record<string, unknown> }[],
): string {
	return JSON.stringify({
		type: "assistant",
		cwd,
		timestamp,
		message: {
			role: "assistant",
			content: [
				{ type: "text", text: "ok" },
				...tools.map((tool, index) => ({
					type: "tool_use",
					id: `t${index}`,
					...tool,
				})),
			],
		},
	});
}
