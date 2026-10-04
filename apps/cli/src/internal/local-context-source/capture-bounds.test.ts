import { afterAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	REPOSITORY_EVIDENCE_MAX_OBJECTS,
	RepositoryEvidenceInitInputSchema,
	type RepositoryEvidenceRemoteHint,
} from "../../contracts/index.js";
import {
	createRepositoryBundleCandidate,
	parseGitHubRepositoryRemoteHint,
} from "../../lib/repo-context.js";
import {
	createRepositorySpoolBinding,
	createRepositorySpoolEnv,
	writeRepositoryBundle,
} from "../../lib/repo-spool.js";
import { buildRepositoryEvidenceUpload } from "../../lib/repository-evidence-upload.js";
import { planTranscriptRevision } from "../../lib/transcript-revision.js";
import { extractObservedSkills } from "../../lib/transcript-skills.js";
import { filterKnownSecrets } from "../secret-filter/index.js";
import { buildRepositoryEvidenceIndexRow } from "./__fixtures__/athena-evidence-index.js";
import { addSanitizedTextBlob, createBlobStore } from "./blob-store.js";
import {
	SESSION_CONTEXT_MAX_BLOB_BYTES,
	SESSION_CONTEXT_MAX_BLOBS,
	SESSION_CONTEXT_MAX_ENTRIES,
	SESSION_CONTEXT_MAX_MANIFEST_BYTES,
	SESSION_CONTEXT_MAX_METADATA_LIST_BYTES,
	SESSION_INSTRUCTION_MAX_FILES,
	SESSION_INSTRUCTION_MAX_TOTAL_BYTES,
	SESSION_SKILL_SUPPORT_MAX_BYTES,
	SESSION_USER_CONTEXT_MAX_FILES,
	SESSION_USER_CONTEXT_MAX_TOTAL_BYTES,
} from "./capture-policy.js";
import { collectLocalContextBundle } from "./collector.js";
import { filterContextMetadata } from "./metadata-filter.js";
import { createLocalContextSourceEnv } from "./node-env.js";
import { getDefaultLocalContextCollectionOptions } from "./options.js";
import type { ContextRegularFileEntry, LocalContextBundle } from "./types.js";

const directories: string[] = [];

afterAll(async () => {
	await Promise.all(
		directories.map((directory) =>
			rm(directory, { recursive: true, force: true }),
		),
	);
});

async function createCanaryFixture() {
	const directory = await realpath(
		await mkdtemp(join(tmpdir(), "opaline-capture-bounds-")),
	);
	directories.push(directory);
	const repository = join(directory, "repository");
	const skills = join(directory, "skills");
	await mkdir(join(repository, "docs"), { recursive: true });
	await mkdir(join(repository, ".claude"), { recursive: true });
	await writeFile(join(repository, "AGENTS.md"), "Repository instructions\n");
	await writeFile(
		join(repository, "docs", "CLAUDE.md"),
		"Nested instructions\n",
	);
	await writeFile(
		join(repository, ".claude", "settings.json"),
		'{"permissions":{}}',
	);
	await writeFile(join(repository, ".mcp.json"), '{"mcpServers":{}}');
	await Promise.all(
		Array.from({ length: 1657 }, (_, index) =>
			writeFile(
				join(repository, "docs", `document-${index}.md`),
				`Project documentation ${index}\n`,
			),
		),
	);
	const resourcePaths: string[] = [];
	for (let index = 0; index < 120; index += 1) {
		const name =
			index === 0 ? "cloudflare" : `skill-${String(index).padStart(3, "0")}`;
		await mkdir(join(skills, name), { recursive: true });
		await writeFile(
			join(skills, name, "SKILL.md"),
			`# ${name}\n${"Definition guidance.\n".repeat(300)}`,
		);
	}
	for (let index = 0; index < 2106; index += 1) {
		const name =
			index < 1149
				? "cloudflare"
				: `skill-${String(1 + (index % 119)).padStart(3, "0")}`;
		const subdirectory =
			index < 1149
				? `references/service-${index % 30}`
				: ["rules", "guidelines", "scripts", "assets"][index % 4];
		const path = join(
			skills,
			name,
			subdirectory ?? "assets",
			`resource-${index}.md`,
		);
		await mkdir(join(skills, name, subdirectory ?? "assets"), {
			recursive: true,
		});
		resourcePaths.push(path);
	}
	await Promise.all(
		resourcePaths.map((path, index) =>
			writeFile(
				path,
				`Resource version ${index % 659}\n${"Reference content.\n".repeat(230)}`,
			),
		),
	);
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
			"Clean canary fixture",
		],
	]) {
		execFileSync("git", args, { cwd: repository });
	}
	return { repository, skills };
}

