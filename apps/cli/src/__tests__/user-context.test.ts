import { afterAll, describe, expect, test } from "bun:test";
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	mkdir,
	mkdtemp,
	realpath,
	rm,
	utimes,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { summarizeUserAgentConfiguration } from "../internal/local-context-source/agent-configuration.js";
import {
	collectLocalContextBundle,
	createLocalContextSourceEnv,
	getDefaultLocalContextCollectionOptions,
	type LocalContextBundle,
} from "../internal/local-context-source/index.js";
import {
	getClaudeProjectKey,
	getUserContextLocations,
	readUserAgentSources,
	resolveClaudeProjectMemoryDirectory,
	resolveUserContextRoots,
	summarizeUserAgentSources,
	type UserContextLocations,
} from "../lib/user-context.js";

const directories: string[] = [];

afterAll(async () => {
	await Promise.all(
		directories.map((directory) =>
			rm(directory, { force: true, recursive: true }),
		),
	);
});

const SECRETS = {
	bearer: "sk-live-header-0123456789abcdefghij",
	env: "env-secret-value-0123456789",
	argument: "argument-secret-0123456789",
	url: "url-secret-0123456789",
	hook: "hookbearer0123456789abcdef",
	settingsEnv: "settings-env-secret-0123456789",
	github: `ghp_${"A".repeat(36)}`,
};

describe("user agent configuration summary", () => {
	test("keeps hooks, MCP servers and plugins and never keeps a credential", () => {
		const summary = summarizeUserAgentConfiguration({
			claudeSettings: {
				path: "~/.claude/settings.json",
				status: "parsed",
				value: {
					env: { API_TOKEN: SECRETS.settingsEnv },
					enabledPlugins: { "atlas@atlas": true, "old@market": false },
					permissions: { allow: ["Bash(git status)"], defaultMode: "plan" },
					hooks: {
						Stop: [
							{
								matcher: "",
								hooks: [
									{
										type: "command",
										command: `curl -H "Authorization: Bearer ${SECRETS.hook}" https://hooks.example`,
										timeout: 30,
									},
								],
							},
						],
					},
				},
			},
			claudeInstalledPlugins: ["atlas@atlas"],
			codexConfig: {
				path: "$CODEX_HOME/config.toml",
				status: "parsed",
				value: {
					notify: ["/usr/bin/notify", `--token=${SECRETS.github}`],
					plugins: { "opaline@opaline": { enabled: true } },
					mcp_servers: {
						remote: {
							url: `https://user:${SECRETS.url}@mcp.example/sse?key=${SECRETS.url}`,
							http_headers: { Authorization: `Bearer ${SECRETS.bearer}` },
						},
						local: {
							command: "node",
							args: [
								"server.js",
								"--api-key",
								SECRETS.argument,
								"--port",
								"3000",
							],
							env: { SECRET: SECRETS.env },
						},
					},
				},
			},
			codexHooks: {
				path: "$CODEX_HOME/hooks.json",
				status: "parsed",
				value: {
					hooks: {
						session_start: [
							{ hooks: [{ type: "command", command: "opaline hooks codex" }] },
						],
					},
				},
			},
		});
		const serialized = JSON.stringify(summary);
		for (const secret of Object.values(SECRETS))
			expect(serialized).not.toContain(secret);
		expect(summary.codex.mcpServers).toEqual([
			{
				name: "remote",
				transport: "http",
				command: null,
				args: [],
				url: "https://mcp.example/sse",
				enabled: null,
				envKeys: [],
				headerKeys: ["Authorization"],
				bearerTokenEnvVar: null,
			},
			{
				name: "local",
				transport: "stdio",
				command: "node",
				args: ["server.js", "--api-key", "[REDACTED]", "--port", "3000"],
				url: null,
				enabled: null,
				envKeys: ["SECRET"],
				headerKeys: [],
				bearerTokenEnvVar: null,
			},
		]);
		expect(summary.claude.hooks).toEqual([
			{
				event: "Stop",
				matcher: "",
				type: "command",
				command:
					'curl -H "Authorization: Bearer [REDACTED]" https://hooks.example',
				timeoutSeconds: 30,
				async: null,
			},
		]);
		expect(summary.claude.enabledPlugins).toEqual({
			"atlas@atlas": true,
			"old@market": false,
		});
		expect(summary.codex.plugins).toEqual({ "opaline@opaline": true });
		expect(summary.codex.hooks.map((hook) => hook.event)).toEqual([
			"session_start",
		]);
		expect(summary.claude.permissions.allow).toEqual(["Bash(git status)"]);
	});
});

