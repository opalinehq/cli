import { createHash } from "node:crypto";
import { basename, dirname, relative, resolve, sep } from "node:path";
import type { BlobStore } from "./blob-store.js";
import { addSanitizedTextBlob } from "./blob-store.js";
import {
	getInstructionRank,
	getPluginDirectory,
	getSessionContentPriority,
	getSessionUserContextRank,
	INSTRUCTION_IMPORT_EVIDENCE_REASON,
	INSTRUCTION_INCLUDE_EVIDENCE_REASON,
	isFollowableContextSymlink,
	isObservedPlugin,
	isPluginCommandOrAgent,
	isSessionInstructionContent,
	isSessionToolResult,
	METADATA_INCLUDE_EVIDENCE_REASON,
	PLUGIN_SUPPORT_CAP_DETAIL,
	SESSION_INSTRUCTION_MAX_IMPORT_DEPTH,
	SESSION_OBSERVED_SKILL_SUPPORT_MAX_BYTES,
	SESSION_OBSERVED_SKILL_SUPPORT_MAX_FILES,
	SESSION_PLUGIN_SUPPORT_MAX_BYTES,
	SESSION_PLUGIN_SUPPORT_MAX_FILES,
	SESSION_SKILL_SUPPORT_MAX_BYTES,
	SESSION_SKILL_SUPPORT_MAX_FILES,
	SESSION_SUPPORT_MAX_FILES,
	SKILL_SUPPORT_CAP_DETAIL,
	SUPPORT_CAP_DETAIL,
} from "./capture-policy.js";
import {
	type GitCollectionResult,
	getGitFileProvenance,
} from "./git-collector.js";
import { findInstructionImports } from "./instruction-imports.js";
import {
	classifyContextPath,
	findSkillDirectories,
	getContentPriority,
	getParentPath,
	getPathExclusion,
	isHighRiskContentPath,
} from "./path-policy.js";
import type {
	ContextEntry,
	ContextFileCategory,
	ContextRegularFileEntry,
	ContextRootAlias,
	ContextRootInclude,
	ContextRootManifest,
	CoverageError,
	ExcludedPath,
	FileContent,
	FileHash,
	FileSystemEntry,
	FileSystemStat,
	GitFileProvenance,
	LocalContextCollectionOptions,
	LocalContextFileSystem,
	RootCoverage,
} from "./types.js";

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
// Only these limits leave a root's inventory incomplete. Content and hash caps
// are recorded per entry and cut only the facets those entries belong to.
const DISCOVERY_LIMITS: ReadonlySet<string> = new Set([
	"maxDepthPerRoot",
	"maxEntriesPerRoot",
	"maxTotalEntries",
]);

type ContentPool = "general" | "instruction" | "user-context" | "tool-result";
type DedicatedPool = Exclude<ContentPool, "general">;

/** Session-evidence content pools with budgets of their own. */
export interface DedicatedContentPools {
	readonly instruction: BlobStore | null;
	readonly userContext: BlobStore | null;
	readonly toolResult: BlobStore | null;
}

interface DedicatedPoolLimits {
	readonly maxFileBytes: number;
	readonly maxTotalBytes: number;
	readonly filesLimit: string;
	readonly bytesLimit: string;
}

interface PendingFile {
	readonly result: {
		readonly root: RootSpec;
		readonly skillDirectories: readonly string[];
		readonly coverage: MutableRootCoverage;
	};
	readonly entry: DiscoveredEntry;
	readonly categories: readonly ContextFileCategory[];
	readonly rootOrder: number;
	/** The skill directory holding this file, if any. */
	readonly skillDirectory: string | null;
}

interface RootSpec {
	readonly id: string;
	readonly label: string;
	readonly absolutePath: string;
	readonly origin: ContextRootManifest["origin"];
	readonly scope: ContextRootManifest["scope"];
	readonly include?: readonly ContextRootInclude[];
	readonly followSymlinksWithin?: string;
	readonly aliases?: readonly ContextRootAlias[];
}

interface DiscoveredEntry {
	readonly rootId: string;
	readonly absolutePath: string;
	readonly path: string;
	readonly stat: FileSystemStat;
	readonly evidenceReason: string | null;
	/** A directory symlink whose target was walked under this path. */
	readonly followed?: boolean;
}

interface PendingDirectory {
	readonly absolutePath: string;
	readonly relativePath: string;
	readonly depth: number;
	/** Inside a Git-ignored directory: walked after all other content. */
	readonly ignored: boolean;
}

interface RootWalk {
	readonly root: RootSpec;
	readonly discovered: DiscoveredEntry[];
	readonly deferred: PendingDirectory[];
	readonly ignoredDirectories: ReadonlySet<string>;
	readonly coverage: MutableRootCoverage;
	/** Canonical targets of followed symlinks, so each is walked once. */
	readonly followedTargets: Set<string>;
}

interface MutableRootCoverage {
	enumeratedEntries: number;
	discoveredEntries: number;
	fileCount: number;
	directoryCount: number;
	submoduleCount: number;
	symlinkCount: number;
	otherCount: number;
	contentFiles: number;
	contentBytes: number;
	generalContentBytes: number;
	hashedFiles: number;
	hashedBytes: number;
	omittedContentFiles: number;
	excludedPaths: number;
	limitsReached: Set<string>;
}

interface MutableAggregate {
	totalEnumeratedEntries: number;
	totalEntries: number;
	contentBudgetBytes: number;
	poolBudgetBytes: Record<DedicatedPool, number>;
	hashBudgetBytes: number;
	inventoryBytes: number;
	materializedBytes: number;
	reusedBytes: number;
	gitObjectBytes: number;
	omittedBytes: number;
}

export interface FileSystemCollectionResult {
	readonly roots: readonly ContextRootManifest[];
	readonly entries: readonly ContextEntry[];
	readonly excludedPaths: readonly ExcludedPath[];
	readonly errors: readonly CoverageError[];
	readonly aggregate: {
		readonly inventoryBytes: number;
		readonly materializedBytes: number;
		readonly reusedBytes: number;
		readonly gitObjectBytes: number;
		readonly omittedBytes: number;
	};
}

