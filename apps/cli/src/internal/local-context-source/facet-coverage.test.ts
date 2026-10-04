import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RepositoryEvidenceInitInput } from "../../contracts/index.js";
import { buildRepositoryEvidenceUpload } from "../../lib/repository-evidence-upload.js";
import { planTranscriptRevision } from "../../lib/transcript-revision.js";
import { buildContextIndex } from "./context-index.js";
import {
	type AdditionalContextRoot,
	type ContextEntry,
	type ContextIndexFacetKind,
	type ContextRegularFileEntry,
	collectLocalContextBundle,
	createLocalContextSourceEnv,
	getDefaultLocalContextCollectionOptions,
	type LocalContextBundle,
	type LocalContextCollectionLimits,
	type LocalContextSourceEnv,
} from "./index.js";
import { findInstructionImports } from "./instruction-imports.js";

setDefaultTimeout(30_000);

const directories: string[] = [];

afterAll(async () => {
	await Promise.all(
		directories.map((directory) =>
			rm(directory, { recursive: true, force: true }),
		),
	);
});

const FACET_FILES: Readonly<Record<string, string>> = {
	"AGENTS.md": `Agent instructions\n${"a".repeat(4096)}\n`,
	"CLAUDE.md": "Claude instructions\n",
	"plans/rollout-plan.md": "Plan\n",
	".claude/agents/reviewer.md": "Reviewer agent\n",
	".claude/hooks/format.json": '{"command":"format"}',
	".mcp.json": '{"mcpServers":{}}',
	"package.json": '{"name":"fixture"}',
	"src/index.ts": "export const value = 1;\n",
};

type FacetMap = Readonly<Record<ContextIndexFacetKind, string>>;

const ALL_COMPLETE: FacetMap = {
	"agents-instructions": "complete",
	"claude-instructions": "complete",
	hooks: "complete",
	mcp: "complete",
	"package-context": "complete",
	plans: "complete",
};