test("bounds a clean canary-shaped capture with every skill definition, budgeted supporting files and no documentation", async () => {
	const fixture = await createCanaryFixture();
	const defaults = getDefaultLocalContextCollectionOptions();
	const bundle = await collectLocalContextBundle(
		fixture.repository,
		{
			...defaults,
			capturePolicy: "session-evidence",
			additionalRoots: [
				{
					id: "claude-user-skills",
					label: "Claude user skills",
					absolutePath: fixture.skills,
					origin: "user",
					scope: "skills",
				},
			],
		},
		createLocalContextSourceEnv(),
	);
	const blobBytes = bundle.blobs.reduce(
		(total, blob) => total + blob.byteLength,
		0,
	);
	const manifestBytes = Buffer.byteLength(JSON.stringify(bundle.manifest));
	const content = '{"type":"event_msg","payload":{"type":"task_complete"}}\n';
	const transcriptRevision = await planTranscriptRevision({
		content: new TextEncoder().encode(content),
		previous: undefined,
		scope: {
			actorId: "fixture-user",
			provider: "codex",
			providerInstanceId: "fixture-codex",
			sessionId: "fixture-session",
		},
		terminal: true,
	});
	const upload = buildRepositoryEvidenceUpload({
		bundle,
		captureLifecycle: "end",
		context: {
			localIdentity: {
				installationId: "11111111-1111-4111-8111-111111111111",
				repositoryId: `local-repository:${"a".repeat(64)}`,
				worktreeId: `local-worktree:${"b".repeat(64)}`,
			},
			remoteHint: null,
		},
		firstActionAt: null,
		firstActionBasis: "unavailable",
		firstActionRelationship: "unknown",
		organizationId: "fixture-workspace",
		session: { content, sessionId: "fixture-session", source: "codex" },
		terminalTranscript: true,
		transcriptLastEventAt: null,
		transcriptRevision,
	});
	const wireManifest = upload.objects.get(upload.input.manifestObjectId);
	if (!wireManifest) throw new Error("Missing manifest object");
	expect(() =>
		buildRepositoryEvidenceIndexRow(
			upload.input,
			JSON.parse(new TextDecoder().decode(wireManifest.bytes)),
			new Date("2026-10-01T00:00:00Z"),
			"fixture-user",
		),
	).not.toThrow();
	const binding = await createRepositorySpoolBinding({
		accountId: "fixture-user",
		apiBaseUrl: "https://example.invalid",
		localIdentity: upload.input.repository.local,
		workspaceId: "fixture-workspace",
	});
	const stored = await writeRepositoryBundle(
		createRepositoryBundleCandidate(bundle),
		binding,
		fixture.repository,
		"end",
		createRepositorySpoolEnv(join(fixture.repository, "..", "spool")),
	);
	expect(stored.capture.integrity).toBe("valid");
	console.log(
		"canary-shaped capture",
		JSON.stringify({
			blobs: bundle.blobs.length,
			blobBytes,
			manifestBytes,
			objects: upload.objects.size,
			wireManifestBytes: wireManifest.bytes.byteLength,
			entries: bundle.manifest.entries.length,
		}),
	);
	if (process.env.OPALINE_CAPTURE_BOUNDS_INPUT)
		await writeFile(
			process.env.OPALINE_CAPTURE_BOUNDS_INPUT,
			JSON.stringify(upload.input),
		);
	// Every content pool stays inside its own bound, and the upload inside
	// the protocol's object and aggregate limits.
	expect(bundle.blobs.length).toBeLessThanOrEqual(
		SESSION_CONTEXT_MAX_BLOBS +
			SESSION_INSTRUCTION_MAX_FILES +
			SESSION_USER_CONTEXT_MAX_FILES,
	);
	expect(blobBytes).toBeLessThanOrEqual(
		SESSION_CONTEXT_MAX_BLOB_BYTES +
			SESSION_INSTRUCTION_MAX_TOTAL_BYTES +
			SESSION_USER_CONTEXT_MAX_TOTAL_BYTES,
	);
	expect(upload.input.objects.length).toBeLessThanOrEqual(
		REPOSITORY_EVIDENCE_MAX_OBJECTS,
	);
	expect(bundle.manifest.entries.length).toBeLessThanOrEqual(
		SESSION_CONTEXT_MAX_ENTRIES,
	);
	expect(manifestBytes).toBeLessThanOrEqual(SESSION_CONTEXT_MAX_MANIFEST_BYTES);
	expect(wireManifest.bytes.byteLength).toBeLessThan(
		SESSION_CONTEXT_MAX_MANIFEST_BYTES + 256 * 1024,
	);
	// Dropping plain inventory to fit the manifest keeps every facet complete,
	// every skill definition in the index and the roots' status unchanged.
	expect(bundle.manifest.contextIndex.skills).toHaveLength(120);
	for (const root of bundle.manifest.roots)
		expect(root.status).toBe("collected");
	for (const facet of bundle.manifest.contextIndex.facets)
		expect(facet.coverage).toBe("complete");
	expect(
		upload.input.coverage.filter((item) => item.status !== "complete"),
	).toEqual([]);
	expect(
		RepositoryEvidenceInitInputSchema.safeParse(upload.input).success,
	).toBe(true);
	expect(bundle.manifest.coverage.truncated).toMatchObject({
		omittedEntries: 4516 - bundle.manifest.entries.length,
		omittedBlobs: 0,
		reason: "capture-limit",
	});
	expect(bundle.manifest.coverage.limitsReached).toContain("maxManifestBytes");
	expect(bundle.manifest.contextIndex.skills.length).toBeGreaterThan(0);
	let definitions = 0;
	for (const entry of bundle.manifest.entries) {
		if (entry.kind !== "file" || !entry.categories.includes("skill-definition"))
			continue;
		definitions += 1;
		expect(entry.content.status).toBe("available");
		expect(entry.hash).toMatchObject({ status: "available", scope: "stored" });
	}
	expect(definitions).toBe(120);
	// Supporting files are captured up to each skill's 1 MiB budget; the
	// 1,149-file skill keeps the rest hash-only by policy.
	const resources = bundle.manifest.entries.filter(
		(entry) =>
			entry.kind === "file" &&
			entry.categories.includes("skill-resource") &&
			!entry.categories.includes("skill-definition"),
	);
	expect(resources.length).toBeGreaterThan(0);
	const capturedBySkill = new Map<string, number>();
	let budgeted = 0;
	for (const entry of resources) {
		if (entry.kind !== "file") continue;
		const skill = `${entry.rootId}:${entry.path.split("/")[0]}`;
		if (entry.content.status === "available") {
			capturedBySkill.set(
				skill,
				(capturedBySkill.get(skill) ?? 0) + entry.content.storedByteLength,
			);
			continue;
		}
		expect(entry.content).toEqual({
			status: "omitted",
			reason: "metadata-only",
			detail: "skill-support-budget",
		});
		expect(entry.hash).toMatchObject({ status: "available", scope: "source" });
		budgeted += 1;
	}
	expect(budgeted).toBeGreaterThan(0);
	for (const bytes of capturedBySkill.values())
		expect(bytes).toBeLessThanOrEqual(SESSION_SKILL_SUPPORT_MAX_BYTES);
	const document = bundle.manifest.entries.find(
		(entry) => entry.path === "docs/document-0.md",
	);
	expect(document?.gitProvenance).toBe("tracked");
	if (document?.kind !== "file")
		throw new Error("Missing documentation metadata");
	expect(document.content.status).toBe("omitted");
	expect(document.hash).toMatchObject({
		status: "available",
		algorithm: "sha256",
		value: createHash("sha256")
			.update("Project documentation 0\n")
			.digest("hex"),
		scope: "source",
	});
	expect(bundle.manifest.coverage.partial).toBe(true);
}, 30_000);

async function createSmallFixture(files: Readonly<Record<string, string>>) {
	const directory = await realpath(
		await mkdtemp(join(tmpdir(), "opaline-capture-policy-")),
	);
	directories.push(directory);
	for (const [path, content] of Object.entries(files)) {
		await mkdir(join(directory, path, ".."), { recursive: true });
		await writeFile(join(directory, path), content);
	}
	return directory;
}

