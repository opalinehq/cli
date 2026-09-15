import { afterEach, expect, test } from "bun:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import {
	createClaudeCodeAdapter,
	createCodexAdapter,
} from "../internal/agent-adapters/index.js";
import { isRepositoryAutoUploadAllowed } from "../lib/auto-upload-config.js";
import { updateHookSettings } from "../lib/auto-upload-hooks.js";
import { getGitInfo } from "../lib/git-info.js";
import {
	getLegacyRepositoryKey,
	resolveUploadRepositoryIdentity,
} from "../lib/repository-discovery.js";
import { saveRepositoryChanges } from "../lib/repository-upload.js";
import { discoverUploadRepositories } from "../lib/upload-manager-repositories.js";

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

for (const global of [true, false]) {
	test(`shows existing ${global ? "global" : "project"} Rudel hooks as ON, then migrates and disables without duplicates`, async () => {
		const fixture = await createFixture();
		const claude = createClaudeCodeAdapter({ homeDir: fixture.root });
		const codex = createCodexAdapter({ homeDir: fixture.root });
		const localPath = claude.getHookConfigPath({ projectPath: fixture.repo });
		const globalPath = claude.getHookConfigPath({ global: true });
		const settingsPath = global ? globalPath : localPath;
		await mkdir(join(settingsPath, ".."), { recursive: true });
		const settings = {
			permissions: { allow: ["Read"] },
			hooks: {
				SessionEnd: [
					{
						matcher: "",
						hooks: [
							{ type: "command", command: "echo keep-me" },
							{ type: "command", command: "rudel hooks claude session-end" },
							{ type: "command", command: "opaline hooks claude session-end" },
						],
					},
				],
			},
		};
		await writeFile(settingsPath, JSON.stringify(settings));
		await mkdir(join(fixture.root, ".codex"), { recursive: true });
		await writeFile(
			codex.getHookConfigPath(),
			'model = "test-model"\nnotify = ["rudel", "hooks", "codex", "turn-complete"]\n',
		);
		const adapters = [claude, codex];
		const rows = await discoverUploadRepositories(() => {}, {
			cwd: fixture.repo,
			configDir: fixture.config,
			adapters,
		});
		const row = rows.find((row) => row.current);
		assert(row);
		expect(row.enabled).toBe(true);
		expect(row.problem).toBeUndefined();
		await saveRepositoryChanges(
			rows,
			[{ repository: row, enabled: false }],
			adapters,
			{ configDir: fixture.config },
		);
		expect(
			isRepositoryAutoUploadAllowed(row.key, "claude_code", row.legacyKeys),
		).toBe(false);
		expect(
			isRepositoryAutoUploadAllowed(row.key, "codex", row.legacyKeys),
		).toBe(false);
		const migrated = await readFile(globalPath, "utf8");
		expect(migrated).not.toContain("rudel hooks");
		expect(migrated.match(/opaline hooks claude session-end/gu)).toHaveLength(
			1,
		);
		if (!global)
			expect(claude.isHookInstalled({ projectPath: fixture.repo })).toBe(false);
		expect(await readFile(settingsPath, "utf8")).toContain("echo keep-me");
		expect(await readFile(settingsPath, "utf8")).toContain('"Read"');
		const codexConfig = parseToml(
			await readFile(codex.getHookConfigPath(), "utf8"),
		);
		expect(codexConfig.model).toBe("test-model");
		expect(codexConfig.notify).toEqual([
			"opaline",
			"hooks",
			"codex",
			"turn-complete",
		]);
		const rescanned = await discoverUploadRepositories(() => {}, {
			cwd: fixture.repo,
			configDir: fixture.config,
			adapters,
		});
		expect(
			rescanned.find((candidate) => candidate.key === row.key)?.enabled,
		).toBe(false);
	});
}