describe("facet coverage matrix: each limit cuts only its own facet", () => {
	test.each<
		[
			string,
			Partial<LocalContextCollectionLimits>,
			Partial<Record<ContextIndexFacetKind, string>>,
			Readonly<Record<string, string>>,
		]
	>([
		["no limit reached", {}, {}, {}],
		[
			"instruction per-file cap",
			{ maxInstructionContentBytesPerFile: 1024 },
			{ "agents-instructions": "truncated" },
			{ "effective-instructions": "partial" },
		],
		[
			"instruction file-count cap",
			{ maxInstructionFiles: 1 },
			{ "claude-instructions": "truncated" },
			{ "effective-instructions": "partial" },
		],
		[
			"instruction byte budget",
			{ maxInstructionContentBytes: 2048 },
			{ "agents-instructions": "truncated" },
			{ "effective-instructions": "partial" },
		],
		[
			"general content budget",
			{ maxTotalContentBytes: 1 },
			// The repository's .mcp.json is content-bearing, so its facet is cut
			// along with the hook file.
			{ hooks: "truncated", mcp: "truncated" },
			{},
		],
		["general blob-count cap", { maxBlobs: 1 }, { hooks: "truncated" }, {}],
		[
			"hash budgets",
			{
				maxHashBytesPerFile: 1,
				maxHashBytesPerRoot: 1,
				maxTotalHashBytes: 1,
			},
			{},
			{},
		],
		["patch pool", { maxDiffContentBytes: 1 }, {}, { "task-delta": "partial" }],
	])("%s", async (_name, limits, truncatedFacets, partialAreas) => {
		const repository = await createRepository(FACET_FILES, {
			dirty: { "src/index.ts": "export const value = 2;\n" },
		});
		const bundle = await collect(repository, limits);
		expect(getFacetCoverage(bundle, "repository")).toEqual({
			...ALL_COMPLETE,
			...truncatedFacets,
		});
		expect(bundle.manifest.roots[0]?.status).toBe("collected");
		const areas = await getCoverageAreas(bundle);
		expect(
			Object.fromEntries(
				Object.entries(areas).filter(([, status]) => status !== "complete"),
			),
		).toEqual(partialAreas);
	});

	test("a discovery walk cut by the entry limit truncates every facet of that root only", async () => {
		const repository = await createRepository(FACET_FILES);
		const skills = await createDirectory({ "demo/SKILL.md": "Skill\n" });
		const bundle = await collect(repository, { maxEntriesPerRoot: 3 }, [
			skillRoot("claude-user-skills", skills),
		]);
		expect(bundle.manifest.roots.map((root) => [root.id, root.status])).toEqual(
			[
				["repository", "limit-reached"],
				["claude-user-skills", "collected"],
			],
		);
		for (const coverage of Object.values(
			getFacetCoverage(bundle, "repository"),
		))
			expect(coverage).toBe("truncated");
		expect(getFacetCoverage(bundle, "claude-user-skills")).toEqual(
			ALL_COMPLETE,
		);
		const areas = await getCoverageAreas(bundle);
		expect(areas["available-skills"]).toBe("partial");
	});

	test("dropping one facet's resources from the manifest truncates only that facet", () => {
		const bundleEntries: ContextEntry[] = [
			metadataEntry("AGENTS.md"),
			metadataEntry("plans/a-plan.md"),
		];
		const index = buildContextIndex(
			[repositoryRoot("collected")],
			bundleEntries,
			[],
			[],
			[metadataEntry("plans/b-plan.md")],
		);
		expect(
			Object.fromEntries(
				index.facets.map((facet) => [facet.kind, facet.coverage]),
			),
		).toEqual({ ...ALL_COMPLETE, plans: "truncated" });
	});

	test("trimming an oversized worktree list keeps roots, facets and Git output complete", async () => {
		const repository = await createRepository(FACET_FILES);
		const base = createLocalContextSourceEnv();
		const worktrees = Array.from(
			{ length: 600 },
			(_, index) =>
				`worktree /Users/example/conductor/workspaces/repo/worktree-${index}\0HEAD ${"a".repeat(40)}\0branch refs/heads/worktree-${index}\0\0`,
		).join("");
		const env: LocalContextSourceEnv = {
			...base,
			git: {
				run: async (directory, args, maxBytes, timeoutMs) => {
					const result = await base.git.run(
						directory,
						args,
						maxBytes,
						timeoutMs,
					);
					return args[0] === "worktree"
						? { ...result, stdout: new TextEncoder().encode(worktrees) }
						: result;
				},
			},
		};
		const bundle = await collect(repository, {}, [], env);
		assert(bundle.manifest.git.status === "available");
		expect(bundle.manifest.git.worktrees.length).toBeLessThan(600);
		expect(bundle.manifest.git.worktrees.length).toBeGreaterThan(50);
		expect(bundle.manifest.git.truncatedSections).toEqual([]);
		expect(bundle.manifest.coverage.truncated?.omittedMetadata).toBe(
			600 - bundle.manifest.git.worktrees.length,
		);
		expect(bundle.manifest.coverage.limitsReached).toContain(
			"metadata:git.worktrees",
		);
		expect(bundle.manifest.roots.map((root) => root.status)).toEqual([
			"collected",
		]);
		expect(getFacetCoverage(bundle, "repository")).toEqual(ALL_COMPLETE);
		const areas = await getCoverageAreas(bundle);
		expect(Object.values(areas).every((status) => status === "complete")).toBe(
			true,
		);
	});
});

