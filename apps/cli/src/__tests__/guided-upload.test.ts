import { describe, expect, test } from "bun:test";
import { getConnectionSelection } from "../lib/cli-connection-selection.js";
import { getCommandArgs } from "../lib/command-args.js";
import type { UploadRepository } from "../lib/upload-manager-repositories.js";
import type { UploadManagerState } from "../lib/upload-manager-state.js";

describe("browser-coded command routing", () => {
	test("routes both code spellings and leading options into pairing", () => {
		for (const args of [
			["--code", "one-time-code"],
			["--code=one-time-code"],
			["--api-base", "http://localhost:4010", "--code", "one-time-code"],
		])
			expect(getCommandArgs(args)).toEqual(["connect", ...args]);
	});
	test("preserves the simple manager, help, login and file imports", () => {
		for (const args of [
			[],
			["upload"],
			["--help"],
			["login"],
			["upload", "--help"],
			["connect", "--code", "one-time-code"],
		])
			expect(getCommandArgs(args)).toEqual(args);
		expect(getCommandArgs(["upload", "session.jsonl"])).toEqual([
			"import",
			"session.jsonl",
		]);
	});
});

describe("confirmed selection sent to browser setup", () => {
	test("uses pending toggles and shares counts without local paths or transcripts", () => {
		const repositories: UploadRepository[] = [
			{
				key: "new",
				name: "new-repo",
				paths: ["/private/new"],
				enabled: false,
				sources: ["claude_code", "codex"],
				sessionCount: 7,
				current: true,
			},
			{
				key: "old",
				name: "old-repo",
				paths: ["/private/old"],
				enabled: true,
				sources: ["codex"],
				sessionCount: 3,
				current: false,
			},
			{
				key: "empty",
				name: "empty-repo",
				paths: ["/private/empty"],
				enabled: false,
				sources: [],
				sessionCount: 0,
				current: false,
			},
		];
		const state: UploadManagerState = {
			query: "",
			cursor: 0,
			message: "",
			desired: new Map([
				["new", true],
				["old", false],
			]),
		};
		const manifest = getConnectionSelection(repositories, state, [
			"claude_code",
		]);
		expect(
			manifest.map(({ name, enabled, sessionCount, sources }) => ({
				name,
				enabled,
				sessionCount,
				sources,
			})),
		).toEqual([
			{
				name: "new-repo",
				enabled: true,
				sessionCount: 7,
				sources: ["claude_code", "codex"],
			},
			{ name: "old-repo", enabled: false, sessionCount: 3, sources: ["codex"] },
			{
				name: "empty-repo",
				enabled: false,
				sessionCount: 0,
				sources: ["claude_code"],
			},
		]);
		expect(new Set(manifest.map((repo) => repo.id)).size).toBe(3);
		expect(JSON.stringify(manifest)).not.toContain("/private/");
		expect(repositories[0]?.enabled).toBe(false);
	});
});