export async function collectFileSystemContext(
	repositoryRoot: string,
	options: LocalContextCollectionOptions,
	fileSystem: LocalContextFileSystem,
	git: GitCollectionResult,
	blobStore: BlobStore,
	pools: DedicatedContentPools = {
		instruction: null,
		userContext: null,
		toolResult: null,
	},
): Promise<FileSystemCollectionResult> {
	const rootSpecs: readonly RootSpec[] = [
		{
			id: "repository",
			label: "Repository",
			absolutePath: repositoryRoot,
			origin: "repository",
			scope: "repository",
			followSymlinksWithin: repositoryRoot,
		},
		...options.additionalRoots
			.map((root) => ({ ...root }))
			.sort((left, right) => compareStrings(left.id, right.id)),
	];
	const entries: ContextEntry[] = [];
	const excludedPaths: ExcludedPath[] = [];
	const errors: CoverageError[] = [];
	const aggregate: MutableAggregate = {
		totalEnumeratedEntries: 0,
		totalEntries: 0,
		contentBudgetBytes: 0,
		poolBudgetBytes: { instruction: 0, "user-context": 0, "tool-result": 0 },
		hashBudgetBytes: 0,
		inventoryBytes: 0,
		materializedBytes: 0,
		reusedBytes: 0,
		gitObjectBytes: 0,
		omittedBytes: 0,
	};

	const walks = [];
	for (const rootSpec of rootSpecs) {
		walks.push(
			await discoverRoot(
				rootSpec,
				options,
				fileSystem,
				git,
				aggregate,
				excludedPaths,
				errors,
			),
		);
	}
	// Git-ignored directories (agent scratch space, local data, build output
	// that is not excluded by name) are walked last, with whatever entry budget
	// remains after every root's own content. What does not fit is recorded as
	// an ignored exclusion, not as a cut of the repository's inventory.
	for (const walk of walks) {
		if (walk.walk === null || walk.walk.deferred.length === 0) continue;
		await walkDirectories(
			walk.walk,
			walk.walk.deferred.splice(0),
			options,
			fileSystem,
			git,
			aggregate,
			excludedPaths,
			errors,
		);
	}
	const collectedRoots = walks.map((walk) => ({
		root: walk.root,
		status: walk.status,
		coverage: walk.coverage,
		discovered: walk.walk?.discovered ?? [],
		skillDirectories: findSkillDirectories(
			(walk.walk?.discovered ?? []).map((entry) => entry.path),
		),
	}));
	// Plugin skills are observed as `plugin:skill`; their definitions live in
	// a directory named after the skill alone.
	const observedSkills = new Set(
		(options.observedSkillNames ?? []).flatMap((name) => {
			const separator = name.lastIndexOf(":");
			return separator < 0 ? [name] : [name, name.slice(separator + 1)];
		}),
	);
	const files: PendingFile[] = [];
	for (const [rootOrder, result] of collectedRoots.entries()) {
		for (const entry of result.discovered) {
			const categories = classifyContextPath(
				entry.path,
				result.skillDirectories,
				result.root.scope,
			);
			if (entry.stat.kind === "file") {
				files.push({
					result,
					entry,
					categories,
					rootOrder,
					skillDirectory: findSkillDirectory(
						entry.path,
						result.skillDirectories,
					),
				});
			} else {
				entries.push(
					await buildNonFileEntry(
						result.root,
						entry,
						result.skillDirectories,
						fileSystem,
						git,
						options,
						errors,
					),
				);
			}
		}
	}
	const sessionPriority = (file: PendingFile) =>
		getSessionContentPriority(
			file.entry.rootId,
			file.entry.path,
			file.categories,
			observedSkills,
		);
	const instructionRank = (file: PendingFile) =>
		sessionPriority(file) <= 0
			? getInstructionRank(file.entry.path, options.workingDirectory)
			: 0;
	files.sort((left, right) =>
		options.capturePolicy === "session-evidence"
			? sessionPriority(left) - sessionPriority(right) ||
				instructionRank(left) - instructionRank(right) ||
				compareStrings(
					`${left.entry.rootId}\0${left.entry.path}`,
					`${right.entry.rootId}\0${right.entry.path}`,
				)
			: left.rootOrder - right.rootOrder ||
				getContentPriority(left.categories) -
					getContentPriority(right.categories) ||
				compareStrings(left.entry.path, right.entry.path),
	);
	const sessionEvidence = options.capturePolicy === "session-evidence";
	const instructionStore = sessionEvidence ? pools.instruction : null;
	const poolStores: Readonly<Record<DedicatedPool, BlobStore | null>> = {
		instruction: instructionStore,
		"user-context": sessionEvidence ? pools.userContext : null,
		"tool-result": sessionEvidence ? pools.toolResult : null,
	};
	const processed = new Set<string>();
	const processFile = async (
		file: PendingFile,
		pool: ContentPool,
		policyOmission: string | null = null,
	): Promise<string | undefined> => {
		processed.add(getFileKey(file.entry));
		let text: string | undefined;
		const store = pool === "general" ? null : poolStores[pool];
		entries.push(
			await buildRegularFileEntry(
				file.result.root,
				file.entry,
				file.categories,
				observedSkills,
				options,
				fileSystem,
				git,
				store ?? blobStore,
				store === null ? "general" : pool,
				aggregate,
				file.result.coverage,
				errors,
				(captured) => {
					text = captured;
				},
				policyOmission,
			),
		);
		return text;
	};
	if (instructionStore !== null) {
		// Instruction files first, then the repository files they import
		// (breadth-first, bounded depth), all from the instruction pool.
		const repositoryFiles = new Map(
			files
				.filter((file) => file.entry.rootId === "repository")
				.map((file) => [file.entry.path, file]),
		);
		const queue: { readonly file: PendingFile; readonly depth: number }[] =
			files
				.filter((file) =>
					isSessionInstructionContent(
						file.entry.rootId,
						file.entry.path,
						file.categories,
						file.entry.evidenceReason,
					),
				)
				.map((file) => ({ file, depth: 0 }));
		const queued = new Set(queue.map((item) => getFileKey(item.file.entry)));
		for (let index = 0; index < queue.length; index += 1) {
			const item = queue[index];
			if (item === undefined) break;
			const text = await processFile(item.file, "instruction");
			// Imports are followed inside the repository; user-level roots list
			// the files their instructions import explicitly.
			if (
				text === undefined ||
				item.file.entry.rootId !== "repository" ||
				item.depth >= SESSION_INSTRUCTION_MAX_IMPORT_DEPTH
			)
				continue;
			for (const target of findInstructionImports(text, item.file.entry.path)) {
				const imported = repositoryFiles.get(target);
				if (imported === undefined) continue;
				const key = getFileKey(imported.entry);
				if (queued.has(key) || processed.has(key)) continue;
				const candidate: PendingFile = {
					...imported,
					entry: {
						...imported.entry,
						evidenceReason: INSTRUCTION_IMPORT_EVIDENCE_REASON,
					},
				};
				if (
					isHighRiskContentPath(candidate.entry.path) ||
					!isSessionInstructionContent(
						candidate.entry.rootId,
						candidate.entry.path,
						candidate.categories,
						candidate.entry.evidenceReason,
					)
				)
					continue;
				queued.add(key);
				queue.push({ file: candidate, depth: item.depth + 1 });
			}
		}
	}
	// Then the user-context pool in rank order (memory, user commands,
	// agents and output styles, observed skills, every other skill), then the
	// session's saved tool outputs, each from its own budget.
	if (poolStores["user-context"] !== null) {
		const ranked = files.flatMap((file) => {
			if (processed.has(getFileKey(file.entry))) return [];
			const rank = getSessionUserContextRank(
				file.entry.rootId,
				file.entry.path,
				file.categories,
				file.skillDirectory,
				observedSkills,
			);
			return rank === null || isHighRiskContentPath(file.entry.path)
				? []
				: [{ file, rank }];
		});
		ranked.sort(
			(left, right) =>
				left.rank - right.rank ||
				compareStrings(
					`${left.file.entry.rootId}\0${left.file.entry.path}`,
					`${right.file.entry.rootId}\0${right.file.entry.path}`,
				),
		);
		// Supporting files count against their skill's and (for plugins the
		// session did not use) their plugin's budget; beyond it they are
		// hash-only by policy.
		const supportBytes = new Map<string, number>();
		const supportFiles = new Map<string, number>();
		for (const { file } of ranked) {
			const budgets = getSupportBudgets(file, observedSkills);
			const exceeded = budgets.find(
				(budget) =>
					(supportBytes.get(budget.key) ?? 0) + file.entry.stat.size >
						budget.maxBytes ||
					(supportFiles.get(budget.key) ?? 0) >= budget.maxFiles,
			);
			const text = await processFile(
				file,
				"user-context",
				exceeded?.detail ?? null,
			);
			if (text === undefined) continue;
			const bytes = Buffer.byteLength(text);
			for (const budget of budgets) {
				supportBytes.set(
					budget.key,
					(supportBytes.get(budget.key) ?? 0) + bytes,
				);
				supportFiles.set(budget.key, (supportFiles.get(budget.key) ?? 0) + 1);
			}
		}
	}
	if (poolStores["tool-result"] !== null)
		for (const file of files)
			if (
				!processed.has(getFileKey(file.entry)) &&
				isSessionToolResult(file.entry.rootId)
			)
				await processFile(file, "tool-result");
	for (const file of files) {
		if (processed.has(getFileKey(file.entry))) continue;
		await processFile(file, "general");
	}
	const roots = collectedRoots.map((result) =>
		buildRootManifest(
			result.root,
			result.status ??
				([...result.coverage.limitsReached].some((limit) =>
					DISCOVERY_LIMITS.has(limit),
				)
					? "limit-reached"
					: "collected"),
			result.coverage,
		),
	);

	return {
		roots,
		entries: entries.sort(compareEntries),
		excludedPaths: excludedPaths.sort((left, right) =>
			compareStrings(
				`${left.rootId}\0${left.path}`,
				`${right.rootId}\0${right.path}`,
			),
		),
		errors: errors.sort((left, right) =>
			compareStrings(
				`${left.rootId}\0${left.path}\0${left.operation}`,
				`${right.rootId}\0${right.path}\0${right.operation}`,
			),
		),
		aggregate: {
			inventoryBytes: aggregate.inventoryBytes,
			materializedBytes: aggregate.materializedBytes,
			reusedBytes: aggregate.reusedBytes,
			gitObjectBytes: aggregate.gitObjectBytes,
			omittedBytes: aggregate.omittedBytes,
		},
	};
}