async function buildTestUpload(
	bundle: LocalContextBundle,
	options: {
		content?: string;
		remoteHint?: RepositoryEvidenceRemoteHint | null;
	} = {},
) {
	const content =
		options.content ??
		'{"type":"event_msg","payload":{"type":"task_complete"}}\n';
	const transcriptRevision = await planTranscriptRevision({
		content: new TextEncoder().encode(content),
		previous: undefined,
		scope: {
			actorId: "fixture-user",
			provider: "codex",
			providerInstanceId: "fixture-codex",
			sessionId: "fixture-session",
		},
		terminal: true,
	});
	return buildRepositoryEvidenceUpload({
		bundle,
		captureLifecycle: "end",
		context: {
			localIdentity: {
				installationId: "11111111-1111-4111-8111-111111111111",
				repositoryId: `local-repository:${"a".repeat(64)}`,
				worktreeId: `local-worktree:${"b".repeat(64)}`,
			},
			remoteHint: options.remoteHint ?? null,
		},
		firstActionAt: null,
		firstActionBasis: "unavailable",
		firstActionRelationship: "unknown",
		organizationId: "fixture-workspace",
		session: { content, sessionId: "fixture-session", source: "codex" },
		terminalTranscript: true,
		transcriptLastEventAt: null,
		transcriptRevision,
	});
}

test("generated hash-only and blob-limited resources pass the production Athena indexer", async () => {
	const directory = await createSmallFixture({
		"AGENTS.md": "Root instructions\n",
		"nested/CLAUDE.md": "Nested instructions\n",
		".claude/skills/demo/SKILL.md": "Skill definition\n",
		"package.json": '{"name":"fixture"}',
	});
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
			"Indexer fixture",
		],
	])
		execFileSync("git", args, { cwd: directory });
	const defaults = getDefaultLocalContextCollectionOptions();
	const bundle = await collectLocalContextBundle(
		directory,
		{
			...defaults,
			capturePolicy: "session-evidence",
			limits: { ...defaults.limits, maxInstructionFiles: 1 },
		},
		createLocalContextSourceEnv(),
	);
	expect(fileEntry(bundle, "repository", "package.json").content).toMatchObject(
		{
			status: "omitted",
			reason: "metadata-only",
		},
	);
	expect(
		fileEntry(bundle, "repository", "nested/CLAUDE.md").content,
	).toMatchObject({
		status: "omitted",
		reason: "blob-count-cap",
	});
	const upload = await buildTestUpload(bundle);
	const object = upload.objects.get(upload.input.manifestObjectId);
	if (!object) throw new Error("Missing manifest object");
	const manifest = JSON.parse(new TextDecoder().decode(object.bytes));
	const row = buildRepositoryEvidenceIndexRow(
		upload.input,
		manifest,
		new Date("2026-10-01T00:00:00Z"),
		"fixture-user",
	);
	expect(row.coverage_status).toBe("partial");
	expect(row.available_skills).toEqual(["demo"]);
	expect(
		row.context_facets.find((facet) => facet[0] === "package-context")?.[4],
	).toBe("truncated");
	// Only the facet whose content was cut is truncated; metadata-only content
	// is policy, so package-context and agents-instructions stay complete.
	const facetCoverage = Object.fromEntries(
		row.context_facets
			.filter((facet) => facet[1] === "repository")
			.map((facet) => [facet[0], facet[3]]),
	);
	expect(facetCoverage).toEqual({
		"agents-instructions": "complete",
		"claude-instructions": "truncated",
		hooks: "complete",
		mcp: "complete",
		"package-context": "complete",
		plans: "complete",
	});
	expect(manifest.localContext.coverage.truncated.omittedBlobs).toBe(1);
});

test("captures 309 instruction files whole and reserves top-level ones when the instruction pool is full", async () => {
	const rootPaths = [
		"AGENTS.md",
		"AGENTS.override.md",
		"CLAUDE.md",
		"CLAUDE.project.md",
		".claude/CLAUDE.md",
		".codex/AGENTS.md",
		".agents/AGENTS.md",
		"GEMINI.md",
		".github/copilot-instructions.md",
	];
	const files = Object.fromEntries([
		...rootPaths.map((path) => [path, `Root instructions for ${path}\n`]),
		...Array.from({ length: 300 }, (_, index) => [
			`.claude/nested-${String(index).padStart(3, "0")}/CLAUDE.md`,
			`Nested instructions ${index}\n`,
		]),
	]);
	const directory = await createSmallFixture(files);
	const complete = await collectLocalContextBundle(
		directory,
		{
			...getDefaultLocalContextCollectionOptions(),
			capturePolicy: "session-evidence",
		},
		createLocalContextSourceEnv(),
	);
	expect(complete.blobs).toHaveLength(309);
	expect(complete.manifest.coverage.truncated).toBeUndefined();
	const defaults = getDefaultLocalContextCollectionOptions();
	const bundle = await collectLocalContextBundle(
		directory,
		{
			...defaults,
			capturePolicy: "session-evidence",
			limits: { ...defaults.limits, maxInstructionFiles: 256 },
		},
		createLocalContextSourceEnv(),
	);
	for (const path of rootPaths) {
		const entry = fileEntry(bundle, "repository", path);
		expect(entry.content.status).toBe("available");
		if (entry.content.status !== "available")
			throw new Error("Missing instructions");
		expect(
			bundle.blobs.find((blob) => blob.id === entry.content.blobId)?.content,
		).toBe(files[path]);
	}
	expect(bundle.blobs).toHaveLength(256);
	expect(bundle.manifest.coverage.truncated?.omittedBlobs).toBe(309 - 256);
	expect(bundle.manifest.coverage.limitsReached).toContain(
		"maxInstructionFiles",
	);
});

test("keeps agent-definition Markdown and skill supporting files but not ordinary documentation", async () => {
	const agentPaths = [
		".claude/agents/reviewer.md",
		".codex/agents/reviewer.md",
		".agents/agents/reviewer.md",
	];
	const directory = await createSmallFixture({
		...Object.fromEntries(
			agentPaths.map((path) => [path, `Agent configuration ${path}\n`]),
		),
		".claude/skills/demo/SKILL.md": "Skill definition\n",
		".claude/skills/demo/.claude/agents/resource.md": "Skill supporting file\n",
		".claude/docs/readme.md": "Ordinary documentation\n",
	});
	const bundle = await collectLocalContextBundle(
		directory,
		{
			...getDefaultLocalContextCollectionOptions(),
			capturePolicy: "session-evidence",
		},
		createLocalContextSourceEnv(),
	);
	for (const path of agentPaths) {
		const entry = fileEntry(bundle, "repository", path);
		expect(entry.content.status).toBe("available");
		if (entry.content.status !== "available")
			throw new Error("Missing agent definition");
		expect(
			bundle.blobs.find((blob) => blob.id === entry.content.blobId)?.content,
		).toBe(`Agent configuration ${path}\n`);
	}
	expect(
		fileEntry(
			bundle,
			"repository",
			".claude/skills/demo/.claude/agents/resource.md",
		).content.status,
	).toBe("available");
	expect(
		fileEntry(bundle, "repository", ".claude/docs/readme.md").content,
	).toMatchObject({ status: "omitted", reason: "metadata-only" });
});

