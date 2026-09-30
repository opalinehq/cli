import { createHash } from "node:crypto";
import { basename, dirname, relative, resolve, sep } from "node:path";
import type { BlobStore } from "./blob-store.js";
import { addSanitizedTextBlob } from "./blob-store.js";
import {
	type GitCollectionResult,
	getGitFileProvenance,
} from "./git-collector.js";
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

interface RootSpec {
	readonly id: string;
	readonly label: string;
	readonly absolutePath: string;
	readonly origin: ContextRootManifest["origin"];
	readonly scope: ContextRootManifest["scope"];
}

interface DiscoveredEntry {
	readonly rootId: string;
	readonly absolutePath: string;
	readonly path: string;
	readonly stat: FileSystemStat;
	readonly evidenceReason: string | null;
}

interface PendingDirectory {
	readonly absolutePath: string;
	readonly relativePath: string;
	readonly depth: number;
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
): Promise<FileSystemCollectionResult> {
	const rootSpecs: readonly RootSpec[] = [
		{
			id: "repository",
			label: "Repository",
			absolutePath: repositoryRoot,
			origin: "repository",
			scope: "repository",
		},
		...options.additionalRoots
			.map((root) => ({ ...root }))
			.sort((left, right) => compareStrings(left.id, right.id)),
	];
	const entries: ContextEntry[] = [];
	const roots: ContextRootManifest[] = [];
	const excludedPaths: ExcludedPath[] = [];
	const errors: CoverageError[] = [];
	const aggregate: MutableAggregate = {
		totalEnumeratedEntries: 0,
		totalEntries: 0,
		contentBudgetBytes: 0,
		hashBudgetBytes: 0,
		inventoryBytes: 0,
		materializedBytes: 0,
		reusedBytes: 0,
		gitObjectBytes: 0,
		omittedBytes: 0,
	};

	for (const rootSpec of rootSpecs) {
		const result = await collectRoot(
			rootSpec,
			options,
			fileSystem,
			git,
			blobStore,
			aggregate,
			excludedPaths,
			errors,
		);
		roots.push(result.root);
		entries.push(...result.entries);
	}

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

async function collectRoot(
	rootSpec: RootSpec,
	options: LocalContextCollectionOptions,
	fileSystem: LocalContextFileSystem,
	git: GitCollectionResult,
	blobStore: BlobStore,
	aggregate: MutableAggregate,
	excludedPaths: ExcludedPath[],
	errors: CoverageError[],
): Promise<{
	readonly root: ContextRootManifest;
	readonly entries: readonly ContextEntry[];
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
			root: buildRootManifest(rootSpec, canonicalRoot.status, coverage),
			entries: [],
		};
	}

	const discovered = await discoverRootEntries(
		{ ...rootSpec, absolutePath: canonicalRoot.path },
		options,
		fileSystem,
		git,
		aggregate,
		coverage,
		excludedPaths,
		errors,
	);

	const skillDirectories = findSkillDirectories(
		discovered.map((entry) => entry.path),
	);
	const builtEntries = await buildEntries(
		{ ...rootSpec, absolutePath: canonicalRoot.path },
		discovered,
		skillDirectories,
		options,
		fileSystem,
		git,
		blobStore,
		aggregate,
		coverage,
		errors,
	);
	const status =
		coverage.limitsReached.size > 0 ? "limit-reached" : "collected";
	return {
		root: buildRootManifest(
			{ ...rootSpec, absolutePath: canonicalRoot.path },
			status,
			coverage,
		),
		entries: builtEntries,
	};
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
		return {
			status: normalized.code === "ENOENT" ? "missing" : "inaccessible",
		};
	}
}

async function discoverRootEntries(
	root: RootSpec,
	options: LocalContextCollectionOptions,
	fileSystem: LocalContextFileSystem,
	git: GitCollectionResult,
	aggregate: MutableAggregate,
	coverage: MutableRootCoverage,
	excludedPaths: ExcludedPath[],
	errors: CoverageError[],
): Promise<DiscoveredEntry[]> {
	const discovered: DiscoveredEntry[] = [];
	const pending: PendingDirectory[] = [
		{ absolutePath: root.absolutePath, relativePath: "", depth: 0 },
	];

	while (pending.length > 0) {
		const directory = pending.shift();
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
			coverage.limitsReached.add(entryLimit);
			return discovered;
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
			if (!complete)
				coverage.limitsReached.add(
					coverage.enumeratedEntries >= options.limits.maxEntriesPerRoot
						? "maxEntriesPerRoot"
						: "maxTotalEntries",
				);
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
				coverage.limitsReached.add(
					coverage.discoveredEntries >= options.limits.maxEntriesPerRoot
						? "maxEntriesPerRoot"
						: "maxTotalEntries",
				);
				return discovered;
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
			const entry: DiscoveredEntry = {
				rootId: root.id,
				absolutePath,
				path: relativePath,
				stat,
				evidenceReason: null,
			};
			discovered.push(entry);
			const isSubmodule = isRegisteredSubmodule(root, relativePath, stat, git);
			countDiscoveredEntry(stat, coverage, aggregate, isSubmodule);

			if (stat.kind === "directory" && !isSubmodule) {
				if (directory.depth + 1 >= options.limits.maxDepthPerRoot) {
					coverage.limitsReached.add("maxDepthPerRoot");
				} else {
					pending.push({
						absolutePath,
						relativePath,
						depth: directory.depth + 1,
					});
				}
			}
		}
	}
	addUndiscoveredSubmodules(
		root,
		discovered,
		options,
		git,
		aggregate,
		coverage,
	);
	return discovered;
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