describe("user-level context roots", () => {
	test("captures user and parent instructions with their imports, plugins and settings, with exact bytes", async () => {
		const home = await createHome();
		const files = {
			".claude/CLAUDE.md":
				"# User\nUse @rules.md and @~/notes/style.md.\n`@ignored.md`\n",
			".claude/rules.md": "User rules\n",
			".claude/settings.json": JSON.stringify({
				env: { TOKEN: SECRETS.settingsEnv },
				hooks: { Stop: [{ hooks: [{ type: "command", command: "x" }] }] },
			}),
			"notes/style.md": "Style notes\n",
			"work/CLAUDE.md": "Work instructions, see @shared.md\n",
			"work/shared.md": "Shared guidance\n",
			"work/team/CLAUDE.local.md": "Personal parent instructions\n",
			".claude/commands/ship.md": "Ship command\n",
			".claude/commands/team/review.md": "Team review command\n",
			".claude/agents/reviewer.md": "Reviewer agent\n",
			".claude/output-styles/terse.md": "Terse output style\n",
			".claude/projects/elsewhere/memory/MEMORY.md": "Other project memory\n",
			"outside-import.md": "Imported from home\n",
			"codex/AGENTS.md": "Codex user instructions\n",
			"codex/AGENTS.override.md": "Codex override\n",
			"codex/config.toml": [
				'notify = ["notify"]',
				'[plugins."plug@mkt"]',
				"enabled = true",
				"[mcp_servers.remote]",
				'url = "https://mcp.example"',
				`http_headers = { Authorization = "Bearer ${SECRETS.bearer}" }`,
				"",
			].join("\n"),
			"codex/plugins/cache/mkt/plug/v1/skills/old/SKILL.md": "Old version\n",
			"codex/plugins/cache/mkt/plug/v2/skills/codex-skill/SKILL.md":
				"Codex plugin skill\n",
			"codex/plugins/cache/mkt/plug/v2/.codex-plugin/plugin.json": "{}",
			".claude/plugins/installed_plugins.json": JSON.stringify({
				version: 2,
				plugins: {
					"plug@mkt": [
						{
							scope: "user",
							installPath: join(home, ".claude/plugins/cache/mkt/plug/1.0.0"),
						},
					],
					"other@mkt": [
						{
							scope: "project",
							projectPath: join(home, "elsewhere"),
							installPath: join(home, ".claude/plugins/cache/mkt/other/1.0.0"),
						},
					],
				},
			}),
			".claude/plugins/cache/mkt/plug/1.0.0/skills/observed/SKILL.md":
				"Observed plugin skill\n",
			".claude/plugins/cache/mkt/plug/1.0.0/skills/unused/SKILL.md":
				"Unused plugin skill\n",
			".claude/plugins/cache/mkt/plug/1.0.0/commands/review.md":
				"Review command\n",
			".claude/plugins/cache/mkt/plug/1.0.0/.claude-plugin/plugin.json": "{}",
			".claude/plugins/cache/mkt/other/1.0.0/skills/other/SKILL.md":
				"Other project's plugin\n",
			"work/team/repo/AGENTS.md": "Repository instructions\n",
		};
		for (const [path, content] of Object.entries(files)) {
			await mkdir(dirname(join(home, path)), { recursive: true });
			await writeFile(join(home, path), content);
		}
		const old = new Date(Date.now() - 60_000);
		await utimes(join(home, "codex/plugins/cache/mkt/plug/v1"), old, old);
		const repository = join(home, "work/team/repo");
		execFileSync("git", ["init", "-q"], { cwd: repository });
		const locations: UserContextLocations = {
			home,
			codexHome: join(home, "codex"),
		};
		const bundle = await collectWithUserContext(repository, locations, [
			"plug:observed",
		]);
		const read = (rootId: string, path: string) =>
			readCaptured(bundle, rootId, path);
		expect(read("claude-user-home", "CLAUDE.md")).toBe(
			files[".claude/CLAUDE.md"],
		);
		expect(read("claude-user-home", "rules.md")).toBe("User rules\n");
		expect(read("home-instructions", "notes/style.md")).toBe("Style notes\n");
		expect(read("home-instructions", "work/CLAUDE.md")).toBe(
			files["work/CLAUDE.md"],
		);
		expect(read("home-instructions", "work/shared.md")).toBe(
			"Shared guidance\n",
		);
		expect(read("codex-user-home", "AGENTS.md")).toBe(
			"Codex user instructions\n",
		);
		expect(read("codex-user-home", "AGENTS.override.md")).toBe(
			"Codex override\n",
		);
		expect(
			read("claude-plugins", "mkt/plug/1.0.0/skills/observed/SKILL.md"),
		).toBe("Observed plugin skill\n");
		// Every available skill definition, observed or not, in full.
		expect(
			read("claude-plugins", "mkt/plug/1.0.0/skills/unused/SKILL.md"),
		).toBe("Unused plugin skill\n");
		expect(
			read("codex-plugins", "mkt/plug/v2/skills/codex-skill/SKILL.md"),
		).toBe("Codex plugin skill\n");
		// Personal instructions above the repository are loaded by Claude Code.
		expect(read("home-instructions", "work/team/CLAUDE.local.md")).toBe(
			"Personal parent instructions\n",
		);
		// User-level commands, agents and output styles, in full.
		for (const path of [
			"commands/ship.md",
			"commands/team/review.md",
			"agents/reviewer.md",
			"output-styles/terse.md",
		])
			expect(read("claude-user-home", path)).toBe(files[`.claude/${path}`]);
		for (const [rootId, path] of [
			["claude-user-home", "settings.json"],
			["codex-user-home", "config.toml"],
			["claude-plugins", "mkt/plug/1.0.0/commands/review.md"],
		] as const) {
			const entry = getFile(bundle, rootId, path);
			expect(entry.content).toMatchObject({
				status: "omitted",
				reason: "metadata-only",
			});
			expect(entry.hash).toMatchObject({
				status: "available",
				scope: "source",
			});
		}
		const paths = bundle.manifest.entries.map(
			(entry) => `${entry.rootId}:${entry.path}`,
		);
		expect(paths).not.toContain(
			"claude-plugins:mkt/other/1.0.0/skills/other/SKILL.md",
		);
		expect(paths.some((path) => path.includes("mkt/plug/v1"))).toBe(false);
		expect(paths).toContain(
			"codex-plugins:mkt/plug/v2/skills/codex-skill/SKILL.md",
		);
		expect(paths).not.toContain("claude-user-home:ignored.md");
		// Other projects' memory and session data are never read.
		expect(paths.some((path) => path.includes("projects/"))).toBe(false);
		expect(
			bundle.manifest.contextIndex.skills.map((skill) => skill.name),
		).toEqual(["codex-skill", "observed", "unused"]);
		for (const blob of bundle.blobs) {
			for (const secret of Object.values(SECRETS))
				expect(blob.content).not.toContain(secret);
		}
		for (const facet of bundle.manifest.contextIndex.facets)
			expect(facet.coverage).toBe("complete");
		const facet = (rootId: string, kind: string) =>
			bundle.manifest.contextIndex.facets.find(
				(candidate) => candidate.rootId === rootId && candidate.kind === kind,
			)?.presence;
		expect(facet("claude-user-home", "claude-instructions")).toBe("present");
		expect(facet("claude-user-home", "hooks")).toBe("present");
		expect(facet("codex-user-home", "agents-instructions")).toBe("present");
		expect(facet("codex-user-home", "mcp")).toBe("present");
		expect(facet("home-instructions", "claude-instructions")).toBe("present");
		const summary = JSON.stringify(
			summarizeUserAgentSources(
				await readUserAgentSources(locations, repository),
			),
		);
		for (const secret of Object.values(SECRETS))
			expect(summary).not.toContain(secret);
		expect(summary).toContain('"plug@mkt"');
	});

	test("a home without agent configuration records every user root as absent", async () => {
		const home = await createHome();
		const repository = join(home, "repo");
		await mkdir(repository, { recursive: true });
		await writeFile(join(repository, "AGENTS.md"), "Instructions\n");
		execFileSync("git", ["init", "-q"], { cwd: repository });
		const bundle = await collectWithUserContext(
			repository,
			{ home, codexHome: join(home, ".codex") },
			[],
		);
		expect(
			bundle.manifest.roots
				.filter((root) => root.id !== "repository")
				.map((root) => [root.id, root.status]),
		).toEqual(
			expect.arrayContaining([
				["claude-user-home", "missing"],
				["codex-user-home", "missing"],
				["claude-plugins", "missing"],
				["codex-plugins", "missing"],
				["home-instructions", "collected"],
			]),
		);
		for (const facet of bundle.manifest.contextIndex.facets.filter(
			(candidate) => candidate.rootId !== "repository",
		)) {
			expect(facet.coverage).toBe("complete");
			expect(facet.presence).toBe("absent");
		}
		expect(bundle.manifest.coverage.errors).toEqual([]);
	});

	test("a repository at $HOME keeps its own inventory and skips overlapping user roots", async () => {
		const home = await createHome();
		await mkdir(join(home, ".claude/skills/demo"), { recursive: true });
		await writeFile(join(home, ".claude/CLAUDE.md"), "User instructions\n");
		await writeFile(join(home, ".claude/skills/demo/SKILL.md"), "Skill\n");
		execFileSync("git", ["init", "-q"], { cwd: home });
		const bundle = await collectWithUserContext(
			home,
			{ home, codexHome: join(home, ".codex") },
			[],
		);
		const rootIds = bundle.manifest.roots.map((root) => root.id);
		expect(rootIds).not.toContain("claude-user-skills");
		expect(rootIds).not.toContain("claude-user-home");
		expect(readCaptured(bundle, "repository", ".claude/CLAUDE.md")).toBe(
			"User instructions\n",
		);
	});

	test("captures the session project's Claude auto-memory in full, index first, secret-filtered", async () => {
		const home = await createHome();
		const repository = join(home, "repo");
		await mkdir(repository, { recursive: true });
		await writeFile(join(repository, "AGENTS.md"), "Instructions\n");
		execFileSync("git", ["init", "-q"], { cwd: repository });
		const memory = join(
			home,
			".claude/projects",
			getClaudeProjectKey(repository),
			"memory",
		);
		const secret = `ghp_${"B".repeat(36)}`;
		const files = {
			"MEMORY.md": "# Memory Index\n- [Style](style.md) — house style\n",
			"style.md": `${"Prefer named exports.\n".repeat(20)}Token ${secret}\n`,
			"nested/topic.md": "Nested memory topic\n",
		};
		for (const [path, content] of Object.entries(files)) {
			await mkdir(dirname(join(memory, path)), { recursive: true });
			await writeFile(join(memory, path), content);
		}
		const locations = { home, codexHome: join(home, ".codex") };
		const memoryDirectory = await resolveClaudeProjectMemoryDirectory(
			locations,
			[await realpath(repository)],
			undefined,
		);
		expect(memoryDirectory).toBe(memory);
		const bundle = await collectWithUserContext(
			repository,
			locations,
			[],
			memoryDirectory,
		);
		expect(readCaptured(bundle, "claude-project-memory", "MEMORY.md")).toBe(
			files["MEMORY.md"],
		);
		expect(
			readCaptured(bundle, "claude-project-memory", "nested/topic.md"),
		).toBe(files["nested/topic.md"]);
		const style = readCaptured(bundle, "claude-project-memory", "style.md");
		expect(style).not.toContain(secret);
		expect(style).toContain("Prefer named exports.");
		const root = bundle.manifest.roots.find(
			(candidate) => candidate.id === "claude-project-memory",
		);
		expect(root).toMatchObject({ origin: "user", status: "collected" });
		for (const facet of bundle.manifest.contextIndex.facets)
			expect(facet.coverage).toBe("complete");
	});

	test("finds auto-memory under the main worktree, then the repository, and honours autoMemoryDirectory", async () => {
		const home = await createHome();
		const main = join(home, "code", "main");
		await mkdir(main, { recursive: true });
		await writeFile(join(main, "README.md"), "main\n");
		execFileSync("git", ["init", "-q"], { cwd: main });
		execFileSync("git", ["add", "."], { cwd: main });
		execFileSync(
			"git",
			[
				"-c",
				"user.name=Fixture",
				"-c",
				"user.email=fixture@example.com",
				"commit",
				"-qm",
				"Fixture",
			],
			{ cwd: main },
		);
		const worktree = join(home, "work", "feature");
		execFileSync("git", ["worktree", "add", "-q", worktree], { cwd: main });
		const locations = { home, codexHome: join(home, ".codex") };
		const projects = join(home, ".claude/projects");
		const roots = [await realpath(main), await realpath(worktree)];
		// Nothing exists yet: the main worktree's directory is reported (absent).
		expect(
			await resolveClaudeProjectMemoryDirectory(locations, roots, undefined),
		).toBe(join(projects, getClaudeProjectKey(roots[0] ?? ""), "memory"));
		// Only the worktree has memory: it is used.
		const worktreeMemory = join(
			projects,
			getClaudeProjectKey(roots[1] ?? ""),
			"memory",
		);
		await mkdir(worktreeMemory, { recursive: true });
		expect(
			await resolveClaudeProjectMemoryDirectory(locations, roots, undefined),
		).toBe(worktreeMemory);
		// The main worktree's memory wins once it exists, as in Claude Code.
		const mainMemory = join(
			projects,
			getClaudeProjectKey(roots[0] ?? ""),
			"memory",
		);
		await mkdir(mainMemory, { recursive: true });
		expect(
			await resolveClaudeProjectMemoryDirectory(locations, roots, undefined),
		).toBe(mainMemory);
		// The setting relocates memory inside $HOME; paths outside are ignored.
		expect(
			await resolveClaudeProjectMemoryDirectory(locations, roots, {
				autoMemoryDirectory: "~/notes/memory",
			}),
		).toBe(join(home, "notes/memory"));
		expect(
			await resolveClaudeProjectMemoryDirectory(locations, roots, {
				autoMemoryDirectory: "/etc/memory",
			}),
		).toBe(mainMemory);
		expect(getClaudeProjectKey("/Users/me/conductor/athena.v2_x")).toBe(
			"-Users-me-conductor-athena-v2-x",
		);
	});

	test("CODEX_HOME relocates Codex instructions, skills, plugins and configuration", () => {
		expect(
			getUserContextLocations({ CODEX_HOME: "/opt/codex-home" }, "/home/user"),
		).toEqual({ home: "/home/user", codexHome: "/opt/codex-home" });
		expect(getUserContextLocations({}, "/home/user")).toEqual({
			home: "/home/user",
			codexHome: "/home/user/.codex",
		});
	});
});