describe("missing and unreadable roots", () => {
	test("a missing skill root is absent, not truncated, unavailable or an error", async () => {
		const repository = await createRepository(FACET_FILES);
		const parent = await createDirectory({});
		const bundle = await collect(repository, {}, [
			skillRoot("codex-user-skills", join(parent, "does-not-exist")),
		]);
		expect(bundle.manifest.roots[1]).toMatchObject({
			id: "codex-user-skills",
			status: "missing",
		});
		for (const facet of bundle.manifest.contextIndex.facets.filter(
			(candidate) => candidate.rootId === "codex-user-skills",
		)) {
			expect(facet.presence).toBe("absent");
			expect(facet.coverage).toBe("complete");
		}
		expect(bundle.manifest.coverage.errors).toEqual([]);
		const areas = await getCoverageAreas(bundle);
		expect(Object.values(areas).every((status) => status === "complete")).toBe(
			true,
		);
	});

	test("an unreadable skill root still makes available skills partial", async () => {
		const repository = await createRepository(FACET_FILES);
		const parent = await createDirectory({ "not-a-directory": "file\n" });
		const bundle = await collect(repository, {}, [
			skillRoot("codex-user-skills", join(parent, "not-a-directory")),
		]);
		expect(bundle.manifest.roots[1]?.status).toBe("inaccessible");
		const upload = await buildUpload(bundle);
		expect(
			upload.input.coverage.find((item) => item.area === "available-skills"),
		).toEqual({
			area: "available-skills",
			reason: "Skill roots could not be read: codex-user-skills",
			status: "partial",
		});
	});
});