test("keeps legacy allowlist selections ON and removes the old key when switched OFF", async () => {
	const fixture = await createFixture();
	const claude = createClaudeCodeAdapter({ homeDir: fixture.root });
	claude.installHook({ global: true });
	const gitInfo = await getGitInfo(fixture.repo);
	const legacyKey = getLegacyRepositoryKey(fixture.repo, gitInfo);
	const canonicalKey = resolveUploadRepositoryIdentity(
		fixture.repo,
		gitInfo,
	).repoKey;
	expect(legacyKey).not.toBe(canonicalKey);
	await writeFile(
		join(fixture.config, "auto-upload.json"),
		JSON.stringify({
			version: 1,
			repositories: {
				[legacyKey]: { label: "Legacy repository", sources: ["claude_code"] },
			},
		}),
	);
	const rows = await discoverUploadRepositories(() => {}, {
		cwd: fixture.repo,
		configDir: fixture.config,
		adapters: [claude],
	});
	expect(rows).toHaveLength(1);
	const row = rows[0];
	assert(row);
	expect(row.key).toBe(canonicalKey);
	expect(row.enabled).toBe(true);
	await saveRepositoryChanges(
		rows,
		[{ repository: row, enabled: false }],
		[claude],
		{ configDir: fixture.config },
	);
	expect(
		isRepositoryAutoUploadAllowed(canonicalKey, "claude_code", [legacyKey]),
	).toBe(false);
	expect(
		await readFile(join(fixture.config, "auto-upload.json"), "utf8"),
	).not.toContain(`"${legacyKey}"`);
});

test("fills the table as sessions arrive and merges deleted Conductor worktrees with their live sibling", async () => {
	const fixture = await createFixture();
	const claude = createClaudeCodeAdapter({ homeDir: fixture.root });
	const missing = join(
		fixture.root,
		"conductor",
		"workspaces",
		"demo",
		"removed",
	);
	for (const [index, path] of [fixture.repo, missing].entries()) {
		const directory = join(claude.getSessionsBaseDir(), `project-${index}`);
		await mkdir(directory, { recursive: true });
		await writeFile(
			join(directory, `session-${index}.jsonl`),
			`${JSON.stringify({ type: "user", cwd: path, timestamp: "2026-09-01T00:00:00Z", message: { role: "user", content: "fixture" } })}\n`,
		);
	}
	const progress: number[] = [];
	const rows = await discoverUploadRepositories(
		(state) => progress.push(state.sessions),
		{ cwd: fixture.repo, configDir: fixture.config, adapters: [claude] },
	);
	expect(progress).toContain(0);
	expect(progress).toContain(1);
	expect(progress).toContain(2);
	expect(rows).toHaveLength(1);
	expect(rows[0]?.sessionCount).toBe(2);
	expect(rows[0]?.paths).toContain(missing);
});

test("a conflicting Codex notifier leaves existing Rudel hooks intact and retry migrates once", async () => {
	const fixture = await createFixture();
	const claude = createClaudeCodeAdapter({ homeDir: fixture.root });
	const codex = createCodexAdapter({ homeDir: fixture.root });
	const localPath = claude.getHookConfigPath({ projectPath: fixture.repo });
	await mkdir(join(localPath, ".."), { recursive: true });
	const original = JSON.stringify({
		permissions: { allow: ["Read"] },
		hooks: {
			SessionEnd: [
				{
					hooks: [
						{ type: "command", command: "rudel hooks claude session-end" },
					],
				},
			],
		},
	});
	await writeFile(localPath, original);
	await mkdir(join(fixture.root, ".codex"));
	const notifier = 'model = "keep-me"\nnotify = ["existing-notifier"]\n';
	await writeFile(codex.getHookConfigPath(), notifier);
	const adapters = [claude, codex];
	const rows = await discoverUploadRepositories(() => {}, {
		cwd: fixture.repo,
		configDir: fixture.config,
		adapters,
	});
	const row = rows.find((row) => row.current);
	assert(row);
	await expect(
		saveRepositoryChanges(
			rows,
			[{ repository: row, enabled: true }],
			adapters,
			{ configDir: fixture.config },
		),
	).rejects.toThrow("Codex notify is already configured");
	expect(claude.isHookInstalled({ global: true })).toBe(false);
	expect(await readFile(localPath, "utf8")).toBe(original);
	expect(await readFile(codex.getHookConfigPath(), "utf8")).toBe(notifier);
	// Once the user removes their conflicting notifier, the same selection is retryable.
	await writeFile(codex.getHookConfigPath(), 'model = "keep-me"\n');
	for (let attempt = 0; attempt < 2; attempt++)
		await saveRepositoryChanges(
			rows,
			[{ repository: row, enabled: true }],
			adapters,
			{ configDir: fixture.config },
		);
	expect(claude.isHookInstalled({ global: true })).toBe(true);
	expect(claude.isHookInstalled({ projectPath: fixture.repo })).toBe(false);
	expect(
		(await readFile(claude.getHookConfigPath({ global: true }), "utf8")).match(
			/opaline hooks claude session-end/gu,
		),
	).toHaveLength(1);
	expect(await readFile(localPath, "utf8")).toContain('"Read"');
	expect(
		parseToml(await readFile(codex.getHookConfigPath(), "utf8")).model,
	).toBe("keep-me");
});

