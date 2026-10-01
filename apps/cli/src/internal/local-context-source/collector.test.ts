import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, open, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	assessContextSkillUse,
	type ContextRegularFileEntry,
	collectLocalContextBundle,
	createLocalContextSourceEnv,
	getDefaultLocalContextCollectionOptions,
	getLocalContextBundleBlobIds,
	getLocalContextBundleExternalObjectIds,
	type LocalContextBundle,
	type LocalContextCollectionOptions,
	serializeLocalContextBundle,
	validateLocalContextCollectionOptions,
} from "./index.js";

setDefaultTimeout(30_000);

const TEST_DIRECTORIES: string[] = [];
const FIXED_TIME = new Date("2026-09-18T12:00:00.000Z");

afterAll(async () => {
	await Promise.all(
		TEST_DIRECTORIES.map((directory) =>
			rm(directory, { recursive: true, force: true }),
		),
	);
});

describe("local context collection from a real Git worktree", () => {
	test("reports truncated directory coverage even when retained entries are excluded", async () => {
		const directory = await mkdtemp(join(tmpdir(), "opaline-excluded-budget-"));
		TEST_DIRECTORIES.push(directory);
		const names = Array.from(
			{ length: 30 },
			(_, index) => `excluded-${index}.txt`,
		);
		await Promise.all(
			names.map((name) => writeFile(join(directory, name), "content")),
		);
		const defaults = getDefaultLocalContextCollectionOptions();
		const bundle = await collectLocalContextBundle(
			directory,
			{
				...defaults,
				excludedPathPrefixes: names,
				limits: { ...defaults.limits, maxEntriesPerRoot: 3 },
			},
			fixedEnvironment(),
		);
		expect(bundle.manifest.entries).toHaveLength(0);
		expect(bundle.manifest.coverage.excludedPaths).toHaveLength(3);
		expect(bundle.manifest.coverage.limitsReached).toContain(
			"maxEntriesPerRoot",
		);
		expect(bundle.manifest.roots[0]?.status).toBe("limit-reached");
	});

	test("checks the capture deadline before filesystem collection", async () => {
		await expect(
			createLocalContextSourceEnv(Date.now() - 1).fileSystem.readDirectory(
				"/missing-budget-directory",
				3,
			),
		).rejects.toThrow("time budget");
	});

	test("bounds directory enumeration before retaining and sorting entries", async () => {
		const directory = await mkdtemp(join(tmpdir(), "opaline-wide-directory-"));
		TEST_DIRECTORIES.push(directory);
		await Promise.all(
			Array.from({ length: 30 }, (_, index) =>
				writeFile(join(directory, `file-${index}.txt`), "content"),
			),
		);
		const result = await createLocalContextSourceEnv().fileSystem.readDirectory(
			directory,
			3,
		);
		expect(result.entries).toHaveLength(3);
		expect(result.complete).toBe(false);
	});

	test("reports object-count omissions without discarding the capture", async () => {
		const directory = await mkdtemp(join(tmpdir(), "opaline-blob-budget-"));
		TEST_DIRECTORIES.push(directory);
		await mkdir(join(directory, ".claude"));
		await Promise.all(
			Array.from({ length: 6 }, (_, index) =>
				writeFile(
					join(directory, ".claude", `config-${index}.json`),
					`distinct content ${index}`,
				),
			),
		);
		const defaults = getDefaultLocalContextCollectionOptions();
		const bundle = await collectLocalContextBundle(
			directory,
			{
				...defaults,
				capturePolicy: "session-evidence",
				limits: { ...defaults.limits, maxBlobs: 2 },
			},
			fixedEnvironment(),
		);
		expect(bundle.blobs).toHaveLength(2);
		expect(bundle.manifest.coverage.limitsReached).toContain("maxBlobs");
		expect(bundle.manifest.coverage.omittedContentFiles).toBe(4);
		expect(bundle.manifest.coverage.partial).toBe(true);
	});

	test("rejects invalid additional-root paths and enum values", () => {
		const defaults = getDefaultLocalContextCollectionOptions();
		const validRoot = {
			id: "external",
			label: "External context",
			absolutePath: "/absolute/context",
			origin: "user",
			scope: "custom",
		} as const;
		for (const invalidRoot of [
			{ ...validRoot, absolutePath: "relative/context" },
			{ ...validRoot, origin: "repository" },
			{ ...validRoot, scope: "repository" },
		]) {
			expect(() =>
				validateLocalContextCollectionOptions({
					...defaults,
					additionalRoots: [
						invalidRoot as LocalContextCollectionOptions["additionalRoots"][number],
					],
				}),
			).toThrow();
		}
	});

	test("builds a sanitized delta bundle across tracked, dirty, ignored, and additional roots", async () => {
		const fixture = await createRepositoryFixture();
		const options = getFixtureOptions(fixture);
		const bundle = await collectLocalContextBundle(
			fixture.repository,
			options,
			fixedEnvironment(),
		);

		expect(bundle.manifest.schemaVersion).toBe("1.1.0");
		expect(bundle.manifest.lifecycle).toBe("sanitized-local-spool");
		expect(bundle.manifest.capturePolicy).toBe("delta");
		expect(bundle.manifest.startedAt).toBe(FIXED_TIME.toISOString());
		expect(bundle.manifest.completedAt).toBe(FIXED_TIME.toISOString());
		expect(bundle.manifest.collectedAt).toBe(FIXED_TIME.toISOString());
		expect(bundle.manifest.consistency.status).toBe("stable");
		expect(bundle.manifest.consistency.atomic).toBe(false);
		expect(bundle.manifest.baseGitCommit).toMatch(/^[0-9a-f]{40,64}$/u);
		expect(bundle.manifest.git.status).toBe("available");
		assert(bundle.manifest.git.status === "available");
		expect(JSON.stringify(bundle.manifest.git)).not.toContain(
			fixture.secretCanary,
		);
		expect(JSON.stringify(bundle.manifest.git.remotes)).not.toContain(
			"collector-user",
		);

		const readme = getFile(bundle, "repository", "README.md");
		expect(readme.gitProvenance).toBe("tracked");
		expect(readme.content.status).toBe("git-object");
		expect(readme.hash.status).toBe("git-object");
		assert(readme.content.status === "git-object");
		expect(getLocalContextBundleExternalObjectIds(bundle)).toContain(
			readme.content.objectId,
		);

		const huge = getFile(bundle, "repository", "huge-sparse.dat");
		expect(huge.size).toBe(8 * 1024 * 1024);
		expect(huge.content.status).toBe("git-object");
		expect(bundle.manifest.coverage.gitObjectBytes).toBeGreaterThanOrEqual(
			8 * 1024 * 1024,
		);

		const dirty = getFile(bundle, "repository", "src/dirty.ts");
		expect(dirty.gitProvenance).toBe("tracked");
		expect(dirty.content.status).toBe("available");
		assert(dirty.content.status === "available");
		const dirtyBlob = getBlob(bundle, dirty.content.blobId);
		expect(dirtyBlob.content).toContain("[REDACTED:aws-access-key-id]");
		expect(dirtyBlob.content).not.toContain(fixture.secretCanary);

		const ignored = getFile(bundle, "repository", "ignored-notes.md");
		expect(ignored.gitProvenance).toBe("ignored");
		expect(ignored.content.status).toBe("available");
		const untracked = getFile(bundle, "repository", "notes.md");
		expect(untracked.gitProvenance).toBe("untracked");
		expect(untracked.content.status).toBe("available");
		const staged = getFile(bundle, "repository", "staged.md");
		expect(staged.gitProvenance).toBe("tracked");
		expect(staged.content.status).toBe("available");
		const weird = getFile(bundle, "repository", "odd\nname.md");
		expect(weird.content.status).toBe("available");

		const binary = getFile(bundle, "repository", "binary.dat");
		expect(binary.content).toEqual({
			status: "omitted",
			reason: "binary",
			detail: null,
		});
		expect(binary.hash.status).toBe("available");

		const highRisk = getFile(bundle, "repository", ".env.local");
		expect(highRisk.content.status).toBe("omitted");
		expect(highRisk.hash).toEqual({
			status: "omitted",
			reason: "high-risk-path",
		});

		const symlinkEntry = bundle.manifest.entries.find(
			(entry) =>
				entry.rootId === "repository" && entry.path === "external-link.md",
		);
		assert(symlinkEntry?.kind === "symlink");
		expect(symlinkEntry.followed).toBe(false);
		expect(symlinkEntry.targetScope).toBe("external");
		const submoduleEntry = bundle.manifest.entries.find(
			(entry) =>
				entry.rootId === "repository" && entry.path === "components/nested",
		);
		assert(submoduleEntry?.kind === "submodule");
		expect(submoduleEntry.followed).toBe(false);
		expect(submoduleEntry.objectId).toBe(fixture.submoduleCommit);
		expect(submoduleEntry.worktreeStatus).toBe("M");
		const missingSubmoduleEntry = bundle.manifest.entries.find(
			(entry) =>
				entry.rootId === "repository" &&
				entry.path === "components/uninitialized",
		);
		assert(missingSubmoduleEntry?.kind === "submodule");
		expect(missingSubmoduleEntry.followed).toBe(false);
		expect(missingSubmoduleEntry.objectId).toBe(fixture.submoduleCommit);
		expect(missingSubmoduleEntry.worktreeStatus).toBe("D");
		const dependencySubmoduleEntry = bundle.manifest.entries.find(
			(entry) =>
				entry.rootId === "repository" &&
				entry.path === "vendor/nested-dependency",
		);
		assert(dependencySubmoduleEntry?.kind === "submodule");
		expect(dependencySubmoduleEntry.followed).toBe(false);
		expect(dependencySubmoduleEntry.objectId).toBe(fixture.submoduleCommit);
		expect(bundle.manifest.roots[0]?.coverage.submoduleCount).toBe(3);
		expect(
			bundle.manifest.entries.some((entry) =>
				entry.path.startsWith("components/nested/"),
			),
		).toBe(false);
		for (const nestedRoot of ["nested-repository", "nested-worktree"]) {
			expect(
				bundle.manifest.entries.some(
					(entry) =>
						entry.rootId === "repository" &&
						entry.path.startsWith(`${nestedRoot}/`),
				),
			).toBe(false);
			expect(
				bundle.manifest.coverage.excludedPaths.some(
					(excluded) =>
						excluded.rootId === "repository" &&
						excluded.path === nestedRoot &&
						excluded.reason === "vcs",
				),
			).toBe(true);
		}
		expect(getFile(bundle, "nested-repository-root", "inside.md").rootId).toBe(
			"nested-repository-root",
		);

		expect(
			bundle.manifest.documents.skillDefinitions.map(
				(reference) => `${reference.rootId}:${reference.path}`,
			),
		).toEqual([
			"repository:.claude/skills/demo/SKILL.md",
			"user-skills:cached-plugin/skill/SKILL.md",
			"user-skills:demo/SKILL.md",
		]);
		expect(
			bundle.manifest.documents.skillResources.map(
				(reference) => `${reference.rootId}:${reference.path}`,
			),
		).toContain("repository:.claude/skills/demo/references/guide.md");
		expect(
			bundle.manifest.documents.instructions.map(
				(reference) => `${reference.rootId}:${reference.path}`,
			),
		).toContain(
			"repository:.github/instructions/nested/product.instructions.md",
		);
		expect(
			bundle.manifest.documents.planCandidates.map(
				(reference) => `${reference.rootId}:${reference.path}`,
			),
		).toContain("user-plans:backlog.md");
		const repositoryFacets = bundle.manifest.contextIndex.facets.filter(
			(facet) => facet.rootId === "repository",
		);
		expect(repositoryFacets).toContainEqual({
			kind: "agents-instructions",
			rootId: "repository",
			presence: "present",
			coverage: "complete",
			resources: [
				{
					rootId: "repository",
					path: "AGENTS.md",
					access: { status: "reference-only", reason: "git-object" },
				},
			],
		});
		expect(repositoryFacets).toContainEqual({
			kind: "claude-instructions",
			rootId: "repository",
			presence: "present",
			coverage: "complete",
			resources: [
				{
					rootId: "repository",
					path: "CLAUDE.md",
					access: { status: "reference-only", reason: "git-object" },
				},
			],
		});
		for (const kind of ["plans", "hooks", "mcp", "package-context"]) {
			const facet = repositoryFacets.find(
				(candidate) => candidate.kind === kind,
			);
			assert(facet);
			expect(facet.presence).toBe("present");
			expect(facet.coverage).toBe("complete");
		}

		expect(bundle.manifest.contextIndex.skills).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					name: "demo",
					nameSource: "definition-directory",
					discovery: "present",
					definitions: expect.arrayContaining([
						{
							rootId: "repository",
							path: ".claude/skills/demo/SKILL.md",
							access: { status: "reference-only", reason: "git-object" },
						},
					]),
				}),
			]),
		);
		const usage = assessContextSkillUse(bundle.manifest.contextIndex.skills, {
			scope: { kind: "session", id: "session-123" },
			coverage: "complete",
			observedSkillNames: ["demo"],
		});
		expect(usage.find((skill) => skill.name === "demo")?.use).toEqual({
			status: "observed-used",
			evidenceScope: { kind: "session", id: "session-123" },
		});
		expect(usage.find((skill) => skill.name === "skill")?.use).toEqual({
			status: "no-observed-use",
			evidenceScope: { kind: "session", id: "session-123" },
		});
		expect(
			assessContextSkillUse(bundle.manifest.contextIndex.skills, {
				scope: { kind: "session", id: "session-partial" },
				coverage: "partial",
				observedSkillNames: [],
			})[0]?.use,
		).toEqual({
			status: "unknown",
			evidenceScope: { kind: "session", id: "session-partial" },
			reason: "partial-evidence",
		});
		expect(
			assessContextSkillUse(bundle.manifest.contextIndex.skills, null)[0]?.use,
		).toEqual({
			status: "unknown",
			evidenceScope: null,
			reason: "no-evidence",
		});
		expect(
			bundle.manifest.roots.find((root) => root.id === "missing")?.status,
		).toBe("missing");
		const unavailableFacet = bundle.manifest.contextIndex.facets.find(
			(facet) =>
				facet.rootId === "missing" && facet.kind === "agents-instructions",
		);
		assert(unavailableFacet);
		expect(unavailableFacet.presence).toBe("unknown");
		expect(unavailableFacet.coverage).toBe("unavailable");

		assert(bundle.manifest.git.status === "available");
		const workingDiff = bundle.manifest.git.diffs.find(
			(diff) => diff.kind === "working-tree",
		);
		assert(workingDiff?.blobId);
		const diffBlob = getBlob(bundle, workingDiff.blobId);
		expect(diffBlob.content).not.toContain(fixture.secretCanary);
		expect(diffBlob.content).not.toContain("TRACKED_ENV_CHANGED_CANARY");
		expect(workingDiff.highRiskPathsExcluded).toBe(true);
		expect(workingDiff.secretFilter?.redactedBytes).toBeGreaterThan(0);
		expect(workingDiff.reconstructable).toBe(false);
		const stagedDiff = bundle.manifest.git.diffs.find(
			(diff) => diff.kind === "staged",
		);
		assert(stagedDiff?.blobId);
		expect(getBlob(bundle, stagedDiff.blobId).content).not.toContain(
			"STAGED_PRIVATE_CHANGED_CANARY",
		);
		expect(stagedDiff.reconstructable).toBe(true);
		expect(bundle.manifest.coverage.inventoryBytes).toBeGreaterThan(
			bundle.manifest.coverage.uploadCandidateBytes,
		);
		expect(bundle.manifest.coverage.redactedBytes).toBeGreaterThan(0);
		expect(bundle.manifest.transport.rawContentIncluded).toBe(false);
		expect(serializeLocalContextBundle(bundle)).toBe(JSON.stringify(bundle));
	});

	test("session evidence materializes effective context while keeping unrelated tracked source as Git references", async () => {
		const fixture = await createRepositoryFixture();
		const options = {
			...getFixtureOptions(fixture),
			capturePolicy: "session-evidence" as const,
		};
		const bundle = await collectLocalContextBundle(
			fixture.repository,
			options,
			fixedEnvironment(),
		);

		const agents = getFile(bundle, "repository", "AGENTS.md");
		const skill = getFile(bundle, "repository", ".claude/skills/demo/SKILL.md");
		const packageContext = getFile(bundle, "repository", "package.json");
		const unrelated = getFile(bundle, "repository", "README.md");

		expect(agents.content.status).toBe("available");
		expect(skill.content.status).toBe("available");
		expect(packageContext.content).toMatchObject({
			status: "omitted",
			reason: "metadata-only",
		});
		expect(unrelated.content).toMatchObject({
			status: "omitted",
			reason: "metadata-only",
		});
		expect(unrelated.hash).toMatchObject({
			status: "available",
			algorithm: "sha256",
			scope: "source",
		});
		expect(
			bundle.manifest.contextIndex.facets.find(
				(facet) =>
					facet.rootId === "repository" && facet.kind === "agents-instructions",
			)?.resources[0]?.access,
		).toEqual({ status: "readable" });
	});

	test("reuses parent blobs across incremental captures", async () => {
		const fixture = await createRepositoryFixture();
		const first = await collectLocalContextBundle(
			fixture.repository,
			getFixtureOptions(fixture),
			captureEnvironment("capture-first"),
		);
		const firstBlobIds = first.blobs.map((blob) => blob.id);
		const withParent: LocalContextCollectionOptions = {
			...getFixtureOptions(fixture),
			parentCapture: {
				id: first.manifest.captureId,
				blobIds: firstBlobIds,
			},
		};
		const second = await collectLocalContextBundle(
			fixture.repository,
			withParent,
			captureEnvironment("capture-second"),
		);

		const notes = getFile(second, "repository", "notes.md");
		expect(notes.content.status).toBe("reused");
		assert(notes.content.status === "reused");
		expect(notes.content.parentCaptureId).toBe(first.manifest.captureId);
		expect(second.manifest.parentCaptureId).toBe(first.manifest.captureId);
		expect(first.manifest.captureId).toBe("capture-first");
		expect(second.manifest.captureId).toBe("capture-second");
		expect(second.manifest.captureId).not.toBe(first.manifest.captureId);
		expect(second.manifest.coverage.reusedBytes).toBeGreaterThan(0);
		expect(second.blobs.length).toBeLessThan(first.blobs.length);
		expect(second.blobs).toHaveLength(0);
		expect(getLocalContextBundleBlobIds(second)).toContain(
			notes.content.blobId,
		);
	});

	test("prioritizes instructions when the aggregate content cap is reached", async () => {
		const repository = await createEmptyRepository();
		await writeFile(
			join(repository, "AGENTS.md"),
			"instruction-context\n",
			"utf8",
		);
		await writeFile(join(repository, "z-notes.md"), "z".repeat(30), "utf8");
		await writeFile(join(repository, "source.ts"), "s".repeat(30), "utf8");
		const defaults = getDefaultLocalContextCollectionOptions();
		const options: LocalContextCollectionOptions = {
			...defaults,
			limits: {
				...defaults.limits,
				maxContentBytesPerRoot: 25,
				maxTotalContentBytes: 25,
			},
		};
		const bundle = await collectLocalContextBundle(
			repository,
			options,
			fixedEnvironment(),
		);

		expect(getFile(bundle, "repository", "AGENTS.md").content.status).toBe(
			"available",
		);
		expect(getFile(bundle, "repository", "z-notes.md").content.status).toBe(
			"omitted",
		);
		expect(bundle.manifest.coverage.limitsReached).toContain(
			"maxTotalContentBytes",
		);
	});

	test("keeps absent, excluded, and truncated context discovery distinct", async () => {
		const absentRepository = await createEmptyRepository();
		const absent = await collectLocalContextBundle(
			absentRepository,
			getDefaultLocalContextCollectionOptions(),
			fixedEnvironment(),
		);
		const absentAgents = absent.manifest.contextIndex.facets.find(
			(facet) =>
				facet.rootId === "repository" && facet.kind === "agents-instructions",
		);
		assert(absentAgents);
		expect(absentAgents.presence).toBe("absent");
		expect(absentAgents.coverage).toBe("complete");

		await writeFile(join(absentRepository, "AGENTS.md"), "# Instructions\n");
		await writeFile(join(absentRepository, "CLAUDE.md"), "# Instructions\n");
		const defaults = getDefaultLocalContextCollectionOptions();
		const excluded = await collectLocalContextBundle(
			absentRepository,
			{ ...defaults, excludedPathPrefixes: ["AGENTS.md"] },
			fixedEnvironment(),
		);
		const excludedAgents = excluded.manifest.contextIndex.facets.find(
			(facet) =>
				facet.rootId === "repository" && facet.kind === "agents-instructions",
		);
		assert(excludedAgents);
		expect(excludedAgents.presence).toBe("unknown");
		expect(excludedAgents.coverage).toBe("excluded");

		const truncated = await collectLocalContextBundle(
			absentRepository,
			{
				...defaults,
				limits: { ...defaults.limits, maxEntriesPerRoot: 1 },
			},
			fixedEnvironment(),
		);
		const truncatedPlans = truncated.manifest.contextIndex.facets.find(
			(facet) => facet.rootId === "repository" && facet.kind === "plans",
		);
		assert(truncatedPlans);
		expect(truncatedPlans.presence).toBe("unknown");
		expect(truncatedPlans.coverage).toBe("truncated");

		const base = fixedEnvironment();
		const denied = await collectLocalContextBundle(absentRepository, defaults, {
			...base,
			fileSystem: {
				...base.fileSystem,
				readFileBounded: async (path, maxBytes) => {
					if (path.endsWith("/AGENTS.md")) {
						throw Object.assign(new Error("Permission denied"), {
							code: "EACCES",
						});
					}
					return base.fileSystem.readFileBounded(path, maxBytes);
				},
			},
		});
		const deniedAgents = denied.manifest.contextIndex.facets.find(
			(facet) =>
				facet.rootId === "repository" && facet.kind === "agents-instructions",
		);
		assert(deniedAgents);
		expect(deniedAgents.presence).toBe("present");
		expect(deniedAgents.coverage).toBe("denied");
		expect(deniedAgents.resources[0]?.access).toEqual({
			status: "denied",
			reason: "read-error",
		});

		await mkdir(join(absentRepository, "plans"), { recursive: true });
		await writeFile(
			join(absentRepository, "plans/binary-plan.md"),
			new Uint8Array([0, 1, 2]),
		);
		const unavailable = await collectLocalContextBundle(
			absentRepository,
			defaults,
			fixedEnvironment(),
		);
		const unavailablePlan = unavailable.manifest.contextIndex.facets
			.find((facet) => facet.rootId === "repository" && facet.kind === "plans")
			?.resources.find((resource) => resource.path === "plans/binary-plan.md");
		assert(unavailablePlan);
		expect(unavailablePlan.access).toEqual({
			status: "unavailable",
			reason: "binary",
		});
	});

	test("flags a worktree mutation during the non-atomic scan interval", async () => {
		const fixture = await createRepositoryFixture();
		const base = createLocalContextSourceEnv();
		let initialStatusObserved = false;
		let clockCall = 0;
		const start = new Date("2026-09-18T12:00:00.000Z");
		const completion = new Date("2026-09-18T12:00:01.000Z");
		const bundle = await collectLocalContextBundle(
			fixture.repository,
			getFixtureOptions(fixture),
			{
				...base,
				createCaptureId: () => "capture-concurrent-change",
				now: () => {
					const value = clockCall === 0 ? start : completion;
					clockCall += 1;
					return value;
				},
				git: {
					run: async (workingDirectory, args, maxOutputBytes, timeoutMs) => {
						const result = await base.git.run(
							workingDirectory,
							args,
							maxOutputBytes,
							timeoutMs,
						);
						if (args[0] === "status" && !initialStatusObserved) {
							initialStatusObserved = true;
							await writeFile(
								join(fixture.repository, "README.md"),
								"# Changed during collection\n",
							);
						}
						return result;
					},
				},
			},
		);

		expect(bundle.manifest.startedAt).toBe(start.toISOString());
		expect(bundle.manifest.completedAt).toBe(completion.toISOString());
		expect(bundle.manifest.consistency.status).toBe("concurrent-change");
		expect(bundle.manifest.consistency.initialStatusFingerprint).not.toBe(
			bundle.manifest.consistency.finalStatusFingerprint,
		);
		expect(bundle.manifest.coverage.partial).toBe(true);
		expect(bundle.manifest.coverage.partialReasons).toContain(
			"concurrent-change",
		);
	});

	test.each(["delta", "session-evidence"] as const)(
		"applies the same credential-path policy to %s filesystem content and both Git patches",
		async (capturePolicy) => {
			const repository = await createEmptyRepository();
			await mkdir(join(repository, "nested"));
			const credentialNames = [
				".env",
				".env.local",
				".env.example",
				".env.sample",
				".env.template",
				".npmrc",
				".netrc",
				".pypirc",
				"credentials.json",
				"service-account.json",
				"id_rsa",
				"id_ed25519",
				"private.pem",
				"private.key",
				"private.p12",
				"private.pfx",
			];
			const credentialPaths = credentialNames.flatMap((name) => [
				name,
				`nested/${name.toUpperCase()}`,
			]);
			const safePaths = [
				"environment.example",
				"nested/credentials.json.bak",
				"nested/private.pem.txt",
				"nested/.env-example",
			];
			const allPaths = [...credentialPaths, ...safePaths];
			for (const path of allPaths) {
				await writeFile(join(repository, path), "original content\n");
			}
			git(repository, ["add", "."]);
			git(repository, ["commit", "--no-gpg-sign", "-m", "initial"]);
			for (const path of allPaths) {
				await writeFile(join(repository, path), `staged edit for ${path}\n`);
			}
			git(repository, ["add", "."]);
			for (const path of allPaths) {
				await writeFile(join(repository, path), `working edit for ${path}\n`);
			}
			const bundle = await collectLocalContextBundle(
				repository,
				{ ...getDefaultLocalContextCollectionOptions(), capturePolicy },
				fixedEnvironment(),
			);

			assert(bundle.manifest.git.status === "available");
			expect(bundle.manifest.git.diffs.map((diff) => diff.kind).sort()).toEqual(
				["staged", "working-tree"],
			);
			for (const diff of bundle.manifest.git.diffs) {
				assert(diff.blobId);
				const patch = getBlob(bundle, diff.blobId).content;
				for (const path of credentialPaths) {
					expect(patch).not.toContain(`diff --git a/${path} b/${path}\n`);
				}
				for (const path of safePaths) {
					expect(patch).toContain(path);
				}
			}
			const allBlobText = bundle.blobs.map((blob) => blob.content).join("\n");
			for (const path of credentialPaths) {
				const file = getFile(bundle, "repository", path);
				expect(file.content).toEqual({
					status: "omitted",
					reason: "high-risk-path",
					detail: null,
				});
				expect(file.hash).toEqual({
					status: "omitted",
					reason: "high-risk-path",
				});
				expect(allBlobText).not.toContain(`edit for ${path}\n`);
			}
			for (const path of safePaths) {
				expect(getFile(bundle, "repository", path).content.status).toBe(
					capturePolicy === "delta" ? "available" : "omitted",
				);
			}
		},
	);

	test("applies explicit path exclusions to staged and working-tree patches", async () => {
		const repository = await createEmptyRepository();
		const excludedDirectories = ["private", ".rudel-config", "odd[x]"];
		for (const directory of [...excludedDirectories, "oddx", "private-other"]) {
			await mkdir(join(repository, directory), { recursive: true });
		}
		await mkdir(join(repository, "src"), { recursive: true });
		const trackedFiles = [
			"private/notes.txt",
			"private/moved-out.txt",
			"private/staged.txt",
			".rudel-config/state.json",
			"odd[x]/literal.txt",
			"oddx/visible.txt",
			"private-other/visible.txt",
			"src/app.ts",
			"src/moved-in.txt",
		];
		for (const [index, path] of trackedFiles.entries()) {
			await writeFile(join(repository, path), `original content ${index}\n`);
		}
		git(repository, ["add", "."]);
		git(repository, ["commit", "--no-gpg-sign", "-m", "initial"]);

		const workingTreeCanary = "WORKING_EXCLUDED_CANARY_7f3a";
		const stagedCanary = "STAGED_EXCLUDED_CANARY_91bc";
		for (const path of [
			"private/notes.txt",
			".rudel-config/state.json",
			"odd[x]/literal.txt",
		]) {
			await writeFile(
				join(repository, path),
				`${workingTreeCanary} ${path.length}\n`,
			);
		}
		for (const path of ["oddx/visible.txt", "private-other/visible.txt"]) {
			await writeFile(
				join(repository, path),
				`changed visible ${path.length}\n`,
			);
		}
		await writeFile(join(repository, "src/app.ts"), "export const a = 2;\n");
		await writeFile(
			join(repository, "private/staged.txt"),
			`${stagedCanary} staged in excluded directory\n`,
		);
		git(repository, ["add", "private/staged.txt"]);
		git(repository, ["mv", "src/moved-in.txt", "private/moved-in.txt"]);
		git(repository, ["mv", "private/moved-out.txt", "src/moved-out.txt"]);
		await writeFile(
			join(repository, "src/staged.ts"),
			"export const staged = true;\n",
		);
		git(repository, ["add", "src/staged.ts"]);

		const bundle = await collectLocalContextBundle(
			repository,
			{
				...getDefaultLocalContextCollectionOptions(),
				excludedPathPrefixes: excludedDirectories,
			},
			fixedEnvironment(),
		);

		assert(bundle.manifest.git.status === "available");
		const patches = bundle.manifest.git.diffs.map((diff) => {
			assert(diff.blobId !== null);
			return getBlob(bundle, diff.blobId).content;
		});
		const allPatchText = patches.join("\n");
		expect(patches).toHaveLength(2);
		for (const hidden of [
			workingTreeCanary,
			stagedCanary,
			"private/notes.txt",
			"private/moved-out.txt",
			"private/moved-in.txt",
			"private/staged.txt",
			".rudel-config",
			"odd[x]",
			"literal.txt",
		]) {
			expect(allPatchText).not.toContain(hidden);
		}
		for (const visible of [
			"oddx/visible.txt",
			"private-other/visible.txt",
			"src/app.ts",
			"src/staged.ts",
		]) {
			expect(allPatchText).toContain(visible);
		}
		expect(bundle.blobs.map((blob) => blob.content).join("\n")).not.toContain(
			workingTreeCanary,
		);
	});

	for (const statusFault of ["failed", "truncated"]) {
		test(`fails closed when initial Git status is ${statusFault}`, async () => {
			const fixture = await createRepositoryFixture();
			const base = createLocalContextSourceEnv();
			let faultInjected = false;
			const bundle = await collectLocalContextBundle(
				fixture.repository,
				getFixtureOptions(fixture),
				{
					...base,
					git: {
						run: async (workingDirectory, args, maxOutputBytes, timeoutMs) => {
							const result = await base.git.run(
								workingDirectory,
								args,
								maxOutputBytes,
								timeoutMs,
							);
							if (args[0] !== "status" || faultInjected) return result;
							faultInjected = true;
							return statusFault === "failed"
								? { ...result, exitCode: 1 }
								: { ...result, truncated: true };
						},
					},
				},
			);

			const readme = getFile(bundle, "repository", "README.md");
			expect(readme.gitProvenance).toBe("tracked");
			expect(readme.content.status).toBe("available");
			expect(readme.hash.status).toBe("available");
			expect(bundle.manifest.coverage.gitObjectBytes).toBe(0);
			expect(bundle.manifest.consistency.status).not.toBe("stable");
		});
	}
});

