import { realpath } from "node:fs/promises";
import {
	basename,
	dirname,
	isAbsolute,
	relative,
	resolve,
	sep,
} from "node:path";
import type { RepositoryEvidenceRemoteHint } from "../contracts/index.js";
import {
	SESSION_CONTEXT_MAX_BLOB_BYTES,
	SESSION_CONTEXT_MAX_BLOBS,
} from "../internal/local-context-source/capture-policy.js";
import {
	type AdditionalContextRoot,
	type CaptureRuntime,
	type ContextRootAlias,
	collectLocalContextBundle,
	createLocalContextSourceEnv,
	getDefaultLocalContextCollectionOptions,
	getLocalContextBundleBlobIds,
	getLocalContextBundleExternalObjectIds,
	type LocalContextBundle,
	serializeLocalContextBundle,
	type ToolResultReferences,
} from "../internal/local-context-source/index.js";
import { loadCredentials } from "./credentials.js";
import { exec } from "./exec.js";
import { getGitRemoteUrl } from "./git-info.js";
import { getOrCreateCliInstallationId } from "./product-analytics.js";
import { getProjectOrgId } from "./project-config.js";
import {
	createRepositorySpoolBinding,
	createRepositorySpoolEnv,
	getAcceptedRepositorySpoolParent,
	type RepositoryBundleCandidate,
	type RepositoryCaptureLifecycle,
	type RepositorySpoolBinding,
	type RepositorySpoolEnv,
	writeRepositoryBundle,
} from "./repo-spool.js";
import { resolveRepositoryEvidenceLocalIdentity } from "./repository-evidence-identity.js";
import {
	canonicalizeUserContextLocations,
	getUserContextLocations,
	readUserAgentSources,
	resolveClaudeProjectMemoryDirectory,
	resolveUserContextRoots,
	summarizeUserAgentSources,
} from "./user-context.js";

const MAX_ADDITIONAL_CONTEXT_ROOTS = 16;
const CONTEXT_ROOT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u;

export interface RepositoryConfigBoundary {
	readonly canonicalRepositoryRoot: string;
	readonly canonicalConfigDir: string;
	readonly excludedPathPrefix: string | null;
}

export interface RepositoryContext {
	readonly repositoryRoot: string;
	readonly localIdentity: Awaited<
		ReturnType<typeof resolveRepositoryEvidenceLocalIdentity>
	>;
	readonly remoteHint: RepositoryEvidenceRemoteHint | null;
	readonly binding: RepositorySpoolBinding;
	readonly spoolEnv: RepositorySpoolEnv;
}

export interface SessionRepositoryContextCapture {
	readonly bundle: LocalContextBundle;
	readonly candidate: RepositoryBundleCandidate;
	readonly context: RepositoryContext;
	readonly stored: Awaited<ReturnType<typeof writeRepositoryBundle>>;
}

export async function resolveRepositoryContext(
	repositoryPath: string | undefined,
): Promise<RepositoryContext> {
	const requestedPath = await realpath(repositoryPath ?? process.cwd());
	const repositoryRoot = await resolveGitRoot(requestedPath);
	const credentials = loadCredentials();
	const workspaceId = await getProjectOrgId(repositoryRoot);
	const spoolEnv = createRepositorySpoolEnv();
	await getRepositoryConfigBoundary(repositoryRoot, spoolEnv.configDir);
	const localIdentity = await resolveRepositoryEvidenceLocalIdentity(
		repositoryRoot,
		getOrCreateCliInstallationId(),
	);
	const remoteHint = parseGitHubRepositoryRemoteHint(
		await getGitRemoteUrl(repositoryRoot),
	);
	const binding = await createRepositorySpoolBinding({
		apiBaseUrl: credentials?.apiBaseUrl ?? null,
		accountId: credentials?.user?.id ?? null,
		workspaceId: workspaceId ?? null,
		localIdentity,
	});
	return { repositoryRoot, localIdentity, remoteHint, binding, spoolEnv };
}

export function parseGitHubRepositoryRemoteHint(
	remote: string | null | undefined,
): RepositoryEvidenceRemoteHint | null {
	if (!remote) return null;
	const trimmed = remote.trim();
	let host: string;
	let path: string;
	const scp = /^(?:[^@/]+@)?([^:/]+):(.+)$/u.exec(trimmed);
	if (scp && !trimmed.includes("://")) {
		host = scp[1] ?? "";
		path = scp[2] ?? "";
	} else if (/^[a-z][a-z\d+.-]*:\/\//iu.test(trimmed)) {
		let parsed: URL;
		try {
			parsed = new URL(trimmed);
		} catch {
			return null;
		}
		host = parsed.hostname;
		path = parsed.pathname;
	} else {
		const [candidateHost = "", ...segments] = trimmed.split("/");
		host = candidateHost;
		path = segments.join("/");
	}
	if (host.toLowerCase() !== "github.com") return null;
	const segments = path
		.replace(/^\/+|\/+$/gu, "")
		.replace(/\.git$/iu, "")
		.split("/");
	if (segments.length !== 2) return null;
	const [owner, name] = segments;
	if (
		!owner ||
		!name ||
		!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,99})$/u.test(owner) ||
		!/^[A-Za-z0-9_.-]{1,100}$/u.test(name) ||
		name === "." ||
		name === ".."
	) {
		return null;
	}
	return { host: "github.com", name, owner, provider: "github" };
}