test("agent settings and other MCP package files are hash-only even when they contain unknown tokens", async () => {
	const metadataPaths = [
		"docs/private.LOCAL.MD",
		"mcp/server.json",
		"nested/mcp/readme.md",
		".claude/settings.json",
		".claude/settings.local.json",
		"nested/.claude/settings.private.json",
		".codex/config.toml",
		"nested/.codex/config.toml",
		".cursor/settings.json",
		"nested/.cursor/private.json",
	];
	const files = Object.fromEntries(
		metadataPaths.map((path) => [path, `OPAQUE_PRIVATE_CANARY ${path}\n`]),
	);
	const directory = await createSmallFixture({
		...files,
		"AGENTS.md": "Shared instructions\n",
		"CLAUDE.project.md": "Shared project instructions\n",
		"mcp/AGENTS.md": "Instructions inside an MCP package\n",
		"mcp/observed/SKILL.md": "Observed skill inside an MCP package\n",
	});
	const bundle = await collectLocalContextBundle(
		directory,
		{
			...getDefaultLocalContextCollectionOptions(),
			capturePolicy: "session-evidence",
			observedSkillNames: ["observed"],
		},
		createLocalContextSourceEnv(),
	);
	for (const path of metadataPaths) {
		const entry = fileEntry(bundle, "repository", path);
		const content = files[path] ?? "";
		expect(entry.size).toBe(Buffer.byteLength(content));
		expect(entry.content).toEqual({
			status: "omitted",
			reason: "metadata-only",
			detail: null,
		});
		expect(entry.hash).toMatchObject({
			status: "available",
			algorithm: "sha256",
			scope: "source",
			value: createHash("sha256").update(content).digest("hex"),
		});
	}
	for (const path of [
		"AGENTS.md",
		"CLAUDE.project.md",
		"mcp/AGENTS.md",
		"mcp/observed/SKILL.md",
	]) {
		expect(fileEntry(bundle, "repository", path).content.status).toBe(
			"available",
		);
	}
	for (const blob of bundle.blobs) {
		expect(blob.content).not.toContain("OPAQUE_PRIVATE_CANARY");
	}
	expect(bundle.blobs).toHaveLength(4);
	expect(bundle.manifest.coverage.truncated).toBeUndefined();
});

test("repository MCP server files are captured in full, secret-filtered", async () => {
	const secret = `ghp_${"D".repeat(36)}`;
	const servers = (name: string) =>
		`${JSON.stringify(
			{
				mcpServers: {
					[name]: {
						command: "npx",
						args: ["-y", `@example/${name}-server`],
						env: { GITHUB_TOKEN: secret, LOG_LEVEL: "info" },
					},
					docs: { type: "http", url: "https://mcp.example/docs" },
				},
				notes: "Shared MCP servers for this repository. ".repeat(20),
			},
			null,
			2,
		)}\n`;
	const files = {
		".mcp.json": servers("github"),
		"nested/mcp.json": servers("nested"),
		"mcp-config.json": servers("config"),
		".cursor/mcp.json": servers("cursor"),
	};
	const directory = await createSmallFixture({
		...files,
		"AGENTS.md": "Shared instructions\n",
	});
	const bundle = await collectLocalContextBundle(
		directory,
		{
			...getDefaultLocalContextCollectionOptions(),
			capturePolicy: "session-evidence",
		},
		createLocalContextSourceEnv(),
	);
	for (const [path, content] of Object.entries(files)) {
		const entry = fileEntry(bundle, "repository", path);
		expect(entry.content.status).toBe("available");
		if (entry.content.status !== "available") continue;
		const blobId = entry.content.blobId;
		const blob = bundle.blobs.find((candidate) => candidate.id === blobId);
		expect(blob?.content).toBe(filterKnownSecrets(content).text);
		expect(blob?.content).not.toContain(secret);
		expect(entry.content.secretFilter.redactedBytes).toBeGreaterThan(0);
	}
	const mcp = bundle.manifest.contextIndex.facets.find(
		(facet) => facet.rootId === "repository" && facet.kind === "mcp",
	);
	expect(mcp).toMatchObject({ presence: "present", coverage: "complete" });
	expect(
		mcp?.resources.every((resource) => resource.access.status === "readable"),
	).toBe(true);
});

test("personal instruction files are captured in full from the instruction pool, secret-filtered", async () => {
	const secret = `ghp_${"A".repeat(36)}`;
	const personal = {
		"CLAUDE.local.md": `Personal notes for this checkout\n${"Prefer small commits.\n".repeat(40)}Token ${secret}\n`,
		"AGENTS.local.md": "Personal agent notes\n",
		"nested/CLAUDE.local.md": "Nested personal notes\n",
		".claude/CLAUDE.local.md": "Agent-directory personal notes\n",
	};
	const directory = await createSmallFixture({
		...personal,
		"AGENTS.md": "Shared instructions\n",
	});
	const bundle = await collectLocalContextBundle(
		directory,
		{
			...getDefaultLocalContextCollectionOptions(),
			capturePolicy: "session-evidence",
		},
		createLocalContextSourceEnv(),
	);
	for (const [path, content] of Object.entries(personal)) {
		const entry = fileEntry(bundle, "repository", path);
		expect(entry.content.status).toBe("available");
		if (entry.content.status !== "available") continue;
		const blobId = entry.content.blobId;
		const blob = bundle.blobs.find((candidate) => candidate.id === blobId);
		expect(blob?.content).toBe(filterKnownSecrets(content).text);
		expect(blob?.content).not.toContain(secret);
	}
	const filtered = fileEntry(bundle, "repository", "CLAUDE.local.md");
	expect(filtered.content.status).toBe("available");
	if (filtered.content.status === "available")
		expect(filtered.content.secretFilter.redactedBytes).toBeGreaterThan(0);
	for (const facet of bundle.manifest.contextIndex.facets)
		expect(facet.coverage).toBe("complete");
});