describe("instruction capture", () => {
	test("captures a large CLAUDE.md whole beyond the general per-file cap", async () => {
		const large = `# Instructions\n${"Follow the repository conventions.\n".repeat(45_000)}`;
		expect(Buffer.byteLength(large)).toBeGreaterThan(1024 * 1024);
		const repository = await createRepository({ "CLAUDE.md": large });
		const bundle = await collect(repository, {
			maxContentBytesPerFile: 512 * 1024,
		});
		expect(readCaptured(bundle, "CLAUDE.md")).toBe(large);
		expect(getFacetCoverage(bundle, "repository")["claude-instructions"]).toBe(
			"complete",
		);
	});

	test("cuts an instruction file over the per-file cap, keeps its source hash and truncates its facet", async () => {
		const oversized = "x".repeat(3 * 1024 * 1024);
		const repository = await createRepository({
			"AGENTS.md": oversized,
			"CLAUDE.md": "Claude instructions\n",
		});
		const bundle = await collect(repository);
		const entry = getFile(bundle, "AGENTS.md");
		expect(entry.content).toMatchObject({
			status: "omitted",
			reason: "file-content-cap",
		});
		expect(entry.hash).toMatchObject({
			status: "available",
			value: createHash("sha256").update(oversized).digest("hex"),
		});
		expect(getFacetCoverage(bundle, "repository")).toEqual({
			...ALL_COMPLETE,
			"agents-instructions": "truncated",
		});
		expect(readCaptured(bundle, "CLAUDE.md")).toBe("Claude instructions\n");
	});

	test("labels hash-only-by-policy resources apart from capacity cuts, keeping the wire values", async () => {
		const repository = await createRepository({
			"AGENTS.md": "x".repeat(3 * 1024 * 1024),
			"package.json": '{"name":"fixture"}',
		});
		const bundle = await collect(repository);
		const access = (kind: string, path: string) =>
			bundle.manifest.contextIndex.facets
				.find((facet) => facet.rootId === "repository" && facet.kind === kind)
				?.resources.find((resource) => resource.path === path)?.access;
		expect(access("package-context", "package.json")).toEqual({
			status: "truncated",
			reason: "file-content-cap",
			policy: "hash-only",
		});
		expect(access("agents-instructions", "AGENTS.md")).toEqual({
			status: "truncated",
			reason: "file-content-cap",
		});
		// Policy omissions leave their facet complete; capacity cuts do not.
		expect(getFacetCoverage(bundle, "repository")).toMatchObject({
			"package-context": "complete",
			"agents-instructions": "truncated",
		});
	});

	test("fills the instruction byte budget in rank order and records the limit", async () => {
		const chunk = "y".repeat(400 * 1024);
		const repository = await createRepository({
			"AGENTS.md": `root ${chunk}`,
			"a/AGENTS.md": `a ${chunk}`,
			"b/AGENTS.md": `b ${chunk}`,
		});
		const bundle = await collect(repository, {
			maxInstructionContentBytes: 900 * 1024,
		});
		expect(getFile(bundle, "AGENTS.md").content.status).toBe("available");
		expect(getFile(bundle, "a/AGENTS.md").content.status).toBe("available");
		expect(getFile(bundle, "b/AGENTS.md").content).toMatchObject({
			status: "omitted",
			reason: "total-content-cap",
		});
		expect(bundle.manifest.coverage.limitsReached).toContain(
			"maxInstructionContentBytes",
		);
	});

	test("prefers instruction files that apply to the working directory", async () => {
		const repository = await createRepository({
			"AGENTS.md": "root\n",
			"packages/aaa/AGENTS.md": "unrelated package\n",
			"packages/zzz/AGENTS.md": "working package\n",
			"packages/zzz/src/CLAUDE.md": "working source\n",
		});
		const bundle = await collect(
			repository,
			{ maxInstructionFiles: 3 },
			[],
			createLocalContextSourceEnv(),
			"packages/zzz/src",
		);
		expect(readCaptured(bundle, "AGENTS.md")).toBe("root\n");
		expect(readCaptured(bundle, "packages/zzz/AGENTS.md")).toBe(
			"working package\n",
		);
		expect(readCaptured(bundle, "packages/zzz/src/CLAUDE.md")).toBe(
			"working source\n",
		);
		expect(getFile(bundle, "packages/aaa/AGENTS.md").content).toMatchObject({
			status: "omitted",
			reason: "blob-count-cap",
		});
	});

	test("captures files imported by CLAUDE.md, recursively and within the repository only", async () => {
		const repository = await createRepository({
			"CLAUDE.md": [
				"# Project",
				"See @docs/guide.md and @./rules/style.md.",
				"Personal notes: @CLAUDE.local.md",
				"Outside: @../outside.md and npm scope @opalinehq/cli",
				"Inline `@docs/inline.md` is code.",
				"```",
				"@docs/fenced.md",
				"```",
				"",
			].join("\n"),
			"CLAUDE.local.md": "Personal local instructions\n",
			"docs/guide.md": "Guide imports @deeper/chain.md\n",
			"docs/deeper/chain.md": "Chain end\n",
			"docs/inline.md": "inline\n",
			"docs/fenced.md": "fenced\n",
			"rules/style.md": "Style rules\n",
		});
		const bundle = await collect(repository);
		for (const [path, content] of [
			["docs/guide.md", "Guide imports @deeper/chain.md\n"],
			["docs/deeper/chain.md", "Chain end\n"],
			["rules/style.md", "Style rules\n"],
		] as const) {
			expect(readCaptured(bundle, path)).toBe(content);
			expect(getFile(bundle, path).evidenceReason).toBe("instruction-import");
		}
		// Personal instructions are an instruction file of their own.
		expect(readCaptured(bundle, "CLAUDE.local.md")).toBe(
			"Personal local instructions\n",
		);
		expect(getFile(bundle, "CLAUDE.local.md").evidenceReason).toBeNull();
		for (const path of ["docs/inline.md", "docs/fenced.md"]) {
			expect(getFile(bundle, path).content).toMatchObject({
				status: "omitted",
				reason: "metadata-only",
			});
			expect(getFile(bundle, path).evidenceReason).toBeNull();
		}
	});

	test("finds Claude Code imports outside code and resolves them inside the repository", () => {
		expect(
			findInstructionImports(
				[
					"@AGENTS.md first",
					"Read @docs/a.md, then @./b.md; and (@c.md)",
					"Email someone@example.com or @/absolute/path or @~/home.md",
					"`@code.md` and ```@fenced.md```",
					"~~~",
					"@tilde-fenced.md",
					"~~~",
					"@../../escape.md @../sibling.md @sub/../inside.md",
				].join("\n"),
				"nested/CLAUDE.md",
			),
		).toEqual([
			"nested/AGENTS.md",
			"nested/docs/a.md,",
			"nested/docs/a.md",
			"nested/b.md;",
			"nested/b.md",
			"sibling.md",
			"nested/inside.md",
		]);
	});
});