export async function collectSessionRepositoryContext(input: {
	readonly accountId: string;
	readonly endpoint: string;
	readonly lifecycle: Exclude<RepositoryCaptureLifecycle, "manual">;
	readonly organizationId: string;
	readonly repositoryPath: string;
	readonly deadlineAt?: number;
	readonly observedSkillNames?: readonly string[];
	/** Claude Code session artifacts: saved large tool outputs. */
	readonly toolResults?: {
		readonly directory: string;
		readonly references: ToolResultReferences;
		readonly transformText: (text: string) => string;
	};
	readonly runtime?: CaptureRuntime;
}): Promise<SessionRepositoryContextCapture> {
	const resolvedContext = await resolveRepositoryContext(input.repositoryPath);
	const context: RepositoryContext = {
		...resolvedContext,
		binding: await createRepositorySpoolBinding({
			accountId: input.accountId,
			apiBaseUrl: input.endpoint,
			localIdentity: resolvedContext.localIdentity,
			workspaceId: input.organizationId,
		}),
	};
	const configBoundary = await getRepositoryConfigBoundary(
		context.repositoryRoot,
		context.spoolEnv.configDir,
	);
	const parentCapture = await getAcceptedRepositorySpoolParent(
		context.binding,
		"local-context",
		context.spoolEnv,
	);
	const defaults = getDefaultLocalContextCollectionOptions();
	const locations = await canonicalizeUserContextLocations(
		getUserContextLocations(),
	);
	const mainWorktreeRoot = await resolveMainWorktreeRoot(
		context.repositoryRoot,
	);
	const sessionPath = await resolveCanonicalPath(input.repositoryPath);
	const projectPaths = [
		...new Set([context.repositoryRoot, mainWorktreeRoot, sessionPath]),
	];
	const userSources = await readUserAgentSources(
		locations,
		context.repositoryRoot,
		projectPaths,
	);
	const memoryDirectory = await resolveClaudeProjectMemoryDirectory(
		locations,
		[...new Set([mainWorktreeRoot, context.repositoryRoot, sessionPath])],
		userSources.claudeSettings.value,
	);
	const additionalRoots = await resolveUserContextRoots({
		locations,
		memoryDirectory,
		repositoryRoot: context.repositoryRoot,
		sources: userSources,
		toolResultsDirectory: input.toolResults?.directory ?? null,
	});
	const safeRoots = await resolveSafeAdditionalRoots(
		additionalRoots,
		configBoundary,
	);
	const collected = await collectLocalContextBundle(
		context.repositoryRoot,
		{
			...defaults,
			additionalRoots: safeRoots,
			capturePolicy: "session-evidence",
			observedSkillNames: input.observedSkillNames,
			workingDirectory: await getRepositoryRelativePath(
				context.repositoryRoot,
				input.repositoryPath,
			),
			excludedPathPrefixes:
				configBoundary.excludedPathPrefix === null
					? defaults.excludedPathPrefixes
					: [
							...defaults.excludedPathPrefixes,
							configBoundary.excludedPathPrefix,
						],
			limits: {
				...defaults.limits,
				maxCommits: 10,
				maxBlobs: SESSION_CONTEXT_MAX_BLOBS,
				maxContentBytesPerFile: 512 * 1024,
				maxContentBytesPerRoot: 4 * 1024 * 1024,
				maxDepthPerRoot: 24,
				maxEntriesPerRoot: 20_000,
				maxHashBytesPerFile: 32 * 1024 * 1024,
				maxHashBytesPerRoot: 128 * 1024 * 1024,
				maxTotalContentBytes: SESSION_CONTEXT_MAX_BLOB_BYTES,
				maxTotalEntries: 50_000,
				maxTotalHashBytes: 256 * 1024 * 1024,
			},
			parentCapture,
			forbiddenSymlinkTargets: [configBoundary.canonicalConfigDir],
			transformToolResultText: input.toolResults?.transformText,
		},
		createLocalContextSourceEnv(input.deadlineAt),
	);
	if (input.deadlineAt !== undefined && Date.now() >= input.deadlineAt)
		throw new Error("Repository context capture exceeded its time budget.");
	const bundle: LocalContextBundle = {
		...collected,
		manifest: {
			...collected.manifest,
			userConfiguration: summarizeUserAgentSources(userSources),
			...(input.toolResults === undefined
				? {}
				: { toolResultReferences: input.toolResults.references }),
			...(input.runtime === undefined ? {} : { runtime: input.runtime }),
		},
	};
	const candidate = createRepositoryBundleCandidate(bundle);
	const stored = await writeRepositoryBundle(
		candidate,
		context.binding,
		context.repositoryRoot,
		input.lifecycle,
		context.spoolEnv,
	);
	return { bundle, candidate, context, stored };
}