async function discoverRoot(
	rootSpec: RootSpec,
	options: LocalContextCollectionOptions,
	fileSystem: LocalContextFileSystem,
	git: GitCollectionResult,
	aggregate: MutableAggregate,
	excludedPaths: ExcludedPath[],
	errors: CoverageError[],
): Promise<{
	readonly root: RootSpec;
	readonly status: "missing" | "inaccessible" | "excluded" | null;
	readonly coverage: MutableRootCoverage;
	readonly walk: RootWalk | null;
}> {
	const coverage = createMutableRootCoverage();
	const canonicalRoot = await resolveRoot(
		rootSpec,
		fileSystem,
		errors,
		options,
	);
	if (canonicalRoot.status !== "available") {
		return {
			root: rootSpec,
			status: canonicalRoot.status,
			coverage,
			walk: null,
		};
	}
	// A root that resolves outside its boundary (for example ~/.claude/skills
	// linked outside \$HOME) is not read at all.
	const boundary = await resolveSymlinkBoundary(rootSpec, fileSystem);
	if (boundary !== null && !isContainedPath(boundary, canonicalRoot.path)) {
		excludedPaths.push({
			rootId: rootSpec.id,
			path: "",
			reason: "outside-boundary",
		});
		coverage.excludedPaths += 1;
		return { root: rootSpec, status: "excluded", coverage, walk: null };
	}
	const root = { ...rootSpec, absolutePath: canonicalRoot.path };
	const walk: RootWalk = {
		root,
		discovered: [],
		deferred: [],
		ignoredDirectories:
			root.id === "repository" ? getIgnoredDirectories(git) : new Set(),
		coverage,
		followedTargets: new Set([canonicalRoot.path]),
	};
	await walkDirectories(
		walk,
		root.include === undefined
			? [
					{
						absolutePath: root.absolutePath,
						relativePath: "",
						depth: 0,
						ignored: false,
					},
				]
			: await discoverIncludes(
					walk,
					root.include,
					options,
					fileSystem,
					aggregate,
					excludedPaths,
					errors,
				),
		options,
		fileSystem,
		git,
		aggregate,
		excludedPaths,
		errors,
	);
	addUndiscoveredSubmodules(
		root,
		walk.discovered,
		options,
		git,
		aggregate,
		coverage,
	);
	return { root, status: null, coverage, walk };
}

/**
 * Adds the explicitly included files of a root and returns the included
 * directories for the regular walk. Missing paths are simply absent.
 */
async function discoverIncludes(
	walk: RootWalk,
	includes: readonly ContextRootInclude[],
	options: LocalContextCollectionOptions,
	fileSystem: LocalContextFileSystem,
	aggregate: MutableAggregate,
	excludedPaths: ExcludedPath[],
	errors: CoverageError[],
): Promise<PendingDirectory[]> {
	const { root, coverage, discovered } = walk;
	const directories: PendingDirectory[] = [];
	const seen = new Set<string>();
	for (const include of [...includes].sort((left, right) =>
		compareStrings(left.path, right.path),
	)) {
		if (seen.has(include.path)) continue;
		seen.add(include.path);
		const absolutePath = resolve(root.absolutePath, include.path);
		if (!isContainedPath(root.absolutePath, absolutePath)) continue;
		// The included path's real location (through any symlinked directory
		// on the way) must stay inside the root's boundary too.
		if (!(await isWithinSymlinkBoundary(walk, absolutePath, fileSystem))) {
			excludedPaths.push({
				rootId: root.id,
				path: include.path,
				reason: "outside-boundary",
			});
			coverage.excludedPaths += 1;
			continue;
		}
		let stat: FileSystemStat;
		try {
			stat = await fileSystem.lstat(absolutePath);
		} catch (error) {
			const normalized = normalizeError(error);
			if (normalized.code !== "ENOENT" && normalized.code !== "ENOTDIR")
				pushFileSystemError(
					errors,
					root.id,
					include.path,
					"lstat",
					error,
					options,
				);
			continue;
		}
		if (
			coverage.discoveredEntries >= options.limits.maxEntriesPerRoot ||
			aggregate.totalEntries >= options.limits.maxTotalEntries
		) {
			coverage.limitsReached.add(
				coverage.discoveredEntries >= options.limits.maxEntriesPerRoot
					? "maxEntriesPerRoot"
					: "maxTotalEntries",
			);
			break;
		}
		// An included tree may itself be a directory symlink (for example
		// ~/.claude/rules linked to a shared checkout).
		const followedTarget =
			stat.kind === "symlink" && include.role === "tree"
				? await resolveFollowedSymlink(
						walk,
						absolutePath,
						include.path,
						options,
						fileSystem,
					)
				: null;
		discovered.push({
			rootId: root.id,
			absolutePath,
			path: include.path,
			stat,
			evidenceReason:
				stat.kind === "file" && include.role === "instruction"
					? INSTRUCTION_INCLUDE_EVIDENCE_REASON
					: stat.kind === "file" && include.role === "metadata"
						? METADATA_INCLUDE_EVIDENCE_REASON
						: null,
			...(followedTarget === null ? {} : { followed: true }),
		});
		countDiscoveredEntry(stat, coverage, aggregate);
		if (
			(stat.kind === "directory" || followedTarget !== null) &&
			include.role === "tree"
		)
			directories.push({
				absolutePath: followedTarget ?? absolutePath,
				relativePath: include.path,
				depth: include.path.split("/").length,
				ignored: false,
			});
	}
	return directories;
}