async function collectWithUserContext(
	repository: string,
	locations: UserContextLocations,
	observedSkillNames: readonly string[],
	memoryDirectory: string | null = null,
): Promise<LocalContextBundle> {
	const repositoryRoot = await realpath(repository);
	const sources = await readUserAgentSources(locations, repositoryRoot);
	const additionalRoots = await resolveUserContextRoots({
		locations,
		memoryDirectory,
		repositoryRoot,
		sources,
	});
	return collectLocalContextBundle(
		repositoryRoot,
		{
			...getDefaultLocalContextCollectionOptions(),
			additionalRoots,
			capturePolicy: "session-evidence",
			observedSkillNames,
		},
		createLocalContextSourceEnv(),
	);
}

async function createHome(): Promise<string> {
	const home = await realpath(
		await mkdtemp(join(tmpdir(), "opaline-user-context-")),
	);
	directories.push(home);
	return home;
}

function getFile(bundle: LocalContextBundle, rootId: string, path: string) {
	const entry = bundle.manifest.entries.find(
		(candidate) => candidate.rootId === rootId && candidate.path === path,
	);
	assert(entry?.kind === "file", `Missing ${rootId}:${path}`);
	return entry;
}

function readCaptured(
	bundle: LocalContextBundle,
	rootId: string,
	path: string,
): string {
	const entry = getFile(bundle, rootId, path);
	assert(
		entry.content.status === "available",
		`${rootId}:${path} is ${entry.content.status}`,
	);
	const blobId = entry.content.blobId;
	const blob = bundle.blobs.find((candidate) => candidate.id === blobId);
	assert(blob);
	expect(createHash("sha256").update(blob.content).digest("hex")).toBe(
		blobId.slice("sha256:".length),
	);
	return blob.content;
}
