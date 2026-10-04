import { resolve } from "node:path";
import { FILTER_VERSION } from "../secret-filter/index.js";
import { createBlobStore, getSortedBlobs } from "./blob-store.js";
import {
	getSessionContentPriority,
	isPluginCommandOrAgent,
	SESSION_CONTEXT_MAX_BLOB_BYTES,
	SESSION_CONTEXT_MAX_BLOBS,
	SESSION_CONTEXT_MAX_ENTRIES,
	SESSION_CONTEXT_MAX_MANIFEST_BYTES,
	SESSION_CONTEXT_MAX_METADATA_LIST_BYTES,
} from "./capture-policy.js";
import { buildContextIndex, getContextFacetKinds } from "./context-index.js";
import { collectFileSystemContext } from "./filesystem-collector.js";
import { checkGitConsistency, collectGitSnapshot } from "./git-collector.js";
import { filterContextMetadata } from "./metadata-filter.js";
import { validateLocalContextCollectionOptions } from "./options.js";
import {
	type AggregateCoverage,
	type ContextBlob,
	type ContextDocumentIndex,
	type ContextEntry,
	type ContextPathReference,
	LOCAL_CONTEXT_BUNDLE_SCHEMA_VERSION,
	LOCAL_CONTEXT_COLLECTOR_VERSION,
	LOCAL_CONTEXT_LIFECYCLE,
	type LocalContextBundle,
	type LocalContextCollectionOptions,
	type LocalContextManifest,
	type LocalContextSourceEnv,
} from "./types.js";

