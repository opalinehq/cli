import { afterAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RepositoryEvidenceInitInputSchema } from "../../contracts/index.js";
import { createRepositoryBundleCandidate } from "../../lib/repo-context.js";
import {
	createRepositorySpoolBinding,
	createRepositorySpoolEnv,
	writeRepositoryBundle,
} from "../../lib/repo-spool.js";
import { buildRepositoryEvidenceUpload } from "../../lib/repository-evidence-upload.js";
import { planTranscriptRevision } from "../../lib/transcript-revision.js";
import { extractObservedSkills } from "../../lib/transcript-skills.js";
import { addSanitizedTextBlob, createBlobStore } from "./blob-store.js";
import { collectLocalContextBundle } from "./collector.js";
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

test("bounds a clean canary-shaped capture without uploading skill resources or documentation", async () => {
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
	expect(bundle.blobs.length).toBeLessThanOrEqual(256);
	expect(blobBytes).toBeLessThanOrEqual(2 * 1024 * 1024);
	expect(bundle.manifest.entries.length).toBeLessThanOrEqual(2000);
	expect(manifestBytes).toBeLessThan(512 * 1024);
	expect(wireManifest.bytes.byteLength).toBeLessThan(512 * 1024);
	expect(
		RepositoryEvidenceInitInputSchema.safeParse(upload.input).success,
	).toBe(true);
	expect(bundle.manifest.coverage.truncated).toMatchObject({
		omittedEntries: 4516 - bundle.manifest.entries.length,
		omittedBlobs: 0,
		reason: "capture-limit",
	});
	expect(bundle.manifest.coverage.limitsReached).toContain(
		"maxManifestEntries",
	);
	expect(bundle.manifest.coverage.limitsReached).toContain("maxManifestBytes");
	expect(bundle.manifest.coverage.contentFiles).toBe(124);
	expect(bundle.manifest.contextIndex.skills).toHaveLength(120);
	expect(bundle.blobs).toHaveLength(124);
	const resources = bundle.manifest.entries.filter(
		(entry) =>
			entry.kind === "file" &&
			entry.categories.includes("skill-resource") &&
			!entry.categories.includes("skill-definition"),
	);
	expect(resources.length).toBeGreaterThan(0);
	for (const entry of resources) {
		if (entry.kind !== "file") continue;
		expect(entry.content.status).toBe("omitted");
		expect(entry.hash.status).toBe("available");
		if (entry.hash.status !== "available") continue;
		expect(entry.hash.algorithm).toBe("sha256");
		expect(entry.hash.scope).toBe("source");
	}
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

test.each([2, 3, 4, 5, 6])(
	"prioritizes repository instructions, observed skills across roots, other skills, then configs at a %i-blob cap",
	async (maxBlobs) => {
		const directory = await createSmallFixture({
			"repo/AGENTS.md": "Root instructions\n",
			"repo/nested/CLAUDE.local.md": "Nested local instructions\n",
			"repo/.claude/skills/repo-skill/SKILL.md": "Repository skill\n",
			"repo/.claude/settings.json": '{"permissions":{"allow":[]}}',
			"skills-a/aaa-unused/SKILL.md": "Unused skill\n",
			"skills-z/zzz-observed/SKILL.md": "Observed skill\n",
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
			observedSkillNames,
			limits: { ...defaults.limits, maxBlobs },
			additionalRoots: ["a", "z"].map((suffix) => ({
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
		const priority = [
			["repository", "AGENTS.md"],
			["repository", "nested/CLAUDE.local.md"],
			["skills-z", "zzz-observed/SKILL.md"],
			["repository", ".claude/skills/repo-skill/SKILL.md"],
			["skills-a", "aaa-unused/SKILL.md"],
			["repository", ".claude/settings.json"],
		] as const;
		for (const [index, [rootId, path]] of priority.entries()) {
			const entry = fileEntry(bundle, rootId, path);
			expect(entry.content.status).toBe(
				index < maxBlobs ? "available" : "omitted",
			);
			expect(entry.hash.status).toBe("available");
		}
		expect(bundle.blobs).toHaveLength(maxBlobs);
		if (maxBlobs < 6)
			expect(bundle.manifest.coverage.truncated).toEqual({
				omittedBlobs: 6 - maxBlobs,
				omittedEntries: 0,
				reason: "capture-limit",
			});
		else expect(bundle.manifest.coverage.truncated).toBeUndefined();
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

test("Git patches use only capacity left after instructions, skill definitions and configs", async () => {
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
			limits: { ...defaults.limits, maxBlobs: 2 },
		},
		createLocalContextSourceEnv(),
	);
	expect(bundle.blobs).toHaveLength(2);
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
	expect(
		bundle.manifest.git.diffs.find((diff) => diff.kind === "working-tree"),
	).toMatchObject({
		blobId: null,
		omissionReason: "blob-count-cap",
		reconstructable: false,
	});
	expect(bundle.manifest.coverage.truncated).toMatchObject({
		omittedBlobs: 2,
		reason: "capture-limit",
	});
	const complete = await collectLocalContextBundle(
		directory,
		{ ...defaults, capturePolicy: "session-evidence" },
		createLocalContextSourceEnv(),
	);
	expect(complete.blobs).toHaveLength(4);
	expect(complete.manifest.coverage.truncated).toBeUndefined();
});

test("enforces the exact 2 MiB byte boundary before skills and configs and hashes omitted content", async () => {
	const files = Object.fromEntries(
		Array.from({ length: 4 }, (_, index) => [
			`nested-${index}/AGENTS.md`,
			`${index}${"x".repeat(512 * 1024 - 1)}`,
		]),
	);
	const directory = await createSmallFixture({
		...files,
		".claude/skills/observed/SKILL.md": "Observed definition\n",
		".mcp.json": '{"mcpServers":{}}',
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
	expect(bundle.blobs).toHaveLength(4);
	expect(bundle.blobs.reduce((total, blob) => total + blob.byteLength, 0)).toBe(
		2 * 1024 * 1024,
	);
	for (const path of [".claude/skills/observed/SKILL.md", ".mcp.json"]) {
		const entry = fileEntry(bundle, "repository", path);
		expect(entry.content).toMatchObject({
			status: "omitted",
			reason: "total-content-cap",
		});
		expect(entry.hash).toMatchObject({
			status: "available",
			algorithm: "sha256",
			scope: "source",
		});
	}
	expect(bundle.manifest.coverage.truncated).toEqual({
		omittedEntries: 0,
		omittedBlobs: 2,
		reason: "capture-limit",
	});
	expect(bundle.manifest.coverage.limitsReached).toContain(
		"maxTotalContentBytes",
	);
});

test("all skill resources, including configs and instructions, are hash-only and high-risk exclusions are unchanged", async () => {
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
	const bundle = await collectLocalContextBundle(
		directory,
		{
			...getDefaultLocalContextCollectionOptions(),
			capturePolicy: "session-evidence",
		},
		createLocalContextSourceEnv(),
	);
	expect(bundle.blobs).toHaveLength(2);
	for (const entry of bundle.manifest.entries) {
		if (
			entry.kind !== "file" ||
			entry.content.status !== "omitted" ||
			entry.content.reason === "high-risk-path"
		)
			continue;
		expect(entry.content.reason).toBe("metadata-only");
		expect(entry.hash).toMatchObject({
			status: "available",
			algorithm: "sha256",
			scope: "source",
		});
		expect(entry.gitProvenance).toBe("tracked");
	}
	expect(
		fileEntry(bundle, "repository", ".claude/skills/demo/.env").hash,
	).toEqual({ status: "omitted", reason: "high-risk-path" });
	expect(
		bundle.manifest.entries.some((entry) =>
			entry.path.includes("node_modules"),
		),
	).toBe(false);
	expect(
		bundle.manifest.coverage.excludedPaths.some(
			(path) => path.reason === "dependency",
		),
	).toBe(true);
	expect(bundle.manifest.coverage.truncated).toBeUndefined();
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
	).toBeLessThanOrEqual(256 * 1024);
	expect(bundle.manifest.coverage.truncated?.omittedMetadata).toBeGreaterThan(
		0,
	);
	expect(bundle.manifest.coverage.limitsReached).toContain("maxManifestBytes");
	expect(fileEntry(bundle, "repository", "AGENTS.md").content.status).toBe(
		"available",
	);
}, 30_000);