async function resolveRoot(
	root: RootSpec,
	fileSystem: LocalContextFileSystem,
	errors: CoverageError[],
	options: LocalContextCollectionOptions,
): Promise<
	| { readonly status: "available"; readonly path: string }
	| { readonly status: "missing" | "inaccessible" }
> {
	try {
		const canonical = await fileSystem.realpath(root.absolutePath);
		const stat = await fileSystem.lstat(canonical);
		if (stat.kind !== "directory") {
			pushCoverageError(
				errors,
				{
					rootId: root.id,
					path: "",
					operation: "root",
					code: "ENOTDIR",
					message: "Context roots must be directories.",
				},
				options,
			);
			return { status: "inaccessible" };
		}
		return { status: "available", path: canonical };
	} catch (error) {
		const normalized = normalizeError(error);
		// A missing root is an absent source, not a capture error.
		if (normalized.code === "ENOENT") return { status: "missing" };
		pushCoverageError(
			errors,
			{
				rootId: root.id,
				path: "",
				operation: "root",
				code: normalized.code,
				message: normalized.message,
			},
			options,
		);
		return { status: "inaccessible" };
	}
}

/**
 * Breadth-first walk of one root. Directories inside Git-ignored directories
 * are queued on the walk's deferred list during the first pass and walked in
 * a second pass (`queue` then holds only ignored directories). A discovery
 * limit reached during the first pass truncates the root; reached during the
 * second pass it only excludes the ignored directories that did not fit.
 */
async function walkDirectories(
	walk: RootWalk,
	queue: PendingDirectory[],
	options: LocalContextCollectionOptions,
	fileSystem: LocalContextFileSystem,
	git: GitCollectionResult,
	aggregate: MutableAggregate,
	excludedPaths: ExcludedPath[],
	errors: CoverageError[],
): Promise<void> {
	const { root, coverage, discovered } = walk;
	const excludeIgnored = (
		directories: readonly PendingDirectory[],
		limit: string,
	) => {
		for (const directory of directories) {
			excludedPaths.push({
				rootId: root.id,
				path: directory.relativePath,
				reason: "ignored",
			});
			coverage.excludedPaths += 1;
		}
		coverage.limitsReached.add(`${limit}:ignored`);
	};
	const stopAtEntryLimit = (directory: PendingDirectory, limit: string) => {
		if (directory.ignored) {
			excludeIgnored([directory, ...queue.splice(0)], limit);
		} else {
			coverage.limitsReached.add(limit);
		}
	};

	while (queue.length > 0) {
		const directory = queue.shift();
		if (directory === undefined) break;
		if (
			root.id === "repository" &&
			directory.relativePath.length > 0 &&
			(await isNestedGitBoundary(
				directory,
				fileSystem,
				options,
				errors,
				root.id,
			))
		) {
			excludedPaths.push({
				rootId: root.id,
				path: directory.relativePath,
				reason: "vcs",
			});
			coverage.excludedPaths += 1;
			continue;
		}
		const remainingEntries = Math.min(
			options.limits.maxEntriesPerRoot - coverage.enumeratedEntries,
			options.limits.maxTotalEntries - aggregate.totalEnumeratedEntries,
		);
		const entryLimit =
			coverage.enumeratedEntries >= options.limits.maxEntriesPerRoot
				? "maxEntriesPerRoot"
				: "maxTotalEntries";
		if (remainingEntries <= 0) {
			stopAtEntryLimit(directory, entryLimit);
			return;
		}
		let children: FileSystemEntry[];
		let complete: boolean;
		try {
			({ entries: children, complete } = await fileSystem.readDirectory(
				directory.absolutePath,
				remainingEntries,
			));
			coverage.enumeratedEntries += children.length;
			aggregate.totalEnumeratedEntries += children.length;
			if (!complete) {
				const limit =
					coverage.enumeratedEntries >= options.limits.maxEntriesPerRoot
						? "maxEntriesPerRoot"
						: "maxTotalEntries";
				if (directory.ignored) excludeIgnored([directory], limit);
				else coverage.limitsReached.add(limit);
			}
		} catch (error) {
			pushFileSystemError(
				errors,
				root.id,
				directory.relativePath,
				"readdir",
				error,
				options,
			);
			continue;
		}
		for (const child of children.sort((left, right) =>
			compareStrings(left.name, right.name),
		)) {
			if (
				coverage.discoveredEntries >= options.limits.maxEntriesPerRoot ||
				aggregate.totalEntries >= options.limits.maxTotalEntries
			) {
				stopAtEntryLimit(
					directory,
					coverage.discoveredEntries >= options.limits.maxEntriesPerRoot
						? "maxEntriesPerRoot"
						: "maxTotalEntries",
				);
				return;
			}
			const relativePath = directory.relativePath
				? `${directory.relativePath}/${child.name}`
				: child.name;
			const exclusion = getPathExclusion(
				relativePath,
				options.excludedPathPrefixes,
			);
			if (exclusion.excluded && exclusion.reason !== null) {
				excludedPaths.push({
					rootId: root.id,
					path: relativePath,
					reason: exclusion.reason,
				});
				coverage.excludedPaths += 1;
				continue;
			}
			const absolutePath = resolve(directory.absolutePath, child.name);
			let stat: FileSystemStat;
			try {
				stat = await fileSystem.lstat(absolutePath);
			} catch (error) {
				pushFileSystemError(
					errors,
					root.id,
					relativePath,
					"lstat",
					error,
					options,
				);
				continue;
			}
			const followedTarget =
				stat.kind === "symlink"
					? await resolveFollowedSymlink(
							walk,
							absolutePath,
							relativePath,
							options,
							fileSystem,
						)
					: null;
			const entry: DiscoveredEntry = {
				rootId: root.id,
				absolutePath,
				path: relativePath,
				stat,
				evidenceReason: null,
				...(followedTarget === null ? {} : { followed: true }),
			};
			discovered.push(entry);
			const isSubmodule = isRegisteredSubmodule(root, relativePath, stat, git);
			countDiscoveredEntry(stat, coverage, aggregate, isSubmodule);

			if (
				(stat.kind === "directory" && !isSubmodule) ||
				followedTarget !== null
			) {
				const child: PendingDirectory = {
					absolutePath: followedTarget ?? absolutePath,
					relativePath,
					depth: directory.depth + 1,
					ignored:
						directory.ignored ||
						(walk.ignoredDirectories.has(relativePath) &&
							!isAgentContextDirectory(relativePath)),
				};
				if (child.depth >= options.limits.maxDepthPerRoot) {
					if (child.ignored) excludeIgnored([child], "maxDepthPerRoot");
					else coverage.limitsReached.add("maxDepthPerRoot");
				} else if (child.ignored && !directory.ignored) {
					walk.deferred.push(child);
				} else {
					queue.push(child);
				}
			}
		}
	}
}