test("does not walk dependency, generated or cache directories", async () => {
	const skippedDirectories = [
		".venv",
		"venv",
		"__pycache__",
		".wrangler",
		".terraform",
		".gradle",
		".mypy_cache",
		".pytest_cache",
		".parcel-cache",
	];
	const directory = await createSmallFixture({
		"AGENTS.md": "Instructions\n",
		...Object.fromEntries(
			skippedDirectories.map((name) => [
				`nested/${name}/private.md`,
				"SKIPPED_CANARY\n",
			]),
		),
	});
	const env = createLocalContextSourceEnv();
	const walked: string[] = [];
	const bundle = await collectLocalContextBundle(
		directory,
		{
			...getDefaultLocalContextCollectionOptions(),
			capturePolicy: "session-evidence",
		},
		{
			...env,
			fileSystem: {
				...env.fileSystem,
				readDirectory: async (path, maxEntries) => {
					walked.push(path);
					return env.fileSystem.readDirectory(path, maxEntries);
				},
			},
		},
	);
	expect(walked.sort()).toEqual([directory, join(directory, "nested")].sort());
	expect(bundle.manifest.entries.map((entry) => entry.path)).toEqual([
		"AGENTS.md",
		"nested",
	]);
	expect(
		bundle.manifest.coverage.excludedPaths.map((entry) => entry.path).sort(),
	).toEqual(skippedDirectories.map((name) => `nested/${name}`).sort());
});

test.each(
	(["delta", "session-evidence"] as const).flatMap((capturePolicy) => [
		[capturePolicy, "github-pat", `ghp_${"A".repeat(36)}`] as const,
		[capturePolicy, "npm-access-token", `npm_${"a".repeat(36)}`] as const,
	]),
)(
	"redacts tokens in exported filenames, directory names and every path reference (%s, %s)",
	async (capturePolicy, ruleId, token) => {
		const redactedToken = filterContextMetadata(token);
		expect(redactedToken).not.toBe(token);
		const paths = [
			ruleId === "github-pat" ? `docs/${token}.md` : `docs/${token}/CLAUDE.md`,
			`${token}/AGENTS.md`,
			`.claude/skills/${token}/SKILL.md`,
		];
		const directory = await createSmallFixture({
			...Object.fromEntries(
				paths.map((path, index) => [path, `Fixture content ${index}\n`]),
			),
			[`${token}/node_modules/excluded.md`]: "Excluded dependency\n",
		});
		execFileSync("git", ["init", "-q"], { cwd: directory });
		execFileSync("git", ["add", "."], { cwd: directory });
		const bundle = await collectLocalContextBundle(
			directory,
			{
				...getDefaultLocalContextCollectionOptions(),
				capturePolicy,
			},
			createLocalContextSourceEnv(),
		);
		expect(JSON.stringify(bundle.manifest)).not.toContain(token);
		for (const path of paths) {
			const exportedPath = filterContextMetadata(path);
			const entry = fileEntry(bundle, "repository", exportedPath);
			expect(entry.name).toBe(exportedPath.split("/").at(-1) ?? "");
			expect(entry.parentPath).toBe(
				exportedPath.split("/").slice(0, -1).join("/"),
			);
			expect(bundle.manifest.documents.markdown).toContainEqual({
				rootId: "repository",
				path: exportedPath,
			});
			if (bundle.manifest.git.status !== "available")
				throw new Error("Missing Git snapshot");
			expect(
				bundle.manifest.git.statusEntries.some(
					(status) => status.path === exportedPath,
				),
			).toBe(true);
		}
		const skill = bundle.manifest.contextIndex.skills[0];
		expect(skill?.name).toBe(redactedToken);
		expect(skill?.definitions[0]?.path).toBe(
			`.claude/skills/${redactedToken}/SKILL.md`,
		);
		expect(
			bundle.manifest.contextIndex.facets.flatMap((facet) => facet.resources),
		).toContainEqual({
			rootId: "repository",
			path: `${redactedToken}/AGENTS.md`,
			access: { status: "readable" },
		});
		expect(
			bundle.manifest.coverage.excludedPaths.some(
				(entry) => entry.path === `${redactedToken}/node_modules`,
			),
		).toBe(true);
		const upload = await buildTestUpload(bundle);
		const object = upload.objects.get(upload.input.manifestObjectId);
		if (!object) throw new Error("Missing manifest object");
		const wireManifest = new TextDecoder().decode(object.bytes);
		expect(wireManifest).not.toContain(token);
		const indexed = buildRepositoryEvidenceIndexRow(
			upload.input,
			JSON.parse(wireManifest),
			new Date("2026-10-01T00:00:00Z"),
			"fixture-user",
		);
		expect(indexed.available_skills).toEqual([redactedToken]);
		const legacyUpload = await buildTestUpload({
			...bundle,
			manifest: JSON.parse(
				JSON.stringify(bundle.manifest).replaceAll(redactedToken, token),
			),
		});
		expect(legacyUpload.input.manifestObjectId).toBe(
			upload.input.manifestObjectId,
		);
	},
);

test("redacts a GitHub token used as the outbound remote repository name", async () => {
	const token = `ghp_${"A".repeat(36)}`;
	const directory = await createSmallFixture({ "AGENTS.md": "Instructions\n" });
	const bundle = await collectLocalContextBundle(
		directory,
		getDefaultLocalContextCollectionOptions(),
		createLocalContextSourceEnv(),
	);
	const remoteHint = parseGitHubRepositoryRemoteHint(
		`git@github.com:fixture/${token}.git`,
	);
	expect(remoteHint?.name).toBe(token);
	const upload = await buildTestUpload(bundle, { remoteHint });
	expect(JSON.stringify(upload.input)).not.toContain(token);
	expect(upload.input.repository.remoteHint).toEqual(
		filterContextMetadata(remoteHint),
	);
	expect(upload.input.repository.remoteHint?.name).toBe(
		`[REDACTED:github-pat:${createHash("sha256").update(token).digest("hex").slice(0, 12)}]`,
	);
	expect(
		RepositoryEvidenceInitInputSchema.safeParse(upload.input).success,
	).toBe(true);
});

