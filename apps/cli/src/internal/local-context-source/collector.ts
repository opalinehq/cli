import { resolve } from "node:path";
import { FILTER_VERSION } from "../secret-filter/index.js";
import { createBlobStore, getSortedBlobs } from "./blob-store.js";
import { buildContextIndex } from "./context-index.js";
import { collectFileSystemContext } from "./filesystem-collector.js";
import { checkGitConsistency, collectGitSnapshot } from "./git-collector.js";
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
	const startedAt = env.now().toISOString();
	const captureId = env.createCaptureId();
	if (captureId.trim().length === 0) {
		throw new Error("The capture ID provider returned an empty value.");
	}
	const requestedRoot = resolve(repositoryRoot);
	const blobStore = createBlobStore(
		options.parentCapture,
		options.limits.maxBlobs,
	);
	const git = await collectGitSnapshot(
		requestedRoot,
		options.limits,
		env.git,
		blobStore,
		options.excludedPathPrefixes,
	);
	const fileSystem = await collectFileSystemContext(
		git.repositoryRoot,
		options,
		env.fileSystem,
		git,
		blobStore,
	);
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
	return { manifest, blobs };
}

export function serializeLocalContextBundle(
	bundle: LocalContextBundle,
): string {
	return JSON.stringify(bundle);
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
		if (root.status === "missing")
			partialReasons.add(`missing-root:${root.id}`);
		if (root.status === "inaccessible") {
			partialReasons.add(`inaccessible-root:${root.id}`);
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