export async function collectLocalContextBundle(
	repositoryRoot: string,
	options: LocalContextCollectionOptions,
	env: LocalContextSourceEnv,
): Promise<LocalContextBundle> {
	validateLocalContextCollectionOptions(options);
	const effectiveOptions =
		options.capturePolicy === "session-evidence"
			? {
					...options,
					limits: {
						...options.limits,
						maxBlobs: Math.min(
							options.limits.maxBlobs,
							SESSION_CONTEXT_MAX_BLOBS,
						),
						maxTotalContentBytes: Math.min(
							options.limits.maxTotalContentBytes,
							SESSION_CONTEXT_MAX_BLOB_BYTES,
						),
					},
				}
			: options;
	const startedAt = env.now().toISOString();
	const captureId = env.createCaptureId();
	if (captureId.trim().length === 0) {
		throw new Error("The capture ID provider returned an empty value.");
	}
	const requestedRoot = resolve(repositoryRoot);
	const sessionEvidence = options.capturePolicy === "session-evidence";
	const blobStore = createBlobStore(
		options.parentCapture,
		effectiveOptions.limits.maxBlobs,
		sessionEvidence ? effectiveOptions.limits.maxTotalContentBytes : undefined,
	);
	// Session evidence budgets instructions and patches in their own pools, so
	// neither can be crowded out by the other or by general content.
	const instructionBlobStore = sessionEvidence
		? createBlobStore(
				options.parentCapture,
				effectiveOptions.limits.maxInstructionFiles,
				effectiveOptions.limits.maxInstructionContentBytes,
			)
		: null;
	const gitBlobStore = sessionEvidence
		? createBlobStore(
				options.parentCapture,
				2,
				effectiveOptions.limits.maxDiffContentBytes,
			)
		: blobStore;
	const userContextBlobStore = sessionEvidence
		? createBlobStore(
				options.parentCapture,
				effectiveOptions.limits.maxUserContextFiles,
				effectiveOptions.limits.maxUserContextContentBytes,
			)
		: null;
	const toolResultBlobStore = sessionEvidence
		? createBlobStore(
				options.parentCapture,
				effectiveOptions.limits.maxToolResultFiles,
				effectiveOptions.limits.maxToolResultContentBytes,
			)
		: null;
	const git = await collectGitSnapshot(
		requestedRoot,
		effectiveOptions.limits,
		env.git,
		gitBlobStore,
		options.excludedPathPrefixes,
	);
	const fileSystem = await collectFileSystemContext(
		git.repositoryRoot,
		effectiveOptions,
		env.fileSystem,
		git,
		blobStore,
		{
			instruction: instructionBlobStore,
			userContext: userContextBlobStore,
			toolResult: toolResultBlobStore,
		},
	);
	for (const pool of [
		instructionBlobStore,
		gitBlobStore,
		userContextBlobStore,
		toolResultBlobStore,
	]) {
		if (pool === null || pool === blobStore) continue;
		for (const blob of pool.blobs.values()) blobStore.blobs.set(blob.id, blob);
	}
	const blobs = getSortedBlobs(blobStore);
	const documents = buildDocumentIndex(fileSystem.entries);
	const contextIndex = buildContextIndex(
		fileSystem.roots,
		fileSystem.entries,
		fileSystem.excludedPaths,
		fileSystem.errors,
	);
	const consistency = await checkGitConsistency(git, options.limits, env.git);
	const completedAt = env.now().toISOString();
	const coverage = buildAggregateCoverage(
		fileSystem,
		git.snapshot,
		blobs,
		consistency,
	);
	const manifest: LocalContextManifest = {
		schemaVersion: LOCAL_CONTEXT_BUNDLE_SCHEMA_VERSION,
		collectorVersion: LOCAL_CONTEXT_COLLECTOR_VERSION,
		lifecycle: LOCAL_CONTEXT_LIFECYCLE,
		captureId,
		parentCaptureId: options.parentCapture?.id ?? null,
		baseGitCommit: git.headCommit,
		capturePolicy: options.capturePolicy,
		collectedAt: completedAt,
		startedAt,
		completedAt,
		consistency,
		repositoryRootId: "repository",
		roots: fileSystem.roots,
		entries: fileSystem.entries,
		documents,
		contextIndex,
		git: git.snapshot,
		coverage,
		transport: {
			secretFilterApplied: true,
			secretFilterVersion: FILTER_VERSION,
			requiresAdditionalReview: true,
			rawContentIncluded: false,
		},
	};
	const filteredManifest = filterContextMetadata(manifest);
	return options.capturePolicy === "session-evidence"
		? boundSessionManifest(
				filteredManifest,
				blobs,
				new Set(filterContextMetadata(options.observedSkillNames ?? [])),
			)
		: { manifest: filteredManifest, blobs };
}