describe("Git-ignored directories", () => {
	test("are walked after all other content and never truncate the repository or other roots", async () => {
		const files: Record<string, string> = {
			".gitignore": "scratch/\n.claude/\n",
			"AGENTS.md": "Agent instructions\n",
			"zzz/CLAUDE.md": "Nested instructions\n",
			".claude/agents/reviewer.md": "Ignored but agent configuration\n",
		};
		for (let index = 0; index < 120; index += 1)
			files[`scratch/run-${String(index).padStart(3, "0")}/output.txt`] =
				"scratch\n";
		const repository = await createRepository(files);
		const skills = await createDirectory({
			"demo/SKILL.md": "Skill\n",
			"other/SKILL.md": "Skill\n",
		});
		const bundle = await collect(
			repository,
			{ maxEntriesPerRoot: 40, maxTotalEntries: 60 },
			[skillRoot("claude-user-skills", skills)],
		);
		expect(bundle.manifest.roots.map((root) => [root.id, root.status])).toEqual(
			[
				["repository", "collected"],
				["claude-user-skills", "collected"],
			],
		);
		expect(getFacetCoverage(bundle, "repository")).toEqual(ALL_COMPLETE);
		expect(
			bundle.manifest.contextIndex.skills.map((skill) => skill.name),
		).toEqual(["demo", "other"]);
		expect(readCaptured(bundle, "zzz/CLAUDE.md")).toBe("Nested instructions\n");
		// Ignored agent configuration is not deferred.
		expect(getFile(bundle, ".claude/agents/reviewer.md").content.status).toBe(
			"available",
		);
		expect(bundle.manifest.coverage.limitsReached).toContain(
			"maxEntriesPerRoot:ignored",
		);
		const ignored = bundle.manifest.coverage.excludedPaths.filter(
			(excluded) => excluded.reason === "ignored",
		);
		expect(ignored.length).toBeGreaterThan(0);
		for (const excluded of ignored)
			expect(excluded.path.startsWith("scratch")).toBe(true);
		const areas = await getCoverageAreas(bundle);
		expect(Object.values(areas).every((status) => status === "complete")).toBe(
			true,
		);
	});

	test("a cut in non-ignored content still truncates the root", async () => {
		const files: Record<string, string> = { "AGENTS.md": "Instructions\n" };
		for (let index = 0; index < 60; index += 1)
			files[`src/module-${index}.ts`] = "export {};\n";
		const repository = await createRepository(files);
		const bundle = await collect(repository, { maxEntriesPerRoot: 20 });
		expect(bundle.manifest.roots[0]?.status).toBe("limit-reached");
		expect(getFacetCoverage(bundle, "repository")["agents-instructions"]).toBe(
			"truncated",
		);
	});
});

async function collect(
	repository: string,
	limits: Partial<LocalContextCollectionLimits> = {},
	additionalRoots: readonly AdditionalContextRoot[] = [],
	env: LocalContextSourceEnv = createLocalContextSourceEnv(),
	workingDirectory: string | undefined = undefined,
): Promise<LocalContextBundle> {
	const defaults = getDefaultLocalContextCollectionOptions();
	return collectLocalContextBundle(
		repository,
		{
			...defaults,
			additionalRoots,
			capturePolicy: "session-evidence",
			limits: { ...defaults.limits, ...limits },
			workingDirectory,
		},
		env,
	);
}

async function createRepository(
	files: Readonly<Record<string, string>>,
	options: { readonly dirty?: Readonly<Record<string, string>> } = {},
): Promise<string> {
	const repository = await createDirectory(files);
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
			"Facet fixture",
		],
	])
		execFileSync("git", args, { cwd: repository });
	for (const [path, content] of Object.entries(options.dirty ?? {}))
		await writeFile(join(repository, path), content);
	return repository;
}

