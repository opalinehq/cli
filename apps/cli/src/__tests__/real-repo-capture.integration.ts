import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, join, relative } from "node:path";
import { parse as parseToml } from "smol-toml";
import {
	REPOSITORY_EVIDENCE_MAX_AGGREGATE_BYTES,
	REPOSITORY_EVIDENCE_MAX_OBJECTS,
} from "../contracts/index.js";
import {
	filterContextText,
	sanitizeMcpText,
} from "../internal/local-context-source/credential-redaction.js";
import { getConfigDir } from "../lib/local-state.js";
import { readPendingRepositoryEvidence } from "../lib/repository-evidence-pending.js";
import { captureAndUploadSessionEvidence } from "../lib/session-evidence.js";
import { startEvidenceProtocolStub } from "./helpers/evidence-protocol-stub.js";

/**
 * Opt-in capture of real checkouts, read-only. Run with
 *
 *   OPALINE_REAL_REPO_PATHS=/path/one:/path/two bun run test:real-repos
 *
 * The capture runs the production code path (context collection, spool,
 * pending item, delivery) with the configuration directory, spool and pending
 * items in a temporary directory, and delivers to the loopback protocol stub.
 * Skill roots are read from the real home directory, as the hook does. It
 * asserts that every coverage area and facet is complete and that every
 * AGENTS.md and CLAUDE.md is stored byte for byte as it is on disk, or, when
 * the capture policy keeps it hash-only (skill resources, personal files),
 * that its source hash matches the file on disk.
 */

setDefaultTimeout(180_000);

const repositoryPaths = (process.env.OPALINE_REAL_REPO_PATHS ?? "")
	.split(delimiter)
	.filter((path) => path.length > 0);
const temporaryDirectories: string[] = [];

afterAll(async () => {
	await Promise.all(
		temporaryDirectories.map((directory) =>
			rm(directory, { force: true, recursive: true }),
		),
	);
});