function boundSessionManifest(
	sourceManifest: LocalContextManifest,
	blobs: readonly ContextBlob[],
	observedSkills: ReadonlySet<string>,
): LocalContextBundle {
	const manifest = boundManifestMetadata(sourceManifest);
	const metadataRanks = new Map<ContextEntry, number>();
	const rootRanks = new Map<string, number>();
	for (const entry of manifest.entries) {
		if (getRetentionRank(entry, observedSkills) !== 8) continue;
		const rank = rootRanks.get(entry.rootId) ?? 0;
		metadataRanks.set(entry, rank);
		rootRanks.set(entry.rootId, rank + 1);
	}
	// Entries with captured content come first, then every facet resource and
	// skill definition, so the manifest bound drops plain inventory before
	// anything a facet or the skill index depends on.
	const prioritizedEntries = [...manifest.entries].sort(
		(left, right) =>
			getRetentionRank(left, observedSkills) -
				getRetentionRank(right, observedSkills) ||
			(metadataRanks.get(left) ?? 0) - (metadataRanks.get(right) ?? 0) ||
			compareStrings(
				`${left.rootId}\0${left.path}`,
				`${right.rootId}\0${right.path}`,
			),
	);
	const omittedContent = manifest.entries.filter(
		(entry) =>
			entry.kind === "file" &&
			entry.content.status === "omitted" &&
			["blob-count-cap", "total-content-cap", "root-content-cap"].includes(
				entry.content.reason,
			),
	).length;
	const omittedDiffs =
		manifest.git.status === "available"
			? manifest.git.diffs.filter(
					(diff) =>
						diff.omissionReason === "blob-count-cap" ||
						diff.omissionReason === "total-content-cap",
				).length
			: 0;
	const build = (
		entryCount: number,
		byteLimited: boolean,
	): LocalContextBundle => {
		const entries = prioritizedEntries
			.slice(0, entryCount)
			.sort((left, right) =>
				compareStrings(
					`${left.rootId}\0${left.path}`,
					`${right.rootId}\0${right.path}`,
				),
			);
		const droppedEntries = prioritizedEntries.slice(entryCount);
		const retainedBlobIds = new Set(
			entries.flatMap((entry) =>
				entry.kind === "file" &&
				(entry.content.status === "available" ||
					entry.content.status === "reused")
					? [entry.content.blobId]
					: [],
			),
		);
		if (manifest.git.status === "available")
			for (const diff of manifest.git.diffs)
				if (diff.blobId !== null) retainedBlobIds.add(diff.blobId);
		const retainedBlobs = blobs.filter((blob) => retainedBlobIds.has(blob.id));
		const omittedEntries = droppedEntries.length;
		const omittedBlobs =
			omittedContent + omittedDiffs + blobs.length - retainedBlobs.length;
		const omittedSkillDefinitions = droppedEntries.filter((entry) =>
			entry.categories.includes("skill-definition"),
		).length;
		const limits = new Set(manifest.coverage.limitsReached);
		if (manifest.entries.length > SESSION_CONTEXT_MAX_ENTRIES)
			limits.add("maxManifestEntries");
		if (byteLimited) limits.add("maxManifestBytes");
		if (omittedDiffs > 0) limits.add("git:capture-limit");
		const manifestLimit = byteLimited
			? "maxManifestBytes"
			: "maxManifestEntries";
		const roots = manifest.roots.map((root) => {
			const rootEntries = entries.filter((entry) => entry.rootId === root.id);
			const contentEntries = rootEntries.filter(
				(entry) =>
					entry.kind === "file" &&
					(entry.content.status === "available" ||
						entry.content.status === "reused"),
			);
			// Dropping inventory metadata is recorded on the root but does not
			// change its status: facets decide truncation from what was dropped.
			const lostEntries = droppedEntries.some(
				(entry) => entry.rootId === root.id,
			);
			return {
				...root,
				coverage: {
					...root.coverage,
					contentFiles: contentEntries.length,
					contentBytes: contentEntries.reduce(
						(total, entry) =>
							total +
							(entry.kind === "file" &&
							(entry.content.status === "available" ||
								entry.content.status === "reused")
								? entry.content.storedByteLength
								: 0),
						0,
					),
					omittedContentFiles: root.coverage.fileCount - contentEntries.length,
					limitsReached: [
						...new Set([
							...root.coverage.limitsReached,
							...(lostEntries ? [manifestLimit] : []),
						]),
					].sort(compareStrings),
				},
			};
		});
		const contentFiles = roots.reduce(
			(total, root) => total + root.coverage.contentFiles,
			0,
		);
		const blobBytes = retainedBlobs.reduce(
			(total, blob) => total + blob.byteLength,
			0,
		);
		const truncated =
			omittedEntries > 0 ||
			omittedBlobs > 0 ||
			manifest.coverage.truncated !== undefined
				? {
						...manifest.coverage.truncated,
						omittedEntries,
						omittedBlobs,
						...(omittedSkillDefinitions > 0 ? { omittedSkillDefinitions } : {}),
						reason: "capture-limit" as const,
					}
				: undefined;
		return {
			blobs: retainedBlobs,
			manifest: {
				...manifest,
				roots,
				entries,
				documents: buildDocumentIndex(entries),
				contextIndex: buildContextIndex(
					roots,
					entries,
					sourceManifest.coverage.excludedPaths,
					sourceManifest.coverage.errors,
					droppedEntries,
				),
				coverage: {
					...manifest.coverage,
					contentFiles,
					contentBytes: roots.reduce(
						(total, root) => total + root.coverage.contentBytes,
						0,
					),
					blobCount: retainedBlobs.length,
					materializedBytes: blobBytes,
					uploadCandidateBytes: blobBytes,
					omittedContentFiles: roots.reduce(
						(total, root) => total + root.coverage.omittedContentFiles,
						0,
					),
					limitsReached: [...limits].sort(compareStrings),
					partial:
						manifest.coverage.partial || omittedEntries > 0 || omittedBlobs > 0,
					partialReasons: [
						...new Set([...manifest.coverage.partialReasons, ...limits]),
					].sort(compareStrings),
					...(truncated === undefined ? {} : { truncated }),
				},
			},
		};
	};
	let lower = 0;
	let upper = Math.min(prioritizedEntries.length, SESSION_CONTEXT_MAX_ENTRIES);
	const initial = build(upper, false);
	if (
		Buffer.byteLength(JSON.stringify(initial.manifest)) <=
		SESSION_CONTEXT_MAX_MANIFEST_BYTES
	)
		return initial;
	while (lower < upper) {
		const middle = Math.ceil((lower + upper) / 2);
		if (
			Buffer.byteLength(JSON.stringify(build(middle, true).manifest)) <=
			SESSION_CONTEXT_MAX_MANIFEST_BYTES
		)
			lower = middle;
		else upper = middle - 1;
	}
	const result = build(lower, true);
	if (
		Buffer.byteLength(JSON.stringify(result.manifest)) >
		SESSION_CONTEXT_MAX_MANIFEST_BYTES
	)
		throw new Error(
			"Repository context metadata exceeds the capture manifest limit.",
		);
	return result;
}