async function getRepositoryRelativePath(
	repositoryRoot: string,
	path: string,
): Promise<string | undefined> {
	const canonicalPath = await resolveCanonicalPath(path);
	const relativePath = relative(repositoryRoot, canonicalPath);
	if (
		relativePath === ".." ||
		relativePath.startsWith(`..${sep}`) ||
		isAbsolute(relativePath)
	)
		return undefined;
	return relativePath.split(sep).join("/");
}

async function getRepositoryConfigBoundary(
	repositoryRoot: string,
	configDir: string,
): Promise<RepositoryConfigBoundary> {
	const canonicalRepositoryRoot = await realpath(repositoryRoot);
	const canonicalConfigDir = await resolveCanonicalPath(configDir);
	const relativeConfigDir = relative(
		canonicalRepositoryRoot,
		canonicalConfigDir,
	);
	if (relativeConfigDir === "") {
		throw new Error(
			"The CLI config directory cannot be the repository root for repository collection.",
		);
	}
	const excludedPathPrefix =
		relativeConfigDir === ".." ||
		relativeConfigDir.startsWith(`..${sep}`) ||
		isAbsolute(relativeConfigDir)
			? null
			: relativeConfigDir.split(sep).join("/");
	return {
		canonicalRepositoryRoot,
		canonicalConfigDir,
		excludedPathPrefix,
	};
}

/**
 * The additional roots that are safe to collect, without aborting the capture:
 * - a root resolving to the same directory as an earlier one (for example
 *   ~/.claude/skills linked to ~/.agents/skills) is merged into it as an
 *   alias, keeping both labels;
 * - a root inside another walked root is merged into that root as a nested
 *   alias (its files are walked there), and a walked root containing earlier
 *   ones takes them over the same way;
 * - a root overlapping the repository (which inventories it) or the CLI's
 *   private configuration directory is dropped.
 * Include roots (home directories) are never walked; an include path inside
 * the repository, a walked root or the configuration directory is dropped.
 */
export async function resolveSafeAdditionalRoots(
	additionalRoots: readonly AdditionalContextRoot[],
	configBoundary: RepositoryConfigBoundary,
): Promise<readonly AdditionalContextRoot[]> {
	if (additionalRoots.length > MAX_ADDITIONAL_CONTEXT_ROOTS) {
		throw new Error(
			`At most ${MAX_ADDITIONAL_CONTEXT_ROOTS} additional context roots may be collected at once.`,
		);
	}
	const rootIds = new Set<string>(["repository"]);
	for (const root of additionalRoots) {
		if (!CONTEXT_ROOT_ID_PATTERN.test(root.id)) {
			throw new Error(`Invalid context root id: ${JSON.stringify(root.id)}`);
		}
		if (rootIds.has(root.id)) {
			throw new Error(`Duplicate context root id: ${JSON.stringify(root.id)}`);
		}
		if (!isAbsolute(root.absolutePath)) {
			throw new Error(
				`Context root ${JSON.stringify(root.id)} must use an absolute path.`,
			);
		}
		rootIds.add(root.id);
	}
	const forbidden = [
		configBoundary.canonicalRepositoryRoot,
		configBoundary.canonicalConfigDir,
	];
	interface Walked {
		root: AdditionalContextRoot;
		readonly canonical: string;
		aliases: ContextRootAlias[];
	}
	const walked: Walked[] = [];
	const alias = (
		root: AdditionalContextRoot,
		relation: ContextRootAlias["relation"],
	): ContextRootAlias => ({
		id: root.id,
		label: root.label,
		absolutePath: root.absolutePath,
		relation,
	});
	for (const root of additionalRoots) {
		if (root.include !== undefined) continue;
		const canonical = await resolveCanonicalPath(root.absolutePath);
		if (
			forbidden.some(
				(path) =>
					isPathWithin(path, canonical) || isPathWithin(canonical, path),
			)
		)
			continue;
		const same = walked.find((entry) => entry.canonical === canonical);
		if (same !== undefined) {
			same.aliases.push(alias(root, "same-directory"));
			continue;
		}
		const container = walked.find((entry) =>
			isPathWithin(entry.canonical, canonical),
		);
		if (container !== undefined) {
			container.aliases.push(alias(root, "nested"));
			continue;
		}
		const contained = walked.filter((entry) =>
			isPathWithin(canonical, entry.canonical),
		);
		const aliases: ContextRootAlias[] = contained.flatMap((entry) => [
			alias(entry.root, "nested"),
			...entry.aliases,
		]);
		for (const entry of contained) walked.splice(walked.indexOf(entry), 1);
		walked.push({ root, canonical, aliases });
	}
	const walkedPaths = walked.map((entry) => entry.canonical);
	const safe: AdditionalContextRoot[] = [];
	for (const root of additionalRoots) {
		if (root.include === undefined) {
			const entry = walked.find((candidate) => candidate.root === root);
			if (entry === undefined) continue;
			safe.push(
				entry.aliases.length === 0
					? root
					: {
							...root,
							label: [
								root.label,
								...entry.aliases
									.filter((item) => item.relation === "same-directory")
									.map((item) => item.label),
							].join(" + "),
							aliases: entry.aliases,
						},
			);
			continue;
		}
		const canonicalRoot = await resolveCanonicalPath(root.absolutePath);
		const include = root.include.filter((item) => {
			const target = resolve(canonicalRoot, item.path);
			return ![...walkedPaths, ...forbidden].some(
				(path) =>
					isPathWithin(path, target) ||
					(item.role === "tree" && isPathWithin(target, path)),
			);
		});
		if (include.length > 0 || root.include.length === 0)
			safe.push({ ...root, include });
	}
	return safe;
}