test.each(["delta", "session-evidence"] as const)(
	"keeps two distinct token-named directories as two skills with consistent usage (%s)",
	async (capturePolicy) => {
		const tokens = [`ghp_${"A".repeat(36)}`, `ghp_${"B".repeat(36)}`];
		const directory = await createSmallFixture(
			Object.fromEntries(
				tokens.map((token, index) => [
					`.claude/skills/${token}/SKILL.md`,
					`Skill definition ${index}\n`,
				]),
			),
		);
		const bundle = await collectLocalContextBundle(
			directory,
			{ ...getDefaultLocalContextCollectionOptions(), capturePolicy },
			createLocalContextSourceEnv(),
		);
		expect(bundle.manifest.contextIndex.skills).toHaveLength(2);
		const names = tokens.map(filterContextMetadata);
		expect(new Set(names).size).toBe(2);
		for (const name of names) {
			const path = `.claude/skills/${name}/SKILL.md`;
			expect(fileEntry(bundle, "repository", path).parentPath).toBe(
				`.claude/skills/${name}`,
			);
			expect(
				bundle.manifest.contextIndex.skills.find((skill) => skill.name === name)
					?.definitions,
			).toMatchObject([{ rootId: "repository", path }]);
		}
		const upload = await buildTestUpload(bundle, {
			content: `${JSON.stringify({
				type: "response_item",
				payload: {
					type: "function_call",
					name: "Skill",
					arguments: JSON.stringify({ skill: tokens[0] }),
				},
			})}\n`,
		});
		const object = upload.objects.get(upload.input.manifestObjectId);
		if (!object) throw new Error("Missing manifest object");
		const wireManifest = new TextDecoder().decode(object.bytes);
		for (const token of tokens) expect(wireManifest).not.toContain(token);
		const manifest = JSON.parse(wireManifest);
		expect(manifest.contextIndex.skills).toHaveLength(2);
		expect(manifest.contextIndex.skills).toContainEqual(
			expect.objectContaining({
				name: names[0],
				use: expect.objectContaining({ status: "observed-used" }),
			}),
		);
		expect(manifest.contextIndex.skills).toContainEqual(
			expect.objectContaining({
				name: names[1],
				use: expect.objectContaining({ status: "unknown" }),
			}),
		);
		const indexed = buildRepositoryEvidenceIndexRow(
			upload.input,
			manifest,
			new Date("2026-10-01T00:00:00Z"),
			"fixture-user",
		);
		expect(indexed.available_skills).toHaveLength(2);
		expect([...indexed.available_skills].sort()).toEqual([...names].sort());
	},
);

function fileEntry(
	bundle: LocalContextBundle,
	rootId: string,
	path: string,
): ContextRegularFileEntry {
	const entry = bundle.manifest.entries.find(
		(entry) => entry.rootId === rootId && entry.path === path,
	);
	if (entry?.kind !== "file") throw new Error(`Missing ${rootId}:${path}`);
	return entry;
}

test.each([1, 2, 3, 4, 5])(
	"captures instructions from their own pool, then every skill (observed first) from the user-context pool at a %i-file cap",
	async (maxUserContextFiles) => {
		const directory = await createSmallFixture({
			"repo/AGENTS.md": "Root instructions\n",
			"repo/nested/CLAUDE.md": "Nested instructions\n",
			"repo/nested/CLAUDE.local.md": "Private local instructions\n",
			"repo/.claude/skills/repo-skill/SKILL.md": "Repository skill\n",
			"repo/.claude/settings.json": '{"permissions":{"allow":[]}}',
			"repo/.claude/agents/reviewer.md": "Agent definition\n",
			"skills-a/aaa-unused/SKILL.md": "Unused skill\n",
			"skills-z/zzz-observed/SKILL.md": "Observed skill\n",
			"skills-codex/private/SKILL.md": "Private Codex skill\n",
			"skills-agents/private/SKILL.md": "Private shared skill\n",
		});
		const defaults = getDefaultLocalContextCollectionOptions();
		const observedSkillNames = extractObservedSkills({
			content:
				'{"type":"response_item","payload":{"type":"function_call","name":"exec_command","arguments":"{\\"cmd\\":\\"cat /skills/zzz-observed/SKILL.md\\"}"}}\n',
			subagents: [
				{
					content:
						'{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Skill","input":{"skill":"subagent-observed"}}]}}\n',
				},
			],
		});
		expect(observedSkillNames).toEqual(["subagent-observed", "zzz-observed"]);
		const options = {
			...defaults,
			capturePolicy: "session-evidence" as const,
			observedSkillNames: [...observedSkillNames, "repo-skill"],
			limits: { ...defaults.limits, maxUserContextFiles },
			additionalRoots: ["a", "z", "codex", "agents"].map((suffix) => ({
				id: `skills-${suffix}`,
				label: `Skills ${suffix}`,
				absolutePath: join(directory, `skills-${suffix}`),
				origin: "user" as const,
				scope: "skills" as const,
			})),
		};
		const env = {
			...createLocalContextSourceEnv(),
			now: () => new Date("2026-10-01T00:00:00Z"),
			createCaptureId: () => "22222222-2222-4222-8222-222222222222",
		};
		const bundle = await collectLocalContextBundle(
			join(directory, "repo"),
			options,
			env,
		);
		// Instructions, including personal ones, come from their own pool; the
		// agent definition from the general pool. Neither competes with skills.
		for (const path of [
			"AGENTS.md",
			"nested/CLAUDE.md",
			"nested/CLAUDE.local.md",
			".claude/agents/reviewer.md",
		]) {
			const entry = fileEntry(bundle, "repository", path);
			expect(entry.content.status).toBe("available");
			expect(entry.hash.status).toBe("available");
		}
		const skillOrder = [
			["repository", ".claude/skills/repo-skill/SKILL.md"],
			["skills-z", "zzz-observed/SKILL.md"],
			["skills-a", "aaa-unused/SKILL.md"],
			["skills-agents", "private/SKILL.md"],
			["skills-codex", "private/SKILL.md"],
		] as const;
		for (const [index, [rootId, path]] of skillOrder.entries()) {
			const entry = fileEntry(bundle, rootId, path);
			expect(entry.content).toMatchObject(
				index < maxUserContextFiles
					? { status: "available" }
					: { status: "omitted", reason: "blob-count-cap" },
			);
			expect(entry.hash.status).toBe("available");
		}
		expect(
			fileEntry(bundle, "repository", ".claude/settings.json").content,
		).toMatchObject({ status: "omitted", reason: "metadata-only" });
		expect(bundle.blobs).toHaveLength(
			4 + Math.min(maxUserContextFiles, skillOrder.length),
		);
		if (maxUserContextFiles < skillOrder.length) {
			expect(bundle.manifest.coverage.truncated).toEqual({
				omittedBlobs: skillOrder.length - maxUserContextFiles,
				omittedEntries: 0,
				reason: "capture-limit",
			});
			expect(bundle.manifest.coverage.limitsReached).toContain(
				"maxUserContextFiles",
			);
		} else expect(bundle.manifest.coverage.truncated).toBeUndefined();
		const repeat = await collectLocalContextBundle(
			join(directory, "repo"),
			{ ...options, additionalRoots: [...options.additionalRoots].reverse() },
			env,
		);
		expect(repeat).toEqual(bundle);
	},
);