/** Directories Git reports as ignored (`git status --ignored=matching`). */
function getIgnoredDirectories(git: GitCollectionResult): ReadonlySet<string> {
	if (git.snapshot.status !== "available") return new Set();
	return new Set(
		git.snapshot.statusEntries
			.filter((entry) => entry.kind === "ignored" && entry.path.endsWith("/"))
			.map((entry) => entry.path.slice(0, -1)),
	);
}

/** Agent configuration stays first-class even when a repository ignores it. */
function isAgentContextDirectory(relativePath: string): boolean {
	return relativePath
		.split("/")
		.some((segment) =>
			[".agents", ".claude", ".codex", ".cursor", ".github"].includes(segment),
		);
}

async function isNestedGitBoundary(
	directory: PendingDirectory,
	fileSystem: LocalContextFileSystem,
	options: LocalContextCollectionOptions,
	errors: CoverageError[],
	rootId: string,
): Promise<boolean> {
	try {
		await fileSystem.lstat(resolve(directory.absolutePath, ".git"));
		return true;
	} catch (error) {
		const normalized = normalizeError(error);
		if (normalized.code === "ENOENT" || normalized.code === "ENOTDIR") {
			return false;
		}
		pushCoverageError(
			errors,
			{
				rootId,
				path: `${directory.relativePath}/.git`,
				operation: "lstat",
				code: normalized.code,
				message: normalized.message,
			},
			options,
		);
		return true;
	}
}

function addUndiscoveredSubmodules(
	root: RootSpec,
	discovered: DiscoveredEntry[],
	options: LocalContextCollectionOptions,
	git: GitCollectionResult,
	aggregate: MutableAggregate,
	coverage: MutableRootCoverage,
): void {
	if (root.id !== "repository") return;
	const discoveredPaths = new Set(discovered.map((entry) => entry.path));
	for (const [path, indexEntry] of [...git.indexEntries.entries()].sort(
		([left], [right]) => compareStrings(left, right),
	)) {
		const exclusion = getPathExclusion(path, options.excludedPathPrefixes);
		if (
			indexEntry.mode !== "160000" ||
			discoveredPaths.has(path) ||
			exclusion.reason === "explicit"
		) {
			continue;
		}
		if (
			coverage.discoveredEntries >= options.limits.maxEntriesPerRoot ||
			aggregate.totalEntries >= options.limits.maxTotalEntries
		) {
			coverage.limitsReached.add(
				coverage.discoveredEntries >= options.limits.maxEntriesPerRoot
					? "maxEntriesPerRoot"
					: "maxTotalEntries",
			);
			return;
		}
		if (path.split("/").length > options.limits.maxDepthPerRoot) {
			coverage.limitsReached.add("maxDepthPerRoot");
			continue;
		}
		const absolutePath = resolve(root.absolutePath, path);
		if (!isContainedPath(root.absolutePath, absolutePath)) continue;
		const entry: DiscoveredEntry = {
			rootId: root.id,
			absolutePath,
			path,
			stat: {
				kind: "directory",
				size: 0,
				mode: Number.parseInt(indexEntry.mode, 8),
				modifiedAtMs: 0,
			},
			evidenceReason: null,
		};
		discovered.push(entry);
		discoveredPaths.add(path);
		countDiscoveredEntry(entry.stat, coverage, aggregate, true);
	}
}

async function buildNonFileEntry(
	root: RootSpec,
	entry: DiscoveredEntry,
	skillDirectories: readonly string[],
	fileSystem: LocalContextFileSystem,
	git: GitCollectionResult,
	options: LocalContextCollectionOptions,
	errors: CoverageError[],
): Promise<ContextEntry> {
	const categories = classifyContextPath(
		entry.path,
		skillDirectories,
		root.scope,
	);
	const base = buildEntryBase(root, entry, categories, git);
	const indexEntry =
		root.id === "repository" ? git.indexEntries.get(entry.path) : undefined;
	if (entry.stat.kind === "directory" && indexEntry?.mode === "160000") {
		const statusEntry =
			git.snapshot.status === "available"
				? git.snapshot.statusEntries.find(
						(status) => status.path === entry.path,
					)
				: undefined;
		return {
			...base,
			mode: Number.parseInt(indexEntry.mode, 8),
			kind: "submodule",
			objectId: indexEntry.objectId,
			objectFormat: git.objectFormat,
			indexStatus: statusEntry?.indexStatus ?? ".",
			worktreeStatus: statusEntry?.worktreeStatus ?? ".",
			followed: false,
		};
	}
	if (entry.stat.kind === "directory") return { ...base, kind: "directory" };
	if (entry.stat.kind === "other") {
		return { ...base, kind: "other", size: entry.stat.size };
	}
	try {
		const target = await fileSystem.readLink(entry.absolutePath);
		const resolvedTarget = resolve(dirname(entry.absolutePath), target);
		let targetScope: "internal" | "external" | "broken" | "unknown" =
			isContainedPath(root.absolutePath, resolvedTarget)
				? "internal"
				: "external";
		try {
			await fileSystem.lstat(resolvedTarget);
		} catch (error) {
			if (normalizeError(error).code === "ENOENT") targetScope = "broken";
		}
		return {
			...base,
			kind: "symlink",
			target,
			targetScope,
			followed: entry.followed === true,
		};
	} catch (error) {
		pushFileSystemError(
			errors,
			root.id,
			entry.path,
			"readlink",
			error,
			options,
		);
		return {
			...base,
			kind: "symlink",
			target: "",
			targetScope: "unknown",
			followed: false,
		};
	}
}