/**
 * Trims each Git and exclusion metadata list to its own byte budget. The
 * omitted items are counted and the trimmed lists named in limitsReached; the
 * roots, facets and Git output sections stay as they were.
 */
function boundManifestMetadata(
	manifest: LocalContextManifest,
): LocalContextManifest {
	const omitted = new Map<string, number>();
	const bound = <Item>(
		name: string,
		items: readonly Item[],
	): readonly Item[] => {
		let bytes = 2;
		let dropped = 0;
		const kept = items.filter((item) => {
			const itemBytes = Buffer.byteLength(JSON.stringify(item)) + 1;
			if (bytes + itemBytes > SESSION_CONTEXT_MAX_METADATA_LIST_BYTES) {
				dropped += 1;
				return false;
			}
			bytes += itemBytes;
			return true;
		});
		if (dropped > 0) omitted.set(name, dropped);
		return kept;
	};
	const excludedPaths = bound("excludedPaths", manifest.coverage.excludedPaths);
	const errors = bound("errors", manifest.coverage.errors);
	const git =
		manifest.git.status === "available"
			? {
					...manifest.git,
					statusEntries: bound("git.statusEntries", manifest.git.statusEntries),
					commits: bound("git.commits", manifest.git.commits),
					worktrees: bound("git.worktrees", manifest.git.worktrees),
					remotes: bound("git.remotes", manifest.git.remotes),
					errors: bound("git.errors", manifest.git.errors),
				}
			: manifest.git;
	if (omitted.size === 0) return manifest;
	const omittedMetadata = [...omitted.values()].reduce(
		(total, count) => total + count,
		0,
	);
	const limits = [...omitted.keys()].map((name) => `metadata:${name}`);
	return {
		...manifest,
		git,
		coverage: {
			...manifest.coverage,
			excludedPaths,
			errors,
			limitsReached: [
				...new Set([...manifest.coverage.limitsReached, ...limits]),
			].sort(compareStrings),
			partialReasons: [
				...new Set([...manifest.coverage.partialReasons, ...limits]),
			].sort(compareStrings),
			partial: true,
			truncated: {
				omittedBlobs: manifest.coverage.truncated?.omittedBlobs ?? 0,
				omittedEntries: manifest.coverage.truncated?.omittedEntries ?? 0,
				omittedMetadata,
				reason: "capture-limit",
			},
		},
	};
}