test("counts stored UTF-8 bytes and unique blobs at the byte boundary", () => {
	const store = createBlobStore(null, 256, 10);
	expect(addSanitizedTextBlob("ééé", 6, store).status).toBe("available");
	expect(addSanitizedTextBlob("ééé", 6, store).status).toBe("available");
	expect(store.materializedBytes).toBe(6);
	expect(addSanitizedTextBlob("🙂", 4, store).status).toBe("available");
	expect(store.materializedBytes).toBe(10);
	expect(addSanitizedTextBlob("x", 1, store)).toMatchObject({
		status: "failure",
		reason: "total-content-cap",
	});
	expect(store.blobs.size).toBe(2);
});

test("Git patches have their own pool and are cut only by their own limit", async () => {
	const directory = await createSmallFixture({
		"AGENTS.md": "Original instructions\n",
		".claude/skills/demo/SKILL.md": "Definition\n",
		".claude/settings.json": '{"permissions":{}}',
	});
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
			"Patch fixture",
		],
	])
		execFileSync("git", args, { cwd: directory });
	await writeFile(join(directory, "AGENTS.md"), "Changed instructions\n");
	const defaults = getDefaultLocalContextCollectionOptions();
	const bundle = await collectLocalContextBundle(
		directory,
		{
			...defaults,
			capturePolicy: "session-evidence",
			observedSkillNames: ["demo"],
			limits: { ...defaults.limits, maxBlobs: 1 },
		},
		createLocalContextSourceEnv(),
	);
	expect(bundle.blobs).toHaveLength(3);
	expect(fileEntry(bundle, "repository", "AGENTS.md").content.status).toBe(
		"available",
	);
	expect(
		fileEntry(bundle, "repository", ".claude/skills/demo/SKILL.md").content
			.status,
	).toBe("available");
	expect(
		fileEntry(bundle, "repository", ".claude/settings.json").content.status,
	).toBe("omitted");
	if (bundle.manifest.git.status !== "available")
		throw new Error("Missing Git metadata");
	const workingDiff = bundle.manifest.git.diffs.find(
		(diff) => diff.kind === "working-tree",
	);
	expect(workingDiff?.blobId).not.toBeNull();
	expect(bundle.manifest.coverage.truncated).toBeUndefined();
	const patchLimited = await collectLocalContextBundle(
		directory,
		{
			...defaults,
			capturePolicy: "session-evidence",
			observedSkillNames: ["demo"],
			limits: { ...defaults.limits, maxDiffContentBytes: 8 },
		},
		createLocalContextSourceEnv(),
	);
	if (patchLimited.manifest.git.status !== "available")
		throw new Error("Missing Git metadata");
	expect(
		patchLimited.manifest.git.diffs.find(
			(diff) => diff.kind === "working-tree",
		),
	).toMatchObject({
		blobId: null,
		omissionReason: "total-content-cap",
		reconstructable: false,
	});
	expect(patchLimited.blobs).toHaveLength(2);
	expect(patchLimited.manifest.coverage.truncated).toMatchObject({
		omittedBlobs: 1,
		reason: "capture-limit",
	});
	// The patch cut leaves every facet complete.
	for (const facet of patchLimited.manifest.contextIndex.facets)
		expect(facet.coverage).toBe("complete");
});

test("enforces the exact 2 MiB general-content boundary after instructions and skills and hashes omitted content", async () => {
	const files = Object.fromEntries([
		...Array.from({ length: 4 }, (_, index) => [
			`.claude/agents/big-${index}.md`,
			`${index}${"w".repeat(512 * 1024 - 1)}`,
		]),
		...Array.from({ length: 4 }, (_, index) => [
			`.claude/skills/observed-${index}/SKILL.md`,
			`${index}${"x".repeat(512 * 1024 - 1)}`,
		]),
		...Array.from({ length: 4 }, (_, index) => [
			`nested-${index}/AGENTS.md`,
			`${index}${"y".repeat(512 * 1024 - 1)}`,
		]),
	]);
	const directory = await createSmallFixture({
		...files,
		".claude/agents/reviewer.md": "Agent definition\n",
		".claude/settings.json": '{"permissions":{}}',
	});
	const bundle = await collectLocalContextBundle(
		directory,
		{
			...getDefaultLocalContextCollectionOptions(),
			capturePolicy: "session-evidence",
			observedSkillNames: [0, 1, 2, 3].map((index) => `observed-${index}`),
		},
		createLocalContextSourceEnv(),
	);
	// Four 512 KiB instruction files come from the instruction pool and four
	// 512 KiB skills from the user-context pool; four 512 KiB agent
	// definitions fill the 2 MiB general pool exactly.
	expect(bundle.blobs).toHaveLength(12);
	expect(bundle.blobs.reduce((total, blob) => total + blob.byteLength, 0)).toBe(
		6 * 1024 * 1024,
	);
	for (const path of [".claude/agents/reviewer.md", ".claude/settings.json"]) {
		const entry = fileEntry(bundle, "repository", path);
		expect(entry.content).toMatchObject({
			status: "omitted",
			reason:
				path === ".claude/settings.json"
					? "metadata-only"
					: "total-content-cap",
		});
		expect(entry.hash).toMatchObject({
			status: "available",
			algorithm: "sha256",
			scope: "source",
		});
	}
	expect(bundle.manifest.coverage.truncated).toEqual({
		omittedEntries: 0,
		omittedBlobs: 1,
		reason: "capture-limit",
	});
	expect(bundle.manifest.coverage.limitsReached).toContain(
		"maxTotalContentBytes",
	);
	for (const facet of bundle.manifest.contextIndex.facets)
		expect(facet.coverage).toBe("complete");
});