async function buildRegularFileEntry(
	root: RootSpec,
	entry: DiscoveredEntry,
	categories: readonly ContextFileCategory[],
	observedSkills: ReadonlySet<string>,
	options: LocalContextCollectionOptions,
	fileSystem: LocalContextFileSystem,
	git: GitCollectionResult,
	blobStore: BlobStore,
	pool: ContentPool,
	aggregate: MutableAggregate,
	coverage: MutableRootCoverage,
	errors: CoverageError[],
	onText: (text: string) => void,
	policyOmission: string | null = null,
): Promise<ContextRegularFileEntry> {
	const base = buildEntryBase(root, entry, categories, git);
	if (isHighRiskContentPath(entry.path)) {
		coverage.omittedContentFiles += 1;
		aggregate.omittedBytes += entry.stat.size;
		return {
			...base,
			kind: "file",
			size: entry.stat.size,
			hash: { status: "omitted", reason: "high-risk-path" },
			content: { status: "omitted", reason: "high-risk-path", detail: null },
		};
	}

	const indexEntry =
		root.id === "repository" ? git.indexEntries.get(entry.path) : undefined;
	if (
		options.capturePolicy === "delta" &&
		git.canReuseGitObjects &&
		indexEntry !== undefined &&
		indexEntry.stage === 0 &&
		!git.dirtyPaths.has(entry.path) &&
		git.headCommit !== null
	) {
		coverage.hashedFiles += 1;
		coverage.hashedBytes += entry.stat.size;
		aggregate.gitObjectBytes += entry.stat.size;
		return {
			...base,
			kind: "file",
			size: entry.stat.size,
			hash: {
				status: "git-object",
				algorithm:
					git.objectFormat === "sha1"
						? "git-sha1"
						: git.objectFormat === "sha256"
							? "git-sha256"
							: "git-unknown",
				value: indexEntry.objectId,
				bytesHashed: entry.stat.size,
			},
			content: {
				status: "git-object",
				objectId: indexEntry.objectId,
				objectFormat: git.objectFormat,
				commit: git.headCommit,
				sourceByteLength: entry.stat.size,
			},
		};
	}

	if (
		policyOmission !== null ||
		(options.capturePolicy === "session-evidence" &&
			pool === "general" &&
			(entry.evidenceReason === METADATA_INCLUDE_EVIDENCE_REASON ||
				// User-level agent settings may hold credentials: only their
				// instruction files are captured, the rest is hashed (a filtered
				// summary of hooks, MCP servers and plugins is added separately).
				root.scope === "agent-config" ||
				getSessionContentPriority(
					root.id,
					entry.path,
					categories,
					observedSkills,
				) >= 4))
	) {
		coverage.omittedContentFiles += 1;
		aggregate.omittedBytes += entry.stat.size;
		return {
			...base,
			kind: "file",
			size: entry.stat.size,
			hash: await hashOmittedContent(
				entry,
				fileSystem,
				coverage,
				aggregate,
				options,
				errors,
			),
			content: {
				status: "omitted",
				reason: "metadata-only",
				detail: policyOmission,
			},
		};
	}

	const contentLimitReason =
		pool === "general"
			? getContentLimitReason(entry.stat.size, coverage, aggregate, options)
			: getPoolLimitReason(pool, entry.stat.size, coverage, aggregate, options);
	if (contentLimitReason !== null) {
		coverage.omittedContentFiles += 1;
		aggregate.omittedBytes += entry.stat.size;
		return {
			...base,
			kind: "file",
			size: entry.stat.size,
			hash: await hashOmittedContent(
				entry,
				fileSystem,
				coverage,
				aggregate,
				options,
				errors,
			),
			content: { status: "omitted", reason: contentLimitReason, detail: null },
		};
	}

	try {
		const read = await fileSystem.readFileBounded(
			entry.absolutePath,
			pool === "general"
				? options.limits.maxContentBytesPerFile
				: getDedicatedPoolLimits(pool, options).maxFileBytes,
		);
		if (!read.complete) {
			coverage.omittedContentFiles += 1;
			aggregate.omittedBytes += entry.stat.size;
			return {
				...base,
				kind: "file",
				size: entry.stat.size,
				hash: await hashOmittedContent(
					entry,
					fileSystem,
					coverage,
					aggregate,
					options,
					errors,
				),
				content: {
					status: "omitted",
					reason: "file-content-cap",
					detail: "File grew while it was being collected.",
				},
			};
		}
		if (isBinary(read.bytes, options.limits.binaryProbeBytes)) {
			const digest = createHash("sha256").update(read.bytes).digest("hex");
			coverage.hashedFiles += 1;
			coverage.hashedBytes += read.bytes.byteLength;
			aggregate.hashBudgetBytes += read.bytes.byteLength;
			coverage.omittedContentFiles += 1;
			aggregate.omittedBytes += entry.stat.size;
			return {
				...base,
				kind: "file",
				size: entry.stat.size,
				hash: {
					status: "available",
					algorithm: "sha256",
					value: digest,
					bytesHashed: read.bytes.byteLength,
					scope: "source",
				},
				content: { status: "omitted", reason: "binary", detail: null },
			};
		}
		const decoded = UTF8_DECODER.decode(read.bytes);
		const text =
			pool === "tool-result" && options.transformToolResultText
				? options.transformToolResultText(decoded)
				: decoded;
		const sanitized = addSanitizedTextBlob(
			text,
			read.bytes.byteLength,
			blobStore,
		);
		if (sanitized.status === "failure") {
			if (sanitized.reason === "blob-count-cap")
				coverage.limitsReached.add(
					pool === "general"
						? "maxBlobs"
						: getDedicatedPoolLimits(pool, options).filesLimit,
				);
			if (sanitized.reason === "total-content-cap")
				coverage.limitsReached.add(
					pool === "general"
						? "maxTotalContentBytes"
						: getDedicatedPoolLimits(pool, options).bytesLimit,
				);
			coverage.omittedContentFiles += 1;
			aggregate.omittedBytes += entry.stat.size;
			return {
				...base,
				kind: "file",
				size: entry.stat.size,
				hash:
					sanitized.reason === "blob-count-cap" ||
					sanitized.reason === "total-content-cap"
						? await hashOmittedContent(
								entry,
								fileSystem,
								coverage,
								aggregate,
								options,
								errors,
							)
						: { status: "omitted", reason: "read-error" },
				content: {
					status: "omitted",
					reason: sanitized.reason,
					detail: sanitized.detail,
				},
			};
		}
		coverage.contentFiles += 1;
		coverage.contentBytes += sanitized.storedByteLength;
		coverage.hashedFiles += 1;
		coverage.hashedBytes += sanitized.storedByteLength;
		if (pool !== "general") {
			aggregate.poolBudgetBytes[pool] += read.bytes.byteLength;
		} else {
			coverage.generalContentBytes += sanitized.storedByteLength;
			aggregate.contentBudgetBytes += read.bytes.byteLength;
		}
		aggregate.hashBudgetBytes += sanitized.storedByteLength;
		onText(text);
		if (sanitized.reused) {
			aggregate.reusedBytes += sanitized.storedByteLength;
		} else {
			aggregate.materializedBytes += sanitized.storedByteLength;
		}
		return {
			...base,
			kind: "file",
			size: entry.stat.size,
			hash: {
				status: "available",
				algorithm: "sha256",
				value: sanitized.blobId.slice("sha256:".length),
				bytesHashed: sanitized.storedByteLength,
				scope: "stored",
			},
			content: buildAvailableContent(sanitized, blobStore),
		};
	} catch (error) {
		pushFileSystemError(errors, root.id, entry.path, "read", error, options);
		coverage.omittedContentFiles += 1;
		aggregate.omittedBytes += entry.stat.size;
		return {
			...base,
			kind: "file",
			size: entry.stat.size,
			hash: { status: "omitted", reason: "read-error" },
			content: {
				status: "omitted",
				reason: "read-error",
				detail: normalizeError(error).message,
			},
		};
	}
}

function buildAvailableContent(
	result: Extract<
		ReturnType<typeof addSanitizedTextBlob>,
		{ status: "available" }
	>,
	blobStore: BlobStore,
): FileContent {
	if (result.reused && blobStore.parentCaptureId !== null) {
		return {
			status: "reused",
			blobId: result.blobId,
			parentCaptureId: blobStore.parentCaptureId,
			sourceByteLength: result.sourceByteLength,
			storedByteLength: result.storedByteLength,
			encoding: "utf-8",
			secretFilter: result.secretFilter,
		};
	}
	return {
		status: "available",
		blobId: result.blobId,
		sourceByteLength: result.sourceByteLength,
		storedByteLength: result.storedByteLength,
		encoding: "utf-8",
		secretFilter: result.secretFilter,
	};
}

