import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { RepositoryEvidenceRemoteHint } from "../contracts/index.js";
import {
	type AdditionalContextRoot,
	collectLocalContextBundle,
	createLocalContextSourceEnv,
	getDefaultLocalContextCollectionOptions,
	getLocalContextBundleBlobIds,
	getLocalContextBundleExternalObjectIds,
	type LocalContextBundle,
	serializeLocalContextBundle,
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

const MAX_ADDITIONAL_CONTEXT_ROOTS = 16;
const CONTEXT_ROOT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u;

interface RepositoryConfigBoundary {
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
	const userHome = homedir();
	const additionalRoots: readonly AdditionalContextRoot[] = [
		{
			absolutePath: joinPath(userHome, ".claude", "skills"),
			id: "claude-user-skills",
			label: "Claude user skills",
			origin: "user",
			scope: "skills",
		},
		{
			absolutePath: joinPath(userHome, ".codex", "skills"),
			id: "codex-user-skills",
			label: "Codex user skills",
			origin: "user",
			scope: "skills",
		},
		{
			absolutePath: joinPath(userHome, ".agents", "skills"),
			id: "agents-user-skills",
			label: "Shared user skills",
			origin: "user",
			scope: "skills",
		},
	];
	await assertAdditionalRootsSafe(additionalRoots, configBoundary);
	const bundle = await collectLocalContextBundle(
		context.repositoryRoot,
		{
			...defaults,
			additionalRoots,
			capturePolicy: "session-evidence",
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
				maxContentBytesPerFile: 512 * 1024,
				maxContentBytesPerRoot: 4 * 1024 * 1024,
				maxDepthPerRoot: 24,
				maxEntriesPerRoot: 20_000,
				maxHashBytesPerFile: 32 * 1024 * 1024,
				maxHashBytesPerRoot: 128 * 1024 * 1024,
				maxTotalContentBytes: 12 * 1024 * 1024,
				maxTotalEntries: 30_000,
				maxTotalHashBytes: 256 * 1024 * 1024,
			},
			parentCapture,
		},
		createLocalContextSourceEnv(),
	);
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

async function assertAdditionalRootsSafe(
	additionalRoots: readonly AdditionalContextRoot[],
	configBoundary: RepositoryConfigBoundary,
): Promise<void> {
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
	const canonicalRootPaths = await Promise.all(
		additionalRoots.map((root) => resolveCanonicalPath(root.absolutePath)),
	);
	const acceptedRoots: Array<{ readonly id: string; readonly path: string }> = [
		{ id: "repository", path: configBoundary.canonicalRepositoryRoot },
	];
	for (const [index, root] of additionalRoots.entries()) {
		const canonicalRootPath = canonicalRootPaths[index];
		if (canonicalRootPath === undefined) {
			throw new Error(
				`Could not resolve context root ${JSON.stringify(root.id)}.`,
			);
		}
		const overlappingRoot = acceptedRoots.find(
			(accepted) =>
				isPathWithin(accepted.path, canonicalRootPath) ||
				isPathWithin(canonicalRootPath, accepted.path),
		);
		if (overlappingRoot?.path === canonicalRootPath) {
			throw new Error(
				`Duplicate context root path: ${JSON.stringify(root.absolutePath)}`,
			);
		}
		if (overlappingRoot !== undefined) {
			throw new Error(
				`Context root ${JSON.stringify(root.id)} overlaps ${JSON.stringify(overlappingRoot.id)} and would duplicate inventory.`,
			);
		}
		if (
			isPathWithin(canonicalRootPath, configBoundary.canonicalConfigDir) ||
			isPathWithin(configBoundary.canonicalConfigDir, canonicalRootPath)
		) {
			throw new Error(
				`Context root ${JSON.stringify(root.id)} overlaps the private CLI configuration directory.`,
			);
		}
		acceptedRoots.push({ id: root.id, path: canonicalRootPath });
	}
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

function joinPath(...segments: readonly string[]): string {
	return resolve(...segments);
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