describe("real repository sidecar capture", () => {
	test("OPALINE_REAL_REPO_PATHS names at least one repository", () => {
		expect(repositoryPaths.length).toBeGreaterThan(0);
	});

	test.each(repositoryPaths)(
		"captures %s completely",
		async (repositoryPath) => {
			const configDir = await realpath(
				await mkdtemp(join(tmpdir(), "opaline-real-repo-")),
			);
			temporaryDirectories.push(configDir);
			process.env.OPALINE_CONFIG_DIR = configDir;
			process.env.RUDEL_CONFIG_DIR = configDir;
			process.env.POSTHOG_ENABLED = "false";
			process.env.OPALINE_ALLOW_INSECURE_ENDPOINT = "1";
			expect(getConfigDir()).toBe(configDir);
			const stub = startEvidenceProtocolStub();
			try {
				const credentials = {
					apiBaseUrl: stub.base,
					authType: "api-key" as const,
					token: "test",
					user: {
						id: "real-repo-user",
						email: "test@example.invalid",
						name: "Test",
					},
				};
				await writeFile(
					join(configDir, "credentials.json"),
					JSON.stringify(credentials),
				);
				const sessionId = randomUUID();
				const observedPluginSkill = await findInstalledClaudePluginSkill();
				const content = `${[
					{
						type: "session_meta",
						timestamp: new Date().toISOString(),
						payload: { id: sessionId, cwd: repositoryPath },
					},
					{
						timestamp: new Date().toISOString(),
						type: "response_item",
						payload: {
							content: [
								{ text: "Real repository capture", type: "input_text" },
							],
							role: "user",
							type: "message",
						},
					},
					...(observedPluginSkill === null
						? []
						: [
								{
									timestamp: new Date().toISOString(),
									type: "response_item",
									payload: {
										type: "function_call",
										name: "Skill",
										arguments: JSON.stringify({
											skill: observedPluginSkill.name,
										}),
									},
								},
							]),
				]
					.map((line) => JSON.stringify(line))
					.join("\n")}\n`;
				const warnings: string[] = [];
				const startedAt = performance.now();
				const receipt = await captureAndUploadSessionEvidence({
					credentials,
					hookReceivedAt: new Date().toISOString(),
					lifecycle: "checkpoint",
					onWarning: (warning) => warnings.push(warning),
					organizationId: "real-repo-org",
					request: {
						content,
						projectPath: repositoryPath,
						sessionId,
						source: "codex",
						upload_mode: "hook",
					},
					terminalTranscript: false,
				});
				const elapsedMs = Math.round(performance.now() - startedAt);
				assert(receipt);
				const capture = stub.committed.get(receipt.contextId);
				assert(capture);
				expect(await readPendingRepositoryEvidence(configDir)).toEqual([]);
				expect(
					await readdir(join(configDir, "repo-context-spool", "v2")),
				).not.toEqual([]);

				const localContext = capture.manifest.localContext;
				const repositoryRoot = localContext.roots.find(
					(root) => root.id === "repository",
				);
				assert(repositoryRoot);
				const instructionFiles = localContext.entries.filter(
					(entry) =>
						entry.rootId === "repository" &&
						entry.kind === "file" &&
						/^(?:agents|claude)\.md$/iu.test(basename(entry.path)),
				);
				const instructionResults = [];
				for (const entry of instructionFiles) {
					const onDisk = await readFile(
						join(repositoryRoot.absolutePath, entry.path),
					);
					const diskHash = sha256(onDisk);
					if (entry.content?.status === "available") {
						assert(entry.content?.blobId);
						const stored = capture.objects.get(entry.content.blobId);
						assert(stored, `${entry.path} blob was not delivered`);
						// Stored bytes are the file after the context filter (example
						// credentials such as postgres://user:pass@ are redacted).
						const expected = sha256(
							new TextEncoder().encode(
								filterContextText(new TextDecoder().decode(onDisk)).text,
							),
						);
						expect(sha256(stored)).toBe(expected);
						instructionResults.push({
							path: entry.path,
							bytes: onDisk.byteLength,
							stored: "content",
							match: sha256(stored) === expected,
							redactions: entry.content?.secretFilter?.redactedBytes ?? 0,
						});
					} else {
						// Hash-only by capture policy (skill resources, personal files).
						expect(entry.content?.status).toBe("omitted");
						expect(entry.content?.reason).toBe("metadata-only");
						expect(entry.hash).toMatchObject({
							status: "available",
							scope: "source",
						});
						expect(entry.hash?.value).toBe(diskHash);
						instructionResults.push({
							path: entry.path,
							bytes: onDisk.byteLength,
							stored: "source-hash",
							match: entry.hash?.value === diskHash,
						});
					}
				}
				expect(
					instructionResults.some(
						(result) =>
							result.stored === "content" && result.path === "AGENTS.md",
					) ||
						instructionResults.some(
							(result) =>
								result.stored === "content" && result.path === "CLAUDE.md",
						),
				).toBe(true);
				// Every captured file outside the repository (user and parent
				// instructions and their imports, every skill definition, the
				// project's auto-memory, user commands, agents and output styles),
				// and every repository skill definition and personal instruction
				// file, is stored byte for byte as on disk after the secret filter.
				const userFiles: string[] = [];
				const fullContent = (entry: (typeof localContext.entries)[number]) =>
					entry.rootId !== "repository" ||
					entry.categories?.includes("skill-definition") ||
					entry.categories?.includes("skill-resource") ||
					basename(entry.path).toLowerCase().endsWith(".local.md") ||
					/(?:^|\/)\.claude\/rules\//u.test(entry.path) ||
					[".mcp.json", "mcp.json", "mcp-config.json"].includes(
						basename(entry.path).toLowerCase(),
					);
				for (const entry of localContext.entries) {
					if (!fullContent(entry) || entry.kind !== "file") continue;
					if (entry.content?.status !== "available" || !entry.content.blobId)
						continue;
					const root = localContext.roots.find(
						(candidate) => candidate.id === entry.rootId,
					);
					assert(root);
					const onDisk = await readFile(join(root.absolutePath, entry.path));
					// Empty files have no evidence object (objects are non-empty by
					// protocol); their blob ID is the empty content's hash.
					if (onDisk.byteLength === 0) {
						expect(entry.content.blobId).toBe(`sha256:${sha256(onDisk)}`);
						userFiles.push(`${entry.rootId}:${entry.path} (0 B, empty)`);
						continue;
					}
					const stored = capture.objects.get(entry.content.blobId);
					assert(stored, `${entry.rootId}:${entry.path} was not delivered`);
					// What the capture must store: the file on disk after the
					// structural MCP sanitizer (MCP files) and the context filter.
					const diskText = new TextDecoder().decode(onDisk);
					const mcp = [".mcp.json", "mcp.json", "mcp-config.json"].includes(
						basename(entry.path).toLowerCase(),
					)
						? sanitizeMcpText(diskText)
						: null;
					const expected = filterContextText(mcp?.text ?? diskText).text;
					const redacted = expected !== diskText;
					expect(sha256(stored)).toBe(
						sha256(new TextEncoder().encode(expected)),
					);
					userFiles.push(
						`${entry.rootId}:${entry.path} (${onDisk.byteLength} B, sha256 ${redacted ? "match after secret filter" : "match"})`,
					);
				}
				// Every skill definition (observed or not), memory file and user
				// command, agent and output style has its content.
				const contextFiles = localContext.entries.filter(
					(entry) =>
						entry.kind === "file" &&
						(entry.categories?.includes("skill-definition") ||
							entry.rootId === "claude-project-memory" ||
							(entry.rootId === "claude-user-home" &&
								/^(?:commands|agents|output-styles)\//u.test(entry.path))),
				);
				expect(
					contextFiles
						.filter((entry) => entry.content?.status !== "available")
						.map((entry) => `${entry.rootId}:${entry.path}`),
				).toEqual([]);
				const countContext = (
					predicate: (entry: (typeof contextFiles)[number]) => boolean,
				) => contextFiles.filter(predicate).length;
				const contextCounts = {
					skillDefinitions: countContext(
						(entry) => entry.categories?.includes("skill-definition") ?? false,
					),
					memoryFiles: countContext(
						(entry) => entry.rootId === "claude-project-memory",
					),
					userCommandsAgentsStyles: countContext(
						(entry) => entry.rootId === "claude-user-home",
					),
					supportingFiles: localContext.entries.filter(
						(entry) =>
							entry.kind === "file" &&
							entry.content?.status === "available" &&
							((entry.categories?.includes("skill-resource") &&
								!entry.categories.includes("skill-definition")) ||
								/^[^/]+\/[^/]+\/[^/]+\/(?:commands|agents)\//u.test(
									entry.path,
								)),
					).length,
					supportingFilesOverBudget: localContext.entries.filter(
						(entry) =>
							entry.kind === "file" &&
							entry.content?.status === "omitted" &&
							entry.content.reason === "metadata-only" &&
							entry.content.detail?.endsWith("-support-budget"),
					).length,
					rules: localContext.entries.filter(
						(entry) =>
							entry.kind === "file" &&
							entry.content?.status === "available" &&
							(/(?:^|\/)\.claude\/rules\//u.test(entry.path) ||
								(["claude-user-home", "codex-user-home"].includes(
									entry.rootId,
								) &&
									entry.path.startsWith("rules/"))),
					).length,
					personalInstructions: localContext.entries.filter(
						(entry) =>
							entry.kind === "file" &&
							basename(entry.path).toLowerCase().endsWith(".local.md") &&
							entry.content?.status === "available",
					).length,
				};
				// Codex exec-policy rules are captured whenever they exist.
				const codexRules = await readdir(join(codexHome(), "rules")).catch(
					() => [] as string[],
				);
				if (codexRules.length > 0)
					expect(
						localContext.entries.some(
							(entry) =>
								entry.rootId === "codex-user-home" &&
								entry.path.startsWith("rules/") &&
								entry.content?.status === "available",
						),
					).toBe(true);
				const memoryRoot = localContext.roots.find(
					(root) => root.id === "claude-project-memory",
				);
				if (memoryRoot?.status === "collected")
					expect(contextCounts.memoryFiles).toBeGreaterThan(0);
				// The protocol's object and aggregate limits hold with every skill.
				const aggregateBytes = capture.input.objects.reduce(
					(total, object) => total + object.byteLength,
					0,
				);
				expect(capture.input.objects.length).toBeLessThanOrEqual(
					REPOSITORY_EVIDENCE_MAX_OBJECTS,
				);
				expect(aggregateBytes).toBeLessThanOrEqual(
					REPOSITORY_EVIDENCE_MAX_AGGREGATE_BYTES,
				);
				if (await isFile(join(homedir(), ".claude", "CLAUDE.md")))
					expect(
						userFiles.some((file) =>
							file.startsWith("claude-user-home:CLAUDE.md "),
						),
					).toBe(true);
				if (await isFile(join(codexHome(), "AGENTS.md")))
					expect(
						userFiles.some((file) =>
							file.startsWith("codex-user-home:AGENTS.md "),
						),
					).toBe(true);
				if (observedPluginSkill !== null)
					expect(
						userFiles.some((file) =>
							file.startsWith(`claude-plugins:${observedPluginSkill.path} `),
						),
					).toBe(true);
				// No configured credential reaches any delivered object. Only the
				// number of checked values is reported.
				const configuredCredentials = await readConfiguredCredentials();
				const delivered = [...capture.objects.values()].map((bytes) =>
					new TextDecoder().decode(bytes),
				);
				// Report only the setting's name, never its value.
				expect(
					configuredCredentials
						.filter((credential) =>
							delivered.some((text) => text.includes(credential.value)),
						)
						.map((credential) => credential.name),
				).toEqual([]);
				// Only the MCP sections of ~/.claude.json are captured: no account
				// identifier, prompt history or allowed tool from it is delivered.
				const statePrivateValues = await readClaudeStatePrivateValues();
				expect(
					statePrivateValues.filter((value) =>
						delivered.some((text) => text.includes(value)),
					).length,
				).toBe(0);
				const userConfiguration = localContext.userConfiguration;
				assert(userConfiguration);
				const gitWorktrees = execFileSync(
					"git",
					["-C", repositoryPath, "worktree", "list", "--porcelain"],
					{ encoding: "utf8" },
				)
					.split("\n")
					.filter((line) => line.startsWith("worktree ")).length;
				const summary = {
					repository: repositoryPath,
					elapsedMs,
					coverage: Object.fromEntries(
						capture.input.coverage.map((item) => [
							item.area,
							item.reason ? `${item.status}: ${item.reason}` : item.status,
						]),
					),
					facets: capture.manifest.contextIndex.facets.map(
						(facet) =>
							`${facet.rootId}/${facet.kind}: ${facet.presence}/${facet.coverage}`,
					),
					roots: localContext.roots.map((root) => `${root.id}: ${root.status}`),
					gitTruncatedSections: localContext.git.truncatedSections ?? [],
					gitWorktrees: {
						onDisk: gitWorktrees,
						captured: localContext.git.worktrees?.length ?? 0,
					},
					limitsReached: localContext.coverage.limitsReached,
					truncated: localContext.coverage.truncated ?? null,
					objects: capture.input.objects.length,
					aggregateBytes,
					contextCounts,
					redactionCounts: localContext.coverage.redactionCounts ?? {},
					memoryRoot: memoryRoot
						? `${memoryRoot.status}: ${memoryRoot.absolutePath}`
						: null,
					runtime: localContext.runtime ?? null,
					entries: localContext.entries.length,
					instructions: instructionResults,
					userFiles,
					observedPluginSkill: observedPluginSkill?.name ?? null,
					userConfiguration: {
						claudeSettings: userConfiguration.claude.settings.status,
						claudeHooks: userConfiguration.claude.hooks.length,
						claudeEnabledPlugins: Object.keys(
							userConfiguration.claude.enabledPlugins,
						).length,
						claudeInstalledPlugins:
							userConfiguration.claude.installedPlugins.length,
						codexConfig: userConfiguration.codex.config.status,
						codexMcpServers: userConfiguration.codex.mcpServers.length,
						codexHooks: userConfiguration.codex.hooks.length,
						codexPlugins: Object.keys(userConfiguration.codex.plugins).length,
						claudeSettingsLayers: userConfiguration.claude.settingsLayers.map(
							(layer) => `${layer.scope}: ${layer.status}`,
						),
						claudeMcpServers: userConfiguration.claude.mcpServers.map(
							(server) => `${server.scope}:${server.name}`,
						),
						codexFeatures: Object.keys(userConfiguration.codex.features).length,
						codexApps: Object.keys(userConfiguration.codex.apps).length,
					},
					credentialsChecked: configuredCredentials.length,
					claudeStatePrivateValuesChecked: statePrivateValues.length,
					warnings,
				};
				console.log(`REAL_REPO_CAPTURE ${JSON.stringify(summary)}`);
				if (process.env.OPALINE_REAL_REPO_REPORT)
					await writeFile(
						join(
							process.env.OPALINE_REAL_REPO_REPORT,
							`${basename(repositoryPath)}.json`,
						),
						JSON.stringify(summary, null, 2),
					);
				// The one accepted gap: Codex does not persist hook output, so a
				// machine with Codex hooks reports it on effective-instructions.
				expect(
					capture.input.coverage.filter(
						(item) =>
							item.status !== "complete" &&
							!(
								item.area === "effective-instructions" &&
								item.reason?.startsWith("Codex does not persist hook output:")
							),
					),
				).toEqual([]);
				expect(
					capture.manifest.contextIndex.facets.filter(
						(facet) => facet.coverage !== "complete",
					),
				).toEqual([]);
				expect(localContext.git.truncatedSections ?? []).toEqual([]);
				expect(
					localContext.roots.filter(
						(root) => root.status !== "collected" && root.status !== "missing",
					),
				).toEqual([]);
			} finally {
				stub.stop();
			}
		},
	);
});

/** A skill of a user-scoped Claude Code plugin, observed as `plugin:skill`. */
async function findInstalledClaudePluginSkill(): Promise<{
	readonly name: string;
	readonly path: string;
} | null> {
	const cache = join(homedir(), ".claude", "plugins", "cache");
	const installed = await readFile(
		join(homedir(), ".claude", "plugins", "installed_plugins.json"),
		"utf8",
	).catch(() => null);
	if (installed === null) return null;
	const plugins: Record<
		string,
		readonly { readonly scope?: string; readonly installPath?: string }[]
	> = JSON.parse(installed).plugins ?? {};
	for (const [name, installations] of Object.entries(plugins))
		for (const installation of installations) {
			if (installation.scope !== "user" || !installation.installPath) continue;
			const skillsDirectory = join(installation.installPath, "skills");
			const skills = await readdir(skillsDirectory).catch(() => [] as string[]);
			for (const skill of skills.sort())
				if (await isFile(join(skillsDirectory, skill, "SKILL.md")))
					return {
						name: `${name.split("@")[0]}:${skill}`,
						path: `${relative(cache, installation.installPath)}/skills/${skill}/SKILL.md`,
					};
		}
	return null;
}

/**
 * Credentials configured on this machine: every MCP HTTP header value, and
 * environment values whose names denote a credential (paths and versions in
 * other environment variables legitimately appear in manifests).
 */
async function readConfiguredCredentials(): Promise<
	readonly { readonly name: string; readonly value: string }[]
> {
	const credentials: { name: string; value: string }[] = [];
	const credentialName = /token|secret|passw|auth|key|cookie|credential/iu;
	const collect = (
		prefix: string,
		value: unknown,
		onlyCredentialNames: boolean,
	) => {
		if (typeof value !== "object" || value === null) return;
		for (const [name, entry] of Object.entries(value))
			if (
				typeof entry === "string" &&
				entry.length >= 8 &&
				(!onlyCredentialNames || credentialName.test(name))
			)
				credentials.push({ name: `${prefix}.${name}`, value: entry });
	};
	const toml = await readFile(join(codexHome(), "config.toml"), "utf8").catch(
		() => null,
	);
	if (toml !== null) {
		const servers = parseToml(toml).mcp_servers;
		if (typeof servers === "object" && servers !== null)
			for (const [server, configuration] of Object.entries(servers))
				if (typeof configuration === "object" && configuration !== null)
					for (const [key, value] of Object.entries(configuration)) {
						if (key === "http_headers")
							collect(`mcp_servers.${server}.http_headers`, value, false);
						if (key === "env")
							collect(`mcp_servers.${server}.env`, value, true);
					}
	}
	const settings = await readFile(
		join(homedir(), ".claude", "settings.json"),
		"utf8",
	).catch(() => null);
	if (settings !== null) collect("claude.env", JSON.parse(settings).env, true);
	const localSettings = await readFile(
		join(homedir(), ".claude", "settings.local.json"),
		"utf8",
	).catch(() => null);
	if (localSettings !== null)
		collect("claude.local.env", JSON.parse(localSettings).env, false);
	// MCP server environment values and headers in ~/.claude.json.
	const state = await readClaudeState();
	const servers = [
		...Object.entries(state.mcpServers ?? {}),
		...Object.values(state.projects ?? {}).flatMap((project) =>
			Object.entries(project.mcpServers ?? {}),
		),
	];
	for (const [name, server] of servers) {
		collect(`claude.mcpServers.${name}.env`, server.env, false);
		collect(`claude.mcpServers.${name}.headers`, server.headers, false);
	}
	return credentials;
}

interface ClaudeState {
	readonly mcpServers?: Record<string, ClaudeMcpServer>;
	readonly projects?: Record<
		string,
		{
			readonly mcpServers?: Record<string, ClaudeMcpServer>;
			readonly history?: readonly { readonly display?: unknown }[];
			readonly allowedTools?: readonly unknown[];
		}
	>;
	readonly userID?: unknown;
	readonly anonymousId?: unknown;
	readonly oauthAccount?: { readonly emailAddress?: unknown };
}

interface ClaudeMcpServer {
	readonly env?: Record<string, unknown>;
	readonly headers?: Record<string, unknown>;
}

async function readClaudeState(): Promise<ClaudeState> {
	const text = await readFile(join(homedir(), ".claude.json"), "utf8").catch(
		() => null,
	);
	return text === null ? {} : JSON.parse(text);
}

/**
 * Distinctive values from the parts of ~/.claude.json that must never be
 * captured: account identifiers and every project's prompt history and
 * allowed tools. Only their count is reported.
 */
async function readClaudeStatePrivateValues(): Promise<readonly string[]> {
	const state = await readClaudeState();
	const values: string[] = [];
	for (const value of [
		state.userID,
		state.anonymousId,
		state.oauthAccount?.emailAddress,
	])
		if (typeof value === "string" && value.length >= 8) values.push(value);
	for (const project of Object.values(state.projects ?? {})) {
		for (const entry of project.history ?? [])
			if (typeof entry.display === "string" && entry.display.length >= 24)
				values.push(entry.display);
		for (const tool of project.allowedTools ?? [])
			if (typeof tool === "string" && tool.length >= 24) values.push(tool);
	}
	return values;
}

function codexHome(): string {
	const configured = process.env.CODEX_HOME?.trim();
	return configured ? configured : join(homedir(), ".codex");
}

async function isFile(path: string): Promise<boolean> {
	return stat(path)
		.then((details) => details.isFile())
		.catch(() => false);
}

function sha256(value: Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}