async function hashOmittedContent(
	entry: DiscoveredEntry,
	fileSystem: LocalContextFileSystem,
	coverage: MutableRootCoverage,
	aggregate: MutableAggregate,
	options: LocalContextCollectionOptions,
	errors: CoverageError[],
): Promise<FileHash> {
	const reason = getHashLimitReason(
		entry.stat.size,
		coverage,
		aggregate,
		options,
	);
	if (reason !== null) return { status: "omitted", reason };
	try {
		const hash = await fileSystem.hashFileBounded(
			entry.absolutePath,
			options.limits.maxHashBytesPerFile,
		);
		if (!hash.complete) return { status: "omitted", reason: "hash-file-cap" };
		coverage.hashedFiles += 1;
		coverage.hashedBytes += hash.bytesHashed;
		aggregate.hashBudgetBytes += hash.bytesHashed;
		return {
			status: "available",
			algorithm: "sha256",
			value: hash.value,
			bytesHashed: hash.bytesHashed,
			scope: "source",
		};
	} catch (error) {
		pushFileSystemError(
			errors,
			entry.rootId,
			entry.path,
			"hash",
			error,
			options,
		);
		return { status: "omitted", reason: "read-error" };
	}
}

function getContentLimitReason(
	size: number,
	coverage: MutableRootCoverage,
	aggregate: MutableAggregate,
	options: LocalContextCollectionOptions,
): Extract<FileContent, { status: "omitted" }>["reason"] | null {
	if (size > options.limits.maxContentBytesPerFile) return "file-content-cap";
	if (
		aggregate.contentBudgetBytes + size >
		options.limits.maxTotalContentBytes
	) {
		coverage.limitsReached.add("maxTotalContentBytes");
		return "total-content-cap";
	}
	if (
		coverage.generalContentBytes + size >
		options.limits.maxContentBytesPerRoot
	) {
		coverage.limitsReached.add("maxContentBytesPerRoot");
		return "root-content-cap";
	}
	return null;
}

function getPoolLimitReason(
	pool: DedicatedPool,
	size: number,
	coverage: MutableRootCoverage,
	aggregate: MutableAggregate,
	options: LocalContextCollectionOptions,
): Extract<FileContent, { status: "omitted" }>["reason"] | null {
	const limits = getDedicatedPoolLimits(pool, options);
	if (size > limits.maxFileBytes) return "file-content-cap";
	if (aggregate.poolBudgetBytes[pool] + size > limits.maxTotalBytes) {
		coverage.limitsReached.add(limits.bytesLimit);
		return "total-content-cap";
	}
	return null;
}

function getDedicatedPoolLimits(
	pool: DedicatedPool,
	options: LocalContextCollectionOptions,
): DedicatedPoolLimits {
	switch (pool) {
		case "instruction":
			return {
				maxFileBytes: options.limits.maxInstructionContentBytesPerFile,
				maxTotalBytes: options.limits.maxInstructionContentBytes,
				filesLimit: "maxInstructionFiles",
				bytesLimit: "maxInstructionContentBytes",
			};
		case "user-context":
			return {
				maxFileBytes: options.limits.maxUserContextContentBytesPerFile,
				maxTotalBytes: options.limits.maxUserContextContentBytes,
				filesLimit: "maxUserContextFiles",
				bytesLimit: "maxUserContextContentBytes",
			};
		case "tool-result":
			return {
				maxFileBytes: options.limits.maxToolResultContentBytesPerFile,
				maxTotalBytes: options.limits.maxToolResultContentBytes,
				filesLimit: "maxToolResultFiles",
				bytesLimit: "maxToolResultContentBytes",
			};
	}
}

/** The canonical symlink boundary of a root, or null when it has none. */
async function resolveSymlinkBoundary(
	root: RootSpec,
	fileSystem: LocalContextFileSystem,
): Promise<string | null> {
	if (root.followSymlinksWithin === undefined) return null;
	return fileSystem
		.realpath(root.followSymlinksWithin)
		.catch(() => root.followSymlinksWithin ?? null);
}

/**
 * Whether a path's real location is inside the root's boundary. A path that
 * does not exist is judged by its nearest existing ancestor.
 */
async function isWithinSymlinkBoundary(
	walk: RootWalk,
	absolutePath: string,
	fileSystem: LocalContextFileSystem,
): Promise<boolean> {
	const boundary = await resolveSymlinkBoundary(walk.root, fileSystem);
	if (boundary === null) return true;
	for (let path = absolutePath; ; path = dirname(path)) {
		try {
			return isContainedPath(boundary, await fileSystem.realpath(path));
		} catch {
			if (dirname(path) === path) return false;
		}
	}
}

/**
 * The canonical directory a skill or instruction directory symlink points
 * to, when it may be followed: the target is a directory inside the root's
 * symlink boundary, outside the CLI's private configuration, not an ancestor
 * of the link (no cycles) and not walked already. Otherwise null, and the
 * symlink is only recorded.
 */
async function resolveFollowedSymlink(
	walk: RootWalk,
	absolutePath: string,
	relativePath: string,
	options: LocalContextCollectionOptions,
	fileSystem: LocalContextFileSystem,
): Promise<string | null> {
	const boundary = walk.root.followSymlinksWithin;
	if (
		boundary === undefined ||
		!isFollowableContextSymlink(walk.root.scope, relativePath)
	)
		return null;
	let target: string;
	let canonicalBoundary: string;
	try {
		target = await fileSystem.realpath(absolutePath);
		canonicalBoundary = await fileSystem.realpath(boundary);
		if ((await fileSystem.lstat(target)).kind !== "directory") return null;
	} catch {
		return null;
	}
	if (
		!isContainedPath(canonicalBoundary, target) ||
		(options.forbiddenSymlinkTargets ?? []).some(
			(forbidden) =>
				isContainedPath(forbidden, target) ||
				isContainedPath(target, forbidden),
		) ||
		isContainedPath(target, dirname(absolutePath)) ||
		walk.followedTargets.has(target)
	)
		return null;
	walk.followedTargets.add(target);
	return target;
}

interface SupportBudget {
	readonly key: string;
	readonly maxBytes: number;
	readonly maxFiles: number;
	readonly detail: string;
}

/**
 * Budgets a supporting file counts against: its skill's (larger for skills the
 * session used) and, inside a plugin the session did not use, its plugin's.
 */