async function buildEntries(
	root: RootSpec,
	discovered: readonly DiscoveredEntry[],
	skillDirectories: readonly string[],
	options: LocalContextCollectionOptions,
	fileSystem: LocalContextFileSystem,
	git: GitCollectionResult,
	blobStore: BlobStore,
	aggregate: MutableAggregate,
	coverage: MutableRootCoverage,
	errors: CoverageError[],
): Promise<readonly ContextEntry[]> {
	const nonFiles = discovered.filter((entry) => entry.stat.kind !== "file");
	const files = discovered
		.filter((entry) => entry.stat.kind === "file")
		.map((entry) => ({
			entry,
			categories: classifyContextPath(entry.path, skillDirectories, root.scope),
		}))
		.sort(
			(left, right) =>
				getContentPriority(left.categories) -
					getContentPriority(right.categories) ||
				compareStrings(left.entry.path, right.entry.path),
		);
	const entries: ContextEntry[] = [];
	for (const entry of nonFiles.sort((left, right) =>
		compareStrings(left.path, right.path),
	)) {
		entries.push(
			await buildNonFileEntry(
				root,
				entry,
				skillDirectories,
				fileSystem,
				git,
				options,
				errors,
			),
		);
	}
	for (const file of files) {
		entries.push(
			await buildRegularFileEntry(
				root,
				file.entry,
				file.categories,
				options,
				fileSystem,
				git,
				blobStore,
				aggregate,
				coverage,
				errors,
			),
		);
	}
	return entries;
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
		return { ...base, kind: "symlink", target, targetScope, followed: false };
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
	options: LocalContextCollectionOptions,
	fileSystem: LocalContextFileSystem,
	git: GitCollectionResult,
	blobStore: BlobStore,
	aggregate: MutableAggregate,
	coverage: MutableRootCoverage,
	errors: CoverageError[],
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
		shouldReuseGitObject(options.capturePolicy, categories) &&
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

	const contentLimitReason = getContentLimitReason(
		entry.stat.size,
		coverage,
		aggregate,
		options,
	);
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
			options.limits.maxContentBytesPerFile,
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
		const text = UTF8_DECODER.decode(read.bytes);
		const sanitized = addSanitizedTextBlob(
			text,
			read.bytes.byteLength,
			blobStore,
		);
		if (sanitized.status === "failure") {
			if (sanitized.reason === "blob-count-cap")
				coverage.limitsReached.add("maxBlobs");
			coverage.omittedContentFiles += 1;
			aggregate.omittedBytes += entry.stat.size;
			return {
				...base,
				kind: "file",
				size: entry.stat.size,
				hash: { status: "omitted", reason: "read-error" },
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
		aggregate.contentBudgetBytes += read.bytes.byteLength;
		aggregate.hashBudgetBytes += sanitized.storedByteLength;
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

function shouldReuseGitObject(
	policy: LocalContextCollectionOptions["capturePolicy"],
	categories: readonly ContextFileCategory[],
): boolean {
	if (policy === "delta") return true;
	return !categories.some((category) =>
		[
			"instruction",
			"skill-definition",
			"skill-resource",
			"plan-candidate",
			"agent-config",
			"mcp-config",
			"hook-config",
			"package-context",
		].includes(category),
	);
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
	if (coverage.contentBytes + size > options.limits.maxContentBytesPerRoot) {
		coverage.limitsReached.add("maxContentBytesPerRoot");
		return "root-content-cap";
	}
	return null;
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

function compareEntries(left: ContextEntry, right: ContextEntry): number {
	return compareStrings(
		`${left.rootId}\0${left.path}`,
		`${right.rootId}\0${right.path}`,
	);
}

function compareStrings(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}