function getRetentionRank(
	entry: ContextEntry,
	observedSkills: ReadonlySet<string>,
): number {
	const inFacet = getContextFacetKinds(entry.path, entry).length > 0;
	if (
		entry.kind === "file" &&
		(entry.content.status === "available" || entry.content.status === "reused")
	)
		// Supporting files (skill resources, plugin commands and agents) give
		// way to instructions, skill definitions and every facet resource.
		return !inFacet &&
			((entry.categories.includes("skill-resource") &&
				!entry.categories.includes("skill-definition")) ||
				isPluginCommandOrAgent(entry.rootId, entry.path))
			? 2
			: 0;
	if (entry.categories.includes("skill-definition") || inFacet) return 1;
	if (entry.kind !== "file") return 9;
	// Remaining files keep their content priority order (-1..4 maps to 3..8).
	return (
		4 +
		getSessionContentPriority(
			entry.rootId,
			entry.path,
			entry.categories,
			observedSkills,
		)
	);
}

export function serializeLocalContextBundle(
	bundle: LocalContextBundle,
): string {
	return JSON.stringify({ manifest: bundle.manifest, blobs: bundle.blobs });
}

export function getLocalContextBundleBlobIds(
	bundle: LocalContextBundle,
): readonly string[] {
	const blobIds = new Set(bundle.blobs.map((blob) => blob.id));
	for (const entry of bundle.manifest.entries) {
		if (
			entry.kind === "file" &&
			(entry.content.status === "available" ||
				entry.content.status === "reused")
		) {
			blobIds.add(entry.content.blobId);
		}
	}
	if (bundle.manifest.git.status === "available") {
		for (const diff of bundle.manifest.git.diffs) {
			if (diff.blobId !== null) blobIds.add(diff.blobId);
		}
	}
	return [...blobIds].sort(compareStrings);
}

export function getLocalContextBundleExternalObjectIds(
	bundle: LocalContextBundle,
): readonly string[] {
	const objectIds = new Set<string>();
	for (const entry of bundle.manifest.entries) {
		if (entry.kind === "file" && entry.content.status === "git-object") {
			objectIds.add(entry.content.objectId);
		}
	}
	return [...objectIds].sort(compareStrings);
}

function buildDocumentIndex(
	entries: readonly ContextEntry[],
): ContextDocumentIndex {
	return {
		markdown: getCategoryPaths(entries, "markdown"),
		instructions: getCategoryPaths(entries, "instruction"),
		skillDefinitions: getCategoryPaths(entries, "skill-definition"),
		skillResources: getCategoryPaths(entries, "skill-resource"),
		planCandidates: getCategoryPaths(entries, "plan-candidate"),
		agentConfigs: getCategoryPaths(entries, "agent-config"),
		mcpConfigs: getCategoryPaths(entries, "mcp-config"),
		hookConfigs: getCategoryPaths(entries, "hook-config"),
		packageContexts: getCategoryPaths(entries, "package-context"),
	};
}

function getCategoryPaths(
	entries: readonly ContextEntry[],
	category: ContextEntry["categories"][number],
): readonly ContextPathReference[] {
	return entries
		.filter((entry) => entry.categories.includes(category))
		.map((entry) => ({ rootId: entry.rootId, path: entry.path }));
}