async function createDirectory(
	files: Readonly<Record<string, string>>,
): Promise<string> {
	const directory = await realpath(
		await mkdtemp(join(tmpdir(), "opaline-facet-coverage-")),
	);
	directories.push(directory);
	for (const [path, content] of Object.entries(files)) {
		await mkdir(join(directory, path, ".."), { recursive: true });
		await writeFile(join(directory, path), content);
	}
	return directory;
}

function skillRoot(id: string, absolutePath: string): AdditionalContextRoot {
	return { id, label: id, absolutePath, origin: "user", scope: "skills" };
}

function getFacetCoverage(
	bundle: LocalContextBundle,
	rootId: string,
): FacetMap {
	const facets = bundle.manifest.contextIndex.facets.filter(
		(facet) => facet.rootId === rootId,
	);
	const map: Record<string, string> = {};
	for (const facet of facets) map[facet.kind] = facet.coverage;
	return {
		"agents-instructions": map["agents-instructions"] ?? "missing",
		"claude-instructions": map["claude-instructions"] ?? "missing",
		hooks: map.hooks ?? "missing",
		mcp: map.mcp ?? "missing",
		"package-context": map["package-context"] ?? "missing",
		plans: map.plans ?? "missing",
	};
}

async function getCoverageAreas(
	bundle: LocalContextBundle,
): Promise<Readonly<Record<string, string>>> {
	const upload = await buildUpload(bundle);
	return Object.fromEntries(
		upload.input.coverage.map((item) => [item.area, item.status]),
	);
}

async function buildUpload(
	bundle: LocalContextBundle,
): Promise<{ readonly input: RepositoryEvidenceInitInput }> {
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
	return buildRepositoryEvidenceUpload({
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
}

function getFile(
	bundle: LocalContextBundle,
	path: string,
): ContextRegularFileEntry {
	const entry = bundle.manifest.entries.find(
		(candidate) => candidate.rootId === "repository" && candidate.path === path,
	);
	assert(entry?.kind === "file", `Missing file ${path}`);
	return entry;
}

function readCaptured(bundle: LocalContextBundle, path: string): string {
	const entry = getFile(bundle, path);
	assert(
		entry.content.status === "available",
		`${path} content is ${entry.content.status}`,
	);
	const blobId = entry.content.blobId;
	const blob = bundle.blobs.find((candidate) => candidate.id === blobId);
	assert(blob, `Missing blob for ${path}`);
	return blob.content;
}

function repositoryRoot(
	status: "collected" | "limit-reached",
): LocalContextBundle["manifest"]["roots"][number] {
	return {
		absolutePath: "/repo",
		coverage: {
			contentBytes: 0,
			contentFiles: 0,
			directoryCount: 0,
			discoveredEntries: 0,
			excludedPaths: 0,
			fileCount: 0,
			hashedBytes: 0,
			hashedFiles: 0,
			limitsReached: [],
			omittedContentFiles: 0,
			otherCount: 0,
			rootId: "repository",
			submoduleCount: 0,
			symlinkCount: 0,
		},
		id: "repository",
		label: "Repository",
		origin: "repository",
		scope: "repository",
		status,
	};
}

function metadataEntry(path: string): ContextEntry {
	return {
		categories: path.endsWith("AGENTS.md")
			? ["agent-config", "document", "instruction", "markdown"]
			: ["document", "markdown", "plan-candidate"],
		content: { detail: null, reason: "metadata-only", status: "omitted" },
		evidenceReason: null,
		gitProvenance: "tracked",
		hash: { reason: "hash-file-cap", status: "omitted" },
		kind: "file",
		mode: 0o100644,
		modifiedAtMs: 0,
		name: path.split("/").at(-1) ?? path,
		parentPath: null,
		path,
		rootId: "repository",
		size: 1,
	};
}