interface RepositoryFixture {
	readonly repository: string;
	readonly userSkills: string;
	readonly userPlans: string;
	readonly missingRoot: string;
	readonly nestedRepository: string;
	readonly secretCanary: string;
	readonly submoduleCommit: string;
}

async function createRepositoryFixture(): Promise<RepositoryFixture> {
	const container = await createTestDirectory();
	const repository = join(container, "repo");
	const userSkills = join(container, "user-skills");
	const userPlans = join(container, "authorized-context");
	const outside = join(container, "outside.md");
	const submoduleSource = join(container, "submodule-source");
	const nestedRepository = join(repository, "nested-repository");
	const nestedWorktree = join(repository, "nested-worktree");
	const secretCanary = "AKIACANARY234567ABCD";
	await mkdir(submoduleSource, { recursive: true });
	initializeGitRepository(submoduleSource);
	await writeFile(join(submoduleSource, "inside.md"), "# Nested repository\n");
	git(submoduleSource, ["add", "inside.md"]);
	git(submoduleSource, ["commit", "--no-gpg-sign", "-m", "nested fixture"]);
	const submoduleCommit = git(submoduleSource, ["rev-parse", "HEAD"]).trim();
	await mkdir(join(repository, "src"), { recursive: true });
	await mkdir(join(repository, ".claude/skills/demo/references"), {
		recursive: true,
	});
	await mkdir(join(repository, ".github/instructions/nested"), {
		recursive: true,
	});
	await mkdir(join(repository, ".claude/hooks"), { recursive: true });
	await mkdir(join(repository, "plans"), { recursive: true });
	await mkdir(join(repository, "node_modules/example"), { recursive: true });
	await mkdir(join(userSkills, "demo"), { recursive: true });
	await mkdir(join(userSkills, "cached-plugin/skill"), { recursive: true });
	await mkdir(userPlans, { recursive: true });
	await writeFile(
		join(repository, ".gitignore"),
		"ignored-notes.md\nnode_modules/\n",
	);
	await writeFile(join(repository, "README.md"), "# Fixture\n");
	await writeFile(join(repository, "AGENTS.md"), "# Agent instructions\n");
	await writeFile(join(repository, "CLAUDE.md"), "# Claude instructions\n");
	await writeFile(join(repository, "package.json"), '{"name":"fixture"}\n');
	await writeFile(join(repository, ".mcp.json"), '{"mcpServers":{}}\n');
	await writeFile(
		join(repository, ".claude/hooks/session-end.json"),
		'{"event":"SessionEnd"}\n',
	);
	await writeFile(join(repository, "plans/implementation.md"), "# Plan\n");
	await writeFile(join(repository, ".env"), "TRACKED_ENV_ORIGINAL=value\n");
	await writeFile(join(repository, "private.PEM"), "PRIVATE_ORIGINAL\n");
	await writeFile(
		join(repository, "src/dirty.ts"),
		"export const value = 1;\n",
	);
	await writeFile(
		join(repository, ".claude/skills/demo/SKILL.md"),
		"# Demo skill\n",
	);
	await writeFile(
		join(repository, ".claude/skills/demo/references/guide.md"),
		"# Guide\n",
	);
	await writeFile(
		join(repository, ".github/instructions/nested/product.instructions.md"),
		"# Product instructions\n",
	);
	await writeSparseFile(join(repository, "huge-sparse.dat"), 8 * 1024 * 1024);
	initializeGitRepository(repository);
	git(repository, [
		"-c",
		"protocol.file.allow=always",
		"submodule",
		"add",
		"--quiet",
		submoduleSource,
		"components/nested",
	]);
	git(repository, [
		"-c",
		"protocol.file.allow=always",
		"submodule",
		"add",
		"--quiet",
		submoduleSource,
		"components/uninitialized",
	]);
	git(repository, [
		"-c",
		"protocol.file.allow=always",
		"submodule",
		"add",
		"--quiet",
		submoduleSource,
		"vendor/nested-dependency",
	]);
	const remoteUrl = new URL("https://example.invalid/acme/repo.git");
	remoteUrl.username = "collector-user";
	remoteUrl.password = secretCanary;
	remoteUrl.searchParams.set("access_token", secretCanary);
	git(repository, ["remote", "add", "origin", remoteUrl.toString()]);
	git(repository, [
		"add",
		"-f",
		".gitignore",
		".env",
		"private.PEM",
		"README.md",
		"AGENTS.md",
		"CLAUDE.md",
		"package.json",
		".mcp.json",
		"plans",
		"src/dirty.ts",
		".claude",
		".github",
		"huge-sparse.dat",
	]);
	git(repository, [
		"commit",
		"--no-gpg-sign",
		"-m",
		`initial fixture ${secretCanary}`,
	]);
	git(repository, ["branch", "-m", `feature/${secretCanary}`]);
	await writeFile(
		join(repository, "components/nested/inside.md"),
		`# Nested repository\n${secretCanary}\n`,
	);
	await rm(join(repository, "components/uninitialized"), {
		recursive: true,
		force: true,
	});
	await mkdir(nestedRepository, { recursive: true });
	initializeGitRepository(nestedRepository);
	await writeFile(
		join(nestedRepository, "inside.md"),
		`# Nested repository\n${secretCanary}\n`,
	);
	git(nestedRepository, ["add", "inside.md"]);
	git(nestedRepository, ["commit", "--no-gpg-sign", "-m", "nested repository"]);
	git(submoduleSource, [
		"worktree",
		"add",
		"--quiet",
		"--detach",
		nestedWorktree,
		"HEAD",
	]);
	await writeFile(
		join(nestedWorktree, "inside.md"),
		`# Nested worktree\n${secretCanary}\n`,
	);

	await writeFile(
		join(repository, "src/dirty.ts"),
		`export const padding = "${"x".repeat(500)}";\nexport const token = "${secretCanary}";\n`,
	);
	await writeFile(
		join(repository, ".env"),
		"TRACKED_ENV_CHANGED_CANARY=value\n",
	);
	await writeFile(
		join(repository, "private.PEM"),
		"STAGED_PRIVATE_CHANGED_CANARY\n",
	);
	git(repository, ["add", "-f", "private.PEM"]);
	await writeFile(join(repository, "notes.md"), "# Untracked notes\n");
	await writeFile(join(repository, "staged.md"), "# Staged notes\n");
	git(repository, ["add", "staged.md"]);
	await writeFile(join(repository, "ignored-notes.md"), "# Ignored notes\n");
	await writeFile(join(repository, "odd\nname.md"), "# Weird path\n");
	await writeFile(join(repository, "binary.dat"), new Uint8Array([0, 1, 2, 3]));
	await writeFile(join(repository, ".env.local"), "API_KEY=do-not-collect\n");
	await writeFile(outside, "# Outside\n");
	await symlink(outside, join(repository, "external-link.md"));
	await writeFile(
		join(repository, "node_modules/example/dependency-error.md"),
		"# Exact dependency evidence\n",
	);
	await writeFile(
		join(repository, "node_modules/example/unrelated.md"),
		"# Must stay excluded\n",
	);
	await symlink(outside, join(repository, "node_modules/example/escape.md"));
	await writeFile(join(userSkills, "demo/SKILL.md"), "# User skill\n");
	await writeFile(join(userSkills, "cached-plugin/.git"), "gitdir: cache\n");
	await writeFile(
		join(userSkills, "cached-plugin/skill/SKILL.md"),
		"# Cached plugin skill\n",
	);
	await writeFile(join(userPlans, "backlog.md"), "# Future work\n");
	return {
		repository,
		userSkills,
		userPlans,
		missingRoot: join(container, "missing"),
		nestedRepository,
		secretCanary,
		submoduleCommit,
	};
}