function buildAggregateCoverage(
	fileSystem: Awaited<ReturnType<typeof collectFileSystemContext>>,
	git: LocalContextManifest["git"],
	blobs: readonly ContextBlob[],
	consistency: LocalContextManifest["consistency"],
): AggregateCoverage {
	const regularFiles = fileSystem.entries.filter(
		(entry) => entry.kind === "file",
	);
	const contentEntries = regularFiles.filter(
		(entry) =>
			entry.content.status === "available" || entry.content.status === "reused",
	);
	const redactionCounts: Record<string, number> = {};
	let redactedBytes = 0;
	for (const entry of contentEntries) {
		if (
			entry.content.status !== "available" &&
			entry.content.status !== "reused"
		) {
			continue;
		}
		redactedBytes += entry.content.secretFilter.redactedBytes;
		mergeCounts(redactionCounts, entry.content.secretFilter.counts);
	}
	if (git.status === "available") {
		for (const diff of git.diffs) {
			if (diff.secretFilter === null) continue;
			redactedBytes += diff.secretFilter.redactedBytes;
			mergeCounts(redactionCounts, diff.secretFilter.counts);
		}
	}
	const uploadCandidateBytes = blobs.reduce(
		(total, blob) => total + blob.byteLength,
		0,
	);
	const limitsReached = new Set<string>();
	for (const root of fileSystem.roots) {
		for (const limit of root.coverage.limitsReached) limitsReached.add(limit);
	}
	if (git.status === "available") {
		for (const section of git.truncatedSections) {
			limitsReached.add(`git:${section}`);
		}
	}
	if (consistency.status !== "stable") {
		limitsReached.add(
			consistency.status === "concurrent-change"
				? "concurrent-change"
				: "consistency-check-unavailable",
		);
	}
	const partialReasons = new Set<string>(limitsReached);
	if (fileSystem.errors.length > 0) partialReasons.add("filesystem-errors");
	for (const root of fileSystem.roots) {
		// A missing root is an absent source; it leaves nothing uncaptured.
		if (root.status === "inaccessible") {
			partialReasons.add(`inaccessible-root:${root.id}`);
		}
		if (root.status === "excluded") {
			partialReasons.add(`excluded-root:${root.id}`);
		}
	}
	return {
		discoveredEntries: fileSystem.entries.length,
		inventoryBytes: fileSystem.aggregate.inventoryBytes,
		contentFiles: contentEntries.length,
		contentBytes: contentEntries.reduce(
			(total, entry) =>
				total +
				(entry.content.status === "available" ||
				entry.content.status === "reused"
					? entry.content.storedByteLength
					: 0),
			0,
		),
		blobCount: blobs.length,
		materializedBytes: uploadCandidateBytes,
		uploadCandidateBytes,
		reusedBytes: fileSystem.aggregate.reusedBytes,
		gitObjectBytes: fileSystem.aggregate.gitObjectBytes,
		omittedBytes: fileSystem.aggregate.omittedBytes,
		hashedFiles: fileSystem.roots.reduce(
			(total, root) => total + root.coverage.hashedFiles,
			0,
		),
		hashedBytes: fileSystem.roots.reduce(
			(total, root) => total + root.coverage.hashedBytes,
			0,
		),
		redactedBytes,
		redactionCounts: Object.fromEntries(
			Object.entries(redactionCounts).sort(([left], [right]) =>
				left < right ? -1 : left > right ? 1 : 0,
			),
		),
		omittedContentFiles: regularFiles.length - contentEntries.length,
		excludedPaths: fileSystem.excludedPaths,
		errors: fileSystem.errors,
		limitsReached: [...limitsReached].sort(compareStrings),
		partial: partialReasons.size > 0,
		partialReasons: [...partialReasons].sort(compareStrings),
	};
}

function mergeCounts(
	target: Record<string, number>,
	source: Readonly<Record<string, number>>,
): void {
	for (const [ruleId, count] of Object.entries(source)) {
		target[ruleId] = (target[ruleId] ?? 0) + count;
	}
}

function compareStrings(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}