function getSupportBudgets(
	file: PendingFile,
	observedSkills: ReadonlySet<string>,
): readonly SupportBudget[] {
	const { rootId, path } = file.entry;
	const resource =
		file.categories.includes("skill-resource") &&
		!file.categories.includes("skill-definition");
	if (!resource && !isPluginCommandOrAgent(rootId, path)) return [];
	const budgets: SupportBudget[] = [
		{
			key: "support",
			maxBytes: Number.POSITIVE_INFINITY,
			maxFiles: SESSION_SUPPORT_MAX_FILES,
			detail: SUPPORT_CAP_DETAIL,
		},
	];
	if (resource && file.skillDirectory !== null) {
		const observed = observedSkills.has(basename(file.skillDirectory));
		budgets.push({
			key: `skill\0${rootId}\0${file.skillDirectory}`,
			maxBytes: observed
				? SESSION_OBSERVED_SKILL_SUPPORT_MAX_BYTES
				: SESSION_SKILL_SUPPORT_MAX_BYTES,
			maxFiles: observed
				? SESSION_OBSERVED_SKILL_SUPPORT_MAX_FILES
				: SESSION_SKILL_SUPPORT_MAX_FILES,
			detail: SKILL_SUPPORT_CAP_DETAIL,
		});
	}
	const plugin = getPluginDirectory(rootId, path);
	if (plugin !== null && !isObservedPlugin(plugin, observedSkills))
		budgets.push({
			key: `plugin\0${rootId}\0${plugin}`,
			maxBytes: SESSION_PLUGIN_SUPPORT_MAX_BYTES,
			maxFiles: SESSION_PLUGIN_SUPPORT_MAX_FILES,
			detail: PLUGIN_SUPPORT_CAP_DETAIL,
		});
	return budgets;
}

function findSkillDirectory(
	path: string,
	skillDirectories: readonly string[],
): string | null {
	let found: string | null = null;
	for (const directory of skillDirectories)
		if (
			(directory === "." ||
				path === directory ||
				path.startsWith(`${directory}/`)) &&
			(found === null || directory.length > found.length)
		)
			found = directory;
	return found;
}

function getHashLimitReason(
	size: number,
	coverage: MutableRootCoverage,
	aggregate: MutableAggregate,
	options: LocalContextCollectionOptions,
): Extract<FileHash, { status: "omitted" }>["reason"] | null {
	if (size > options.limits.maxHashBytesPerFile) return "hash-file-cap";
	if (aggregate.hashBudgetBytes + size > options.limits.maxTotalHashBytes) {
		coverage.limitsReached.add("maxTotalHashBytes");
		return "hash-total-cap";
	}
	if (coverage.hashedBytes + size > options.limits.maxHashBytesPerRoot) {
		coverage.limitsReached.add("maxHashBytesPerRoot");
		return "hash-root-cap";
	}
	return null;
}

function buildEntryBase(
	root: RootSpec,
	entry: DiscoveredEntry,
	categories: readonly ContextFileCategory[],
	git: GitCollectionResult,
) {
	return {
		rootId: root.id,
		path: entry.path,
		name: basename(entry.path),
		parentPath: getParentPath(entry.path),
		mode: entry.stat.mode,
		modifiedAtMs: entry.stat.modifiedAtMs,
		categories,
		gitProvenance:
			root.id === "repository"
				? getGitFileProvenance(entry.path, git)
				: ("outside-repository" satisfies GitFileProvenance),
		evidenceReason: entry.evidenceReason,
	};
}

function countDiscoveredEntry(
	stat: FileSystemStat,
	coverage: MutableRootCoverage,
	aggregate: MutableAggregate,
	isSubmodule = false,
): void {
	coverage.discoveredEntries += 1;
	aggregate.totalEntries += 1;
	if (stat.kind === "file") {
		coverage.fileCount += 1;
		aggregate.inventoryBytes += stat.size;
	} else if (isSubmodule) {
		coverage.submoduleCount += 1;
	} else if (stat.kind === "directory") {
		coverage.directoryCount += 1;
	} else if (stat.kind === "symlink") {
		coverage.symlinkCount += 1;
	} else {
		coverage.otherCount += 1;
	}
}

function createMutableRootCoverage(): MutableRootCoverage {
	return {
		discoveredEntries: 0,
		fileCount: 0,
		directoryCount: 0,
		submoduleCount: 0,
		symlinkCount: 0,
		otherCount: 0,
		contentFiles: 0,
		contentBytes: 0,
		generalContentBytes: 0,
		hashedFiles: 0,
		hashedBytes: 0,
		omittedContentFiles: 0,
		excludedPaths: 0,
		limitsReached: new Set(),
		enumeratedEntries: 0,
	};
}

function buildRootManifest(
	root: RootSpec,
	status: ContextRootManifest["status"],
	coverage: MutableRootCoverage,
): ContextRootManifest {
	const immutableCoverage: RootCoverage = {
		discoveredEntries: coverage.discoveredEntries,
		fileCount: coverage.fileCount,
		directoryCount: coverage.directoryCount,
		submoduleCount: coverage.submoduleCount,
		symlinkCount: coverage.symlinkCount,
		otherCount: coverage.otherCount,
		contentFiles: coverage.contentFiles,
		contentBytes: coverage.contentBytes,
		hashedFiles: coverage.hashedFiles,
		hashedBytes: coverage.hashedBytes,
		omittedContentFiles: coverage.omittedContentFiles,
		excludedPaths: coverage.excludedPaths,
		limitsReached: [...coverage.limitsReached].sort(compareStrings),
		rootId: root.id,
	};
	return {
		id: root.id,
		label: root.label,
		absolutePath: root.absolutePath,
		origin: root.origin,
		scope: root.scope,
		status,
		coverage: immutableCoverage,
		...(root.aliases === undefined || root.aliases.length === 0
			? {}
			: { aliases: root.aliases }),
	};
}

function isRegisteredSubmodule(
	root: RootSpec,
	path: string,
	stat: FileSystemStat,
	git: GitCollectionResult,
): boolean {
	return (
		root.id === "repository" &&
		stat.kind === "directory" &&
		git.indexEntries.get(path)?.mode === "160000"
	);
}

function isBinary(bytes: Uint8Array, probeBytes: number): boolean {
	const probe = bytes.subarray(0, Math.min(bytes.byteLength, probeBytes));
	if (probe.includes(0)) return true;
	try {
		UTF8_DECODER.decode(bytes);
		return false;
	} catch {
		return true;
	}
}

function isContainedPath(root: string, path: string): boolean {
	const pathFromRoot = relative(root, path);
	return (
		pathFromRoot === "" ||
		(!pathFromRoot.startsWith(`..${sep}`) &&
			pathFromRoot !== ".." &&
			!pathFromRoot.startsWith(sep))
	);
}

function pushFileSystemError(
	errors: CoverageError[],
	rootId: string,
	path: string,
	operation: CoverageError["operation"],
	error: unknown,
	options: LocalContextCollectionOptions,
): void {
	const normalized = normalizeError(error);
	pushCoverageError(
		errors,
		{
			rootId,
			path,
			operation,
			code: normalized.code,
			message: normalized.message,
		},
		options,
	);
}

function pushCoverageError(
	errors: CoverageError[],
	error: CoverageError,
	options: LocalContextCollectionOptions,
): void {
	if (errors.length < options.limits.maxCoverageErrors) errors.push(error);
}

function normalizeError(error: unknown): {
	readonly code: string;
	readonly message: string;
} {
	if (error instanceof Error) {
		const code =
			"code" in error && typeof error.code === "string" ? error.code : "ERROR";
		return { code, message: error.message.slice(0, 1000) };
	}
	return { code: "ERROR", message: "Unknown filesystem error" };
}

function getFileKey(entry: DiscoveredEntry): string {
	return `${entry.rootId}\0${entry.path}`;
}

function compareEntries(left: ContextEntry, right: ContextEntry): number {
	return compareStrings(
		`${left.rootId}\0${left.path}`,
		`${right.rootId}\0${right.path}`,
	);
}

function compareStrings(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}