async function createSkillResourceFixture(): Promise<string> {
	const directory = await createSmallFixture({
		"AGENTS.md": "Repository instructions\n",
		".claude/skills/demo/SKILL.md": "Definition\n",
		".claude/skills/demo/references/AGENTS.md": "Resource instructions\n",
		".claude/skills/demo/rules/rule.md": "Rules\n",
		".claude/skills/demo/guidelines/guidance.md": "Guidance\n",
		".claude/skills/demo/scripts/run.sh": "echo hello\n",
		".claude/skills/demo/assets/image.png": "\0bitmap",
		".claude/skills/demo/config.json": '{"resource":true}',
		".claude/skills/demo/.env": "HIGH_RISK_CANARY",
		".claude/skills/demo/node_modules/ignored.md": "Dependency canary",
		"docs/reference.md": "Documentation\n",
	});
	execFileSync("git", ["init", "-q"], { cwd: directory });
	execFileSync("git", ["add", "."], { cwd: directory });
	execFileSync(
		"git",
		[
			"-c",
			"user.name=Fixture",
			"-c",
			"user.email=fixture@example.com",
			"commit",
			"-qm",
			"Metadata fixture",
		],
		{ cwd: directory },
	);
	return directory;
}

test.each([[["demo"]], [[]]])(
	"supporting files of every skill are captured in full, except binaries, high-risk files and dependencies (observed %j)",
	async (observedSkillNames) => {
		const directory = await createSkillResourceFixture();
		const bundle = await collectLocalContextBundle(
			directory,
			{
				...getDefaultLocalContextCollectionOptions(),
				capturePolicy: "session-evidence",
				observedSkillNames,
			},
			createLocalContextSourceEnv(),
		);
		for (const path of [
			".claude/skills/demo/SKILL.md",
			".claude/skills/demo/references/AGENTS.md",
			".claude/skills/demo/rules/rule.md",
			".claude/skills/demo/guidelines/guidance.md",
			".claude/skills/demo/scripts/run.sh",
			".claude/skills/demo/config.json",
		])
			expect(fileEntry(bundle, "repository", path).content.status).toBe(
				"available",
			);
		expect(
			fileEntry(bundle, "repository", ".claude/skills/demo/assets/image.png")
				.content,
		).toMatchObject({ status: "omitted", reason: "binary" });
		expect(
			fileEntry(bundle, "repository", ".claude/skills/demo/.env").content,
		).toMatchObject({ status: "omitted", reason: "high-risk-path" });
		expect(
			fileEntry(bundle, "repository", "docs/reference.md").content,
		).toMatchObject({ status: "omitted", reason: "metadata-only" });
		for (const blob of bundle.blobs)
			expect(blob.content).not.toContain("HIGH_RISK_CANARY");
		expect(bundle.blobs).toHaveLength(7);
		expect(
			bundle.manifest.entries.some((entry) =>
				entry.path.includes("node_modules"),
			),
		).toBe(false);
	},
);

test("supporting files stop at their skill's budget, larger for skills the session used", async () => {
	const resource = (index: number) => `${index}${"r".repeat(400 * 1024 - 1)}`;
	const directory = await createSmallFixture({
		"AGENTS.md": "Instructions\n",
		...Object.fromEntries(
			["used", "unused"].flatMap((skill) => [
				[`.claude/skills/${skill}/SKILL.md`, `# ${skill}\n`],
				...[0, 1, 2, 3].map((index) => [
					`.claude/skills/${skill}/references/part-${index}.md`,
					resource(index + (skill === "used" ? 10 : 0)),
				]),
			]),
		),
	});
	const bundle = await collectLocalContextBundle(
		directory,
		{
			...getDefaultLocalContextCollectionOptions(),
			capturePolicy: "session-evidence",
			observedSkillNames: ["used"],
		},
		createLocalContextSourceEnv(),
	);
	const status = (skill: string, index: number) =>
		fileEntry(
			bundle,
			"repository",
			`.claude/skills/${skill}/references/part-${index}.md`,
		).content;
	// 1 MiB for a skill the session did not use: two 400 KiB files fit.
	expect([0, 1, 2, 3].map((index) => status("unused", index).status)).toEqual([
		"available",
		"available",
		"omitted",
		"omitted",
	]);
	expect(status("unused", 2)).toEqual({
		status: "omitted",
		reason: "metadata-only",
		detail: "skill-support-budget",
	});
	// 4 MiB for a skill it used: all four fit.
	for (const index of [0, 1, 2, 3])
		expect(status("used", index).status).toBe("available");
	// A budget is policy, not a capacity cut: nothing is truncated.
	expect(bundle.manifest.coverage.truncated).toBeUndefined();
	for (const facet of bundle.manifest.contextIndex.facets)
		expect(facet.coverage).toBe("complete");
});

test("large Git and exclusion inventories cannot escape the manifest byte bound", async () => {
	const directory = await createSmallFixture({ "AGENTS.md": "Instructions\n" });
	await Promise.all(
		Array.from({ length: 2200 }, (_, index) =>
			writeFile(join(directory, `untracked-${index}.md`), "metadata"),
		),
	);
	execFileSync("git", ["init", "-q"], { cwd: directory });
	const bundle = await collectLocalContextBundle(
		directory,
		{
			...getDefaultLocalContextCollectionOptions(),
			capturePolicy: "session-evidence",
			excludedPathPrefixes: Array.from(
				{ length: 2200 },
				(_, index) => `untracked-${index}.md`,
			),
		},
		createLocalContextSourceEnv(),
	);
	expect(
		Buffer.byteLength(JSON.stringify(bundle.manifest)),
	).toBeLessThanOrEqual(SESSION_CONTEXT_MAX_MANIFEST_BYTES);
	expect(bundle.manifest.coverage.truncated?.omittedMetadata).toBeGreaterThan(
		0,
	);
	// Each overflowing list is trimmed on its own and named; nothing else is
	// marked truncated.
	expect(bundle.manifest.coverage.limitsReached).toEqual(
		expect.arrayContaining([
			"metadata:excludedPaths",
			"metadata:git.statusEntries",
		]),
	);
	expect(
		Buffer.byteLength(JSON.stringify(bundle.manifest.coverage.excludedPaths)),
	).toBeLessThanOrEqual(SESSION_CONTEXT_MAX_METADATA_LIST_BYTES);
	expect(bundle.manifest.roots.map((root) => root.status)).toEqual([
		"collected",
	]);
	if (bundle.manifest.git.status !== "available")
		throw new Error("Missing Git metadata");
	expect(bundle.manifest.git.truncatedSections).toEqual([]);
	for (const facet of bundle.manifest.contextIndex.facets)
		expect(facet.coverage).toBe("complete");
	expect(fileEntry(bundle, "repository", "AGENTS.md").content.status).toBe(
		"available",
	);
}, 30_000);