function isMissingPathError(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function resolveCanonicalPath(path: string): Promise<string> {
	const absolutePath = resolve(path);
	return realpath(absolutePath).catch((error) => {
		if (isMissingPathError(error)) return absolutePath;
		throw error;
	});
}

function isPathWithin(parent: string, candidate: string): boolean {
	const relativePath = relative(parent, candidate);
	return (
		relativePath === "" ||
		(relativePath !== ".." &&
			!relativePath.startsWith(`..${sep}`) &&
			!isAbsolute(relativePath))
	);
}

/**
 * The main worktree of a linked worktree (Claude Code keeps one auto-memory
 * per repository, under the main worktree's path), else the repository root.
 */
async function resolveMainWorktreeRoot(
	repositoryRoot: string,
): Promise<string> {
	const result = await exec("git", [
		"-C",
		repositoryRoot,
		"rev-parse",
		"--path-format=absolute",
		"--git-common-dir",
	]);
	const commonDirectory = result.stdout.trim();
	if (
		result.exitCode !== 0 ||
		!isAbsolute(commonDirectory) ||
		basename(commonDirectory) !== ".git"
	)
		return repositoryRoot;
	return resolveCanonicalPath(dirname(commonDirectory));
}

async function resolveGitRoot(path: string): Promise<string> {
	const result = await exec("git", [
		"-C",
		path,
		"rev-parse",
		"--show-toplevel",
	]);
	if (result.exitCode !== 0 || !result.stdout.trim()) {
		throw new Error(`Not a Git repository: ${path}`);
	}
	return realpath(result.stdout.trim());
}

export function createRepositoryBundleCandidate(
	bundle: LocalContextBundle,
): RepositoryBundleCandidate {
	const { coverage } = bundle.manifest;
	const serializedBundle = serializeLocalContextBundle(bundle);
	return {
		artifactKind: "local-context",
		captureId: bundle.manifest.captureId,
		capturedAt: bundle.manifest.collectedAt,
		parentCaptureId: bundle.manifest.parentCaptureId,
		baseGitCommit: bundle.manifest.baseGitCommit,
		manifest: bundle.manifest,
		blobs: bundle.blobs.map((blob) => ({
			id: blob.id,
			byteLength: blob.byteLength,
			content: blob.content,
		})),
		referencedBlobIds: getLocalContextBundleBlobIds(bundle),
		externalObjectIds: getLocalContextBundleExternalObjectIds(bundle),
		sourceObjects: getLocalContextBundleExternalObjectIds(bundle).map((id) => ({
			id,
			blobId: null,
		})),
		serializedBundle,
		inventoryBytes: coverage.inventoryBytes,
		materializedBytes: coverage.materializedBytes,
		uploadCandidateBytes: Buffer.byteLength(serializedBundle),
		reusedBytes: coverage.reusedBytes,
		gitObjectBytes: coverage.gitObjectBytes,
		omittedBytes: coverage.omittedBytes,
		dependencyExclusions: coverage.excludedPaths.filter(
			(excluded) => excluded.reason === "dependency",
		).length,
	};
}