async function createEmptyRepository(): Promise<string> {
	const container = await createTestDirectory();
	const repository = join(container, "repo");
	await mkdir(repository, { recursive: true });
	initializeGitRepository(repository);
	return repository;
}

async function createTestDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "opaline-context-source-"));
	TEST_DIRECTORIES.push(directory);
	return directory;
}

async function writeSparseFile(path: string, size: number): Promise<void> {
	const handle = await open(path, "w");
	await handle.truncate(size);
	await handle.close();
}

function initializeGitRepository(repository: string): void {
	git(repository, ["init", "--quiet"]);
	git(repository, ["config", "user.name", "Opaline Test"]);
	git(repository, ["config", "user.email", "opaline-test@example.invalid"]);
}

function git(repository: string, args: readonly string[]): string {
	const result = spawnSync("git", [...args], {
		cwd: repository,
		encoding: "utf8",
		env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
	});
	if (result.status !== 0) {
		throw new Error(`Git fixture command failed: ${result.stderr}`);
	}
	return result.stdout;
}

function getFixtureOptions(
	fixture: RepositoryFixture,
): LocalContextCollectionOptions {
	return {
		...getDefaultLocalContextCollectionOptions(),
		additionalRoots: [
			{
				id: "nested-repository-root",
				label: "Explicit nested repository",
				absolutePath: fixture.nestedRepository,
				origin: "user",
				scope: "custom",
			},
			{
				id: "user-skills",
				label: "User skills",
				absolutePath: fixture.userSkills,
				origin: "user",
				scope: "skills",
			},
			{
				id: "missing",
				label: "Missing configured context",
				absolutePath: fixture.missingRoot,
				origin: "user",
				scope: "custom",
			},
			{
				id: "user-plans",
				label: "User plans",
				absolutePath: fixture.userPlans,
				origin: "user",
				scope: "plans",
			},
		],
	};
}

function fixedEnvironment() {
	return {
		...createLocalContextSourceEnv(),
		now: () => FIXED_TIME,
	};
}

function captureEnvironment(captureId: string) {
	return {
		...fixedEnvironment(),
		createCaptureId: () => captureId,
	};
}

function getFile(
	bundle: LocalContextBundle,
	rootId: string,
	path: string,
): ContextRegularFileEntry {
	const entry = bundle.manifest.entries.find(
		(candidate) => candidate.rootId === rootId && candidate.path === path,
	);
	assert(entry?.kind === "file");
	return entry;
}

function getBlob(bundle: LocalContextBundle, id: string) {
	const blob = bundle.blobs.find((candidate) => candidate.id === id);
	assert(blob);
	return blob;
}