test("turning a repository OFF succeeds without replacing an unrelated Codex notifier", async () => {
	const fixture = await createFixture();
	const claude = createClaudeCodeAdapter({ homeDir: fixture.root });
	const codex = createCodexAdapter({ homeDir: fixture.root });
	claude.installHook({ global: true });
	await mkdir(join(fixture.root, ".codex"));
	const notifier = 'notify = ["existing-notifier"]\n';
	await writeFile(codex.getHookConfigPath(), notifier);
	const adapters = [claude, codex];
	const rows = await discoverUploadRepositories(() => {}, {
		cwd: fixture.repo,
		configDir: fixture.config,
		adapters,
	});
	const row = rows.find((row) => row.current);
	assert(row);
	await saveRepositoryChanges(
		rows,
		[{ repository: row, enabled: false }],
		adapters,
		{ configDir: fixture.config },
	);
	expect(row.enabled).toBe(false);
	expect(isRepositoryAutoUploadAllowed(row.key, "claude_code")).toBe(false);
	expect(await readFile(codex.getHookConfigPath(), "utf8")).toBe(notifier);
});

test("a later filesystem failure restores removed local hooks and removes a new global hook", async () => {
	const fixture = await createFixture();
	const claude = createClaudeCodeAdapter({ homeDir: fixture.root });
	const local = claude.getHookConfigPath({ projectPath: fixture.repo });
	const global = claude.getHookConfigPath({ global: true });
	await mkdir(join(local, ".."), { recursive: true });
	const original =
		'{"permissions":{"allow":["Read"]},"hooks":{"SessionEnd":[{"hooks":[{"command":"rudel hooks claude session-end"}]}]}}';
	await writeFile(local, original);
	expect(() =>
		updateHookSettings([local, global], () => {
			claude.installHook({ global: true });
			claude.removeHook({ projectPath: fixture.repo });
			// A real failed write after the first agent migration; no adapter or FS mocks.
			writeFileSync(
				join(fixture.root, "missing-directory", "config.toml"),
				"notify = []",
			);
		}),
	).toThrow("ENOENT");
	expect(await readFile(local, "utf8")).toBe(original);
	expect(claude.isHookInstalled({ global: true })).toBe(false);
	expect(claude.isHookInstalled({ projectPath: fixture.repo })).toBe(true);
});

async function createFixture() {
	const root = await mkdtemp(join(tmpdir(), "opaline-manager-migration-"));
	fixtures.push(root);
	const repo = join(root, "conductor", "workspaces", "demo", "live");
	const config = join(root, "config");
	await mkdir(repo, { recursive: true });
	await mkdir(config);
	process.env.OPALINE_CONFIG_DIR = config;
	const git = Bun.spawn(["git", "init", "--quiet", repo], {
		stdout: "pipe",
		stderr: "pipe",
	});
	expect(await git.exited).toBe(0);
	return { root, repo, config };
}
