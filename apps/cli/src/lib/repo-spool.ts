import { createHash, randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import {
	chmod,
	link,
	lstat,
	mkdir,
	open,
	readdir,
	readFile,
	rename,
	rm,
	stat,
	utimes,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { RepositoryEvidenceLocalIdentity } from "../contracts/index.js";
import { getConfigDir } from "./local-state.js";

const SPOOL_SCHEMA_VERSION = 2;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const DEFAULT_MAX_STORED_BYTES = 512 * 1024 * 1024;
const DEFAULT_MAX_CAPTURES = 2_000;
const DEFAULT_MAX_BLOB_BYTES = 64 * 1024 * 1024;
const SHA256_BLOB_ID = /^sha256:([a-f0-9]{64})$/u;
const CAPTURE_FILE_SUFFIX = ".capture.json";
const BLOB_FILE_SUFFIX = ".blob";
const TEMP_FILE_SUFFIX = ".tmp";
const ACCEPTED_CAPTURE_VERSION = 1;
const ACCEPTED_MARKER_SUFFIX = ".accepted.json";
const ABANDONED_CAPTURE_VERSION = 1;
const ABANDONED_MARKER_SUFFIX = ".abandoned.json";
const ACCOUNTING_VERSION = 1;
const WRITE_LOCK_NAME = ".write-lock";
const WRITE_LOCK_STALE_MS = 60_000;
const WRITE_LOCK_TIMEOUT_MS = 30_000;
const WRITE_LOCK_POLL_MS = 25;

export const REPOSITORY_CAPTURE_LIFECYCLES = [
	"start",
	"resume",
	"checkpoint",
	"end",
	"manual",
] as const;

export type RepositoryCaptureLifecycle =
	(typeof REPOSITORY_CAPTURE_LIFECYCLES)[number];

export interface RepositorySpoolBindingInput {
	readonly apiBaseUrl: string | null;
	readonly accountId: string | null;
	readonly localIdentity: RepositoryEvidenceLocalIdentity;
	readonly workspaceId: string | null;
}

export interface RepositorySpoolBinding {
	readonly endpointKey: string | null;
	readonly accountKey: string | null;
	readonly installationKey: string;
	readonly workspaceKey: string | null;
	readonly repositoryKey: string;
	readonly worktreeKey: string;
}

export interface RepositorySpoolBlob {
	readonly id: string;
	readonly byteLength: number;
	readonly content: string;
}

export interface RepositorySpoolSourceObject {
	readonly id: string;
	readonly blobId: string | null;
}

export interface RepositoryBundleCandidate {
	readonly artifactKind: "local-context" | "github";
	readonly captureId: string;
	readonly capturedAt: string;
	readonly parentCaptureId: string | null;
	readonly baseGitCommit: string | null;
	readonly manifest: unknown;
	readonly blobs: readonly RepositorySpoolBlob[];
	readonly referencedBlobIds: readonly string[];
	readonly externalObjectIds: readonly string[];
	readonly sourceObjects: readonly RepositorySpoolSourceObject[];
	readonly serializedBundle: string;
	readonly inventoryBytes: number;
	readonly materializedBytes: number;
	readonly uploadCandidateBytes: number;
	readonly reusedBytes: number;
	readonly gitObjectBytes: number;
	readonly omittedBytes: number;
	readonly dependencyExclusions: number;
}

export interface RepositorySpoolEnv {
	readonly configDir: string;
	readonly maxStoredBytes: number;
	readonly maxCaptures: number;
	readonly maxBlobBytes: number;
	readonly writeLockStaleMs: number;
	readonly writeLockTimeoutMs: number;
	readonly writeLockPollMs: number;
	readonly now: () => Date;
	readonly createNonce: () => string;
	readonly commitImmutableFile: (
		temporaryPath: string,
		finalPath: string,
	) => Promise<void>;
	readonly onCaptureRead?: (kind: "verify" | "scan", path: string) => void;
}

export interface RepositorySpoolPlan {
	readonly artifactKind: "local-context" | "github";
	readonly captureId: string;
	readonly contentHash: string;
	readonly parentCaptureId: string | null;
	readonly baseGitCommit: string | null;
	readonly inventoryBytes: number;
	readonly materializedBytes: number;
	readonly uploadCandidateBytes: number;
	readonly newlyMaterializedBytes: number;
	readonly reusedBytes: number;
	readonly gitObjectBytes: number;
	readonly omittedBytes: number;
	readonly dependencyExclusions: number;
	readonly captureRecordBytes: number;
	readonly storedNewBytes: number;
	readonly missingBlobIds: readonly string[];
	readonly alreadyStored: boolean;
	readonly selfContained: boolean;
	readonly quota: RepositorySpoolUsage;
}

export interface RepositorySpoolCaptureSummary {
	readonly artifactKind: "local-context" | "github";
	readonly captureId: string;
	readonly contentHash: string;
	readonly captureLifecycle: RepositoryCaptureLifecycle;
	readonly capturedAt: string;
	readonly parentCaptureId: string | null;
	readonly baseGitCommit: string | null;
	readonly repositoryName: string;
	readonly inventoryBytes: number;
	readonly materializedBytes: number;
	readonly uploadCandidateBytes: number;
	readonly newlyMaterializedBytes: number;
	readonly reusedBytes: number;
	readonly gitObjectBytes: number;
	readonly omittedBytes: number;
	readonly dependencyExclusions: number;
	readonly storedBytes: number;
	readonly referencedBlobCount: number;
	readonly materializedBlobCount: number;
	readonly selfContained: boolean;
	readonly integrity: "valid" | "corrupt";
	readonly integrityError: string | null;
}

export interface RepositorySpoolUsage {
	readonly usedBytes: number;
	readonly maxBytes: number;
	readonly remainingBytes: number;
	readonly captureCount: number;
	readonly maxCaptures: number;
	readonly blobCount: number;
}

export interface RepositorySpoolQuota extends RepositorySpoolUsage {
	readonly orphanBlobCount: number;
	readonly orphanBlobBytes: number;
}

export interface RepositorySpoolRetention {
	readonly automaticCleanup: true;
	readonly policy: "retire-accepted-on-quota-pressure";
	readonly oldestCaptureAt: string | null;
	readonly abandonedTemporaryFiles: number;
}

export interface RepositorySpoolRetirementResult {
	readonly retiredCaptures: number;
	readonly retiredBlobs: number;
	readonly freedBytes: number;
	readonly unsentCaptures: number;
	readonly unsentBytes: number;
}

export interface RepositorySpoolListing {
	readonly bindingKey: string;
	readonly captures: readonly RepositorySpoolCaptureSummary[];
	readonly quota: RepositorySpoolQuota;
	readonly retention: RepositorySpoolRetention;
}

export interface RepositorySpoolWriteResult {
	readonly created: boolean;
	readonly capture: RepositorySpoolCaptureSummary;
	readonly quota: RepositorySpoolUsage;
}

export interface RepositorySpoolParentReference {
	readonly id: string;
	readonly blobIds: readonly string[];
}

interface AcceptedRepositoryCapture {
	readonly captureId: string;
	readonly capturedAt: string;
	readonly version: typeof ACCEPTED_CAPTURE_VERSION;
}

interface SpoolAccounting {
	readonly version: typeof ACCOUNTING_VERSION;
	readonly state: "clean" | "dirty";
	readonly usedBytes: number;
	readonly captureCount: number;
	readonly blobCount: number;
}

interface StoredCaptureRecordBody {
	readonly schemaVersion: typeof SPOOL_SCHEMA_VERSION;
	readonly artifactKind: "local-context" | "github";
	readonly captureId: string;
	readonly contentHash: string;
	readonly captureLifecycle: RepositoryCaptureLifecycle;
	readonly capturedAt: string;
	readonly parentCaptureId: string | null;
	readonly baseGitCommit: string | null;
	readonly repositoryName: string;
	readonly repositoryKey: string;
	readonly binding: RepositorySpoolBinding;
	readonly manifest: unknown;
	readonly materializedBlobIds: readonly string[];
	readonly referencedBlobIds: readonly string[];
	readonly externalObjectIds: readonly string[];
	readonly sourceObjects: readonly RepositorySpoolSourceObject[];
	readonly metrics: {
		readonly inventoryBytes: number;
		readonly materializedBytes: number;
		readonly uploadCandidateBytes: number;
		readonly newlyMaterializedBytes: number;
		readonly reusedBytes: number;
		readonly gitObjectBytes: number;
		readonly omittedBytes: number;
		readonly dependencyExclusions: number;
	};
}

interface StoredCaptureRecord extends StoredCaptureRecordBody {
	readonly recordHash: string;
}

interface SpoolPaths {
	readonly root: string;
	readonly binding: string;
	readonly blobs: string;
	readonly captures: string;
}

interface InspectedCapture {
	readonly record: StoredCaptureRecord | null;
	readonly summary: RepositorySpoolCaptureSummary;
}

export class RepositorySpoolQuotaError extends Error {}

export class RepositorySpoolCapacityError extends RepositorySpoolQuotaError {}

export class RepositorySpoolCorruptionError extends Error {}

export function createRepositorySpoolEnv(
	configDir = getConfigDir(),
): RepositorySpoolEnv {
	return {
		configDir,
		maxStoredBytes: DEFAULT_MAX_STORED_BYTES,
		maxCaptures: DEFAULT_MAX_CAPTURES,
		maxBlobBytes: DEFAULT_MAX_BLOB_BYTES,
		writeLockStaleMs: WRITE_LOCK_STALE_MS,
		writeLockTimeoutMs: WRITE_LOCK_TIMEOUT_MS,
		writeLockPollMs: WRITE_LOCK_POLL_MS,
		now: () => new Date(),
		createNonce: randomUUID,
		commitImmutableFile: link,
	};
}

export async function createRepositorySpoolBinding(
	input: RepositorySpoolBindingInput,
): Promise<RepositorySpoolBinding> {
	return {
		endpointKey: hashOptionalIdentity(
			"endpoint",
			normalizeEndpoint(input.apiBaseUrl),
		),
		accountKey: hashOptionalIdentity("account", input.accountId),
		installationKey: hashIdentity(
			"installation",
			input.localIdentity.installationId,
		),
		workspaceKey: hashOptionalIdentity("workspace", input.workspaceId),
		repositoryKey: hashIdentity("repository", input.localIdentity.repositoryId),
		worktreeKey: hashIdentity("worktree", input.localIdentity.worktreeId),
	};
}

export async function getAcceptedRepositorySpoolParent(
	binding: RepositorySpoolBinding,
	artifactKind: "local-context" | "github",
	env: RepositorySpoolEnv,
): Promise<RepositorySpoolParentReference | null> {
	const accepted = await readAcceptedRepositoryCapture(
		getAcceptedCapturePath(getSpoolPaths(binding, env), artifactKind),
	);
	if (!accepted) return null;
	const paths = getSpoolPaths(binding, env);
	const inspected = await inspectCaptureIfPresent(
		getCapturePath(paths, accepted.captureId),
		paths,
		env,
	);
	if (
		!inspected?.record ||
		inspected.summary.integrity !== "valid" ||
		inspected.record.artifactKind !== artifactKind ||
		inspected.record.capturedAt !== accepted.capturedAt
	) {
		return null;
	}
	return {
		id: inspected.record.captureId,
		blobIds: inspected.record.referencedBlobIds,
	};
}

export async function markRepositorySpoolCaptureAccepted(
	binding: RepositorySpoolBinding,
	captureId: string,
	artifactKind: "local-context" | "github",
	env: RepositorySpoolEnv,
): Promise<boolean> {
	const paths = getSpoolPaths(binding, env);
	await ensureSpoolDirectories(paths);
	// Markers and the accepted head only touch this binding's files, so the
	// binding lock suffices; other repositories' writers are not blocked.
	const releaseLock = await acquireSpoolWriteLock(paths.binding, env);
	try {
		const candidate = await inspectCaptureIfPresent(
			getCapturePath(paths, captureId),
			paths,
			env,
		);
		if (
			!candidate?.record ||
			candidate.summary.integrity !== "valid" ||
			candidate.record.artifactKind !== artifactKind
		) {
			return false;
		}
		await writeMutablePrivateFile(
			getAcceptedMarkerPath(paths, candidate.record.captureId),
			`${JSON.stringify({
				captureId: candidate.record.captureId,
				version: ACCEPTED_CAPTURE_VERSION,
			})}\n`,
			env,
		);
		const acceptedPath = getAcceptedCapturePath(paths, artifactKind);
		const current = await readAcceptedRepositoryCapture(acceptedPath);
		if (
			current &&
			compareCaptureOrder(current, {
				captureId: candidate.record.captureId,
				capturedAt: candidate.record.capturedAt,
			}) >= 0
		) {
			return current.captureId === candidate.record.captureId;
		}
		await writeMutablePrivateFile(
			acceptedPath,
			`${JSON.stringify({
				captureId: candidate.record.captureId,
				capturedAt: candidate.record.capturedAt,
				version: ACCEPTED_CAPTURE_VERSION,
			})}\n`,
			env,
		);
		return true;
	} finally {
		await releaseLock();
	}
}

export async function markRepositorySpoolCaptureAbandoned(
	binding: RepositorySpoolBinding,
	captureId: string,
	artifactKind: "local-context" | "github",
	env: RepositorySpoolEnv,
): Promise<boolean> {
	const paths = getSpoolPaths(binding, env);
	await ensureSpoolDirectories(paths);
	const releaseLock = await acquireSpoolWriteLock(paths.binding, env);
	try {
		const candidate = await inspectCaptureIfPresent(
			getCapturePath(paths, captureId),
			paths,
			env,
		);
		if (
			!candidate?.record ||
			candidate.summary.integrity !== "valid" ||
			candidate.record.artifactKind !== artifactKind
		) {
			return false;
		}
		await writeMutablePrivateFile(
			getAbandonedMarkerPath(paths, candidate.record.captureId),
			`${JSON.stringify({
				captureId: candidate.record.captureId,
				version: ABANDONED_CAPTURE_VERSION,
			})}\n`,
			env,
		);
		return true;
	} finally {
		await releaseLock();
	}
}

export async function removeRepositorySpoolCapture(
	binding: RepositorySpoolBinding,
	captureId: string,
	env: RepositorySpoolEnv,
): Promise<void> {
	const paths = getSpoolPaths(binding, env);
	await ensureSpoolDirectories(paths);
	const releaseBindingLock = await acquireSpoolWriteLock(paths.binding, env);
	const releaseLock = await acquireSpoolWriteLock(paths.root, env).catch(
		async (error: unknown) => {
			await releaseBindingLock();
			throw error;
		},
	);
	try {
		const plan = await planBindingRetirement(paths, env, new Set());
		const retired = plan.captures.filter(
			(capture) => capture.record?.captureId === captureId,
		);
		if (retired.length === 0) return;
		const before = await ensureCleanAccountingLocked(env);
		await writeSpoolAccounting({ ...before, state: "dirty" }, env);
		const applied = await applyBindingRetirement({
			...plan,
			retired,
		});
		await writeSpoolAccounting(
			{
				blobCount: Math.max(0, before.blobCount - applied.retiredBlobs),
				captureCount: Math.max(0, before.captureCount - retired.length),
				state: "clean",
				usedBytes: Math.max(0, before.usedBytes - applied.freedBytes),
			},
			env,
		);
	} finally {
		await releaseLock();
		await releaseBindingLock();
	}
}

export async function planRepositoryBundle(
	candidate: RepositoryBundleCandidate,
	binding: RepositorySpoolBinding,
	repositoryRoot: string,
	captureLifecycle: RepositoryCaptureLifecycle,
	env: RepositorySpoolEnv,
): Promise<RepositorySpoolPlan> {
	return planRepositoryBundleWith(
		candidate,
		binding,
		repositoryRoot,
		captureLifecycle,
		env,
		"verify",
	);
}

/**
 * `verify` hashes every stored blob the candidate relies on. `exists` only
 * checks presence; writers use it under the global lock after verifying the
 * same immutable blobs outside it.
 */
async function planRepositoryBundleWith(
	candidate: RepositoryBundleCandidate,
	binding: RepositorySpoolBinding,
	repositoryRoot: string,
	captureLifecycle: RepositoryCaptureLifecycle,
	env: RepositorySpoolEnv,
	blobCheck: "exists" | "verify",
): Promise<RepositorySpoolPlan> {
	validateCandidate(candidate);
	const paths = getSpoolPaths(binding, env);
	const contentHash = sha256(candidate.serializedBundle);
	const capturePath = getCapturePath(paths, candidate.captureId);
	const existingCapture = await inspectCaptureIfPresent(
		capturePath,
		paths,
		env,
	);
	if (existingCapture) {
		if (
			existingCapture.summary.integrity !== "valid" ||
			existingCapture.summary.contentHash !== contentHash
		) {
			throw new RepositorySpoolCorruptionError(
				`Capture ${candidate.captureId} already exists with different or corrupt content.`,
			);
		}
		return {
			artifactKind: candidate.artifactKind,
			captureId: candidate.captureId,
			contentHash,
			parentCaptureId: candidate.parentCaptureId,
			baseGitCommit: candidate.baseGitCommit,
			inventoryBytes: candidate.inventoryBytes,
			materializedBytes: candidate.materializedBytes,
			uploadCandidateBytes: candidate.uploadCandidateBytes,
			newlyMaterializedBytes: 0,
			reusedBytes: candidate.reusedBytes + candidate.materializedBytes,
			gitObjectBytes: candidate.gitObjectBytes,
			omittedBytes: candidate.omittedBytes,
			dependencyExclusions: candidate.dependencyExclusions,
			captureRecordBytes: 0,
			storedNewBytes: 0,
			missingBlobIds: [],
			alreadyStored: true,
			selfContained: existingCapture.summary.selfContained,
			quota: await getSpoolUsage(env),
		};
	}

	const missingBlobIds = await findMissingBlobIds(
		candidate.blobs,
		paths,
		env,
		blobCheck,
	);
	await assertReferencedBlobsAvailable(candidate, paths, env, blobCheck);
	const missingBlobIdSet = new Set(missingBlobIds);
	const newlyMaterializedBytes = candidate.blobs.reduce(
		(total, blob) =>
			total + (missingBlobIdSet.has(blob.id) ? blob.byteLength : 0),
		0,
	);
	const deduplicatedMaterializedBytes =
		candidate.materializedBytes - newlyMaterializedBytes;
	const record = createStoredCaptureRecord(
		candidate,
		binding,
		repositoryRoot,
		captureLifecycle,
		candidate.capturedAt,
		contentHash,
		newlyMaterializedBytes,
		deduplicatedMaterializedBytes,
	);
	const captureRecordBytes = Buffer.byteLength(serializeRecord(record));
	const storedNewBytes = captureRecordBytes + newlyMaterializedBytes;
	const usage = await getSpoolUsage(env);
	assertWithinQuota(usage, storedNewBytes, 1, env);

	return {
		artifactKind: candidate.artifactKind,
		captureId: candidate.captureId,
		contentHash,
		parentCaptureId: candidate.parentCaptureId,
		baseGitCommit: candidate.baseGitCommit,
		inventoryBytes: candidate.inventoryBytes,
		materializedBytes: candidate.materializedBytes,
		uploadCandidateBytes: candidate.uploadCandidateBytes,
		newlyMaterializedBytes,
		reusedBytes: candidate.reusedBytes + deduplicatedMaterializedBytes,
		gitObjectBytes: candidate.gitObjectBytes,
		omittedBytes: candidate.omittedBytes,
		dependencyExclusions: candidate.dependencyExclusions,
		captureRecordBytes,
		storedNewBytes,
		missingBlobIds,
		alreadyStored: false,
		selfContained: candidate.externalObjectIds.length === 0,
		quota: usage,
	};
}

export async function writeRepositoryBundle(
	candidate: RepositoryBundleCandidate,
	binding: RepositorySpoolBinding,
	repositoryRoot: string,
	captureLifecycle: RepositoryCaptureLifecycle,
	env: RepositorySpoolEnv,
): Promise<RepositorySpoolWriteResult> {
	const paths = getSpoolPaths(binding, env);
	await ensureSpoolDirectories(paths);
	// The binding lock serializes writers of this repository binding. The
	// global lock guards only the cross-repository state (accounting, quota,
	// retirement) and the blob and record writes retirement must not race, so
	// hooks of other repositories wait only for that short section. Hashing
	// the stored blobs happens before it, verification of the result after it.
	const releaseBindingLock = await acquireSpoolWriteLock(paths.binding, env);
	try {
		validateCandidate(candidate);
		await findMissingBlobIds(candidate.blobs, paths, env, "verify");
		await assertReferencedBlobsAvailable(candidate, paths, env, "verify");
		const created = await commitRepositoryBundle(
			candidate,
			binding,
			repositoryRoot,
			captureLifecycle,
			paths,
			env,
		);
		const inspected = await inspectCaptureIfPresent(
			getCapturePath(paths, candidate.captureId),
			paths,
			env,
		);
		if (inspected?.summary.integrity !== "valid") {
			throw new RepositorySpoolCorruptionError(
				`Capture ${candidate.captureId} was not committed intact.`,
			);
		}
		return {
			created,
			capture: inspected.summary,
			quota: await getSpoolUsage(env),
		};
	} finally {
		await releaseBindingLock();
	}
}

async function commitRepositoryBundle(
	candidate: RepositoryBundleCandidate,
	binding: RepositorySpoolBinding,
	repositoryRoot: string,
	captureLifecycle: RepositoryCaptureLifecycle,
	paths: SpoolPaths,
	env: RepositorySpoolEnv,
): Promise<boolean> {
	const releaseLock = await acquireSpoolWriteLock(paths.root, env);
	try {
		await ensureCleanAccountingLocked(env);
		const plan = await planWithRetirement(
			candidate,
			binding,
			repositoryRoot,
			captureLifecycle,
			paths,
			env,
		);
		if (!plan.alreadyStored) {
			const before = await ensureCleanAccountingLocked(env);
			await writeSpoolAccounting({ ...before, state: "dirty" }, env);
			const blobsById = new Map(candidate.blobs.map((blob) => [blob.id, blob]));
			for (const blobId of plan.missingBlobIds) {
				const blob = blobsById.get(blobId);
				if (!blob) {
					throw new RepositorySpoolCorruptionError(
						`Capture ${candidate.captureId} is missing blob ${blobId}.`,
					);
				}
				await writeBlob(blob, paths, env);
			}

			const record = createStoredCaptureRecord(
				candidate,
				binding,
				repositoryRoot,
				captureLifecycle,
				candidate.capturedAt,
				plan.contentHash,
				plan.newlyMaterializedBytes,
				plan.materializedBytes - plan.newlyMaterializedBytes,
			);
			await writeImmutablePrivateFile(
				getCapturePath(paths, candidate.captureId),
				serializeRecord(record),
				paths.captures,
				env,
			);
			await writeSpoolAccounting(
				{
					...before,
					blobCount: before.blobCount + plan.missingBlobIds.length,
					captureCount: before.captureCount + 1,
					state: "clean",
					usedBytes: before.usedBytes + plan.storedNewBytes,
				},
				env,
			);
		}
		return !plan.alreadyStored;
	} finally {
		await releaseLock();
	}
}

async function planWithRetirement(
	candidate: RepositoryBundleCandidate,
	binding: RepositorySpoolBinding,
	repositoryRoot: string,
	captureLifecycle: RepositoryCaptureLifecycle,
	paths: SpoolPaths,
	env: RepositorySpoolEnv,
): Promise<RepositorySpoolPlan> {
	try {
		return await planRepositoryBundleWith(
			candidate,
			binding,
			repositoryRoot,
			captureLifecycle,
			env,
			"exists",
		);
	} catch (error) {
		if (!(error instanceof RepositorySpoolCapacityError)) throw error;
		const retirement = await retireAcceptedCapturesLocked(
			paths,
			env,
			new Set([
				...candidate.referencedBlobIds,
				...candidate.blobs.map((blob) => blob.id),
			]),
		);
		try {
			return await planRepositoryBundleWith(
				candidate,
				binding,
				repositoryRoot,
				captureLifecycle,
				env,
				"exists",
			);
		} catch (retryError) {
			if (!(retryError instanceof RepositorySpoolCapacityError)) {
				throw retryError;
			}
			throw new RepositorySpoolCapacityError(
				`${retryError.message} Retired ${retirement.retiredCaptures} accepted or abandoned capture(s); ${retirement.unsentCaptures} capture(s) holding ${retirement.unsentBytes} bytes are still awaiting delivery and were kept. Run \`opaline upload --retry\` to deliver them, then capture again.`,
			);
		}
	}
}

interface RetirementCapture {
	readonly bytes: number;
	readonly path: string;
	readonly record: StoredCaptureRecord | null;
}

interface BindingRetirementPlan {
	readonly captures: readonly RetirementCapture[];
	readonly keepBlobIds: ReadonlySet<string>;
	readonly paths: SpoolPaths;
	readonly retired: readonly RetirementCapture[];
	readonly unsent: readonly RetirementCapture[];
}

async function retireAcceptedCapturesLocked(
	currentPaths: SpoolPaths,
	env: RepositorySpoolEnv,
	keepBlobIds: ReadonlySet<string>,
): Promise<RepositorySpoolRetirementResult> {
	const before = await ensureCleanAccountingLocked(env);
	const bindingPaths = new Map<string, SpoolPaths>([
		[currentPaths.binding, currentPaths],
	]);
	for (const name of await readNamesIfDirectory(currentPaths.root)) {
		const binding = join(currentPaths.root, name);
		if (bindingPaths.has(binding)) continue;
		const details = await lstat(binding);
		if (!details.isDirectory() || details.isSymbolicLink()) continue;
		bindingPaths.set(binding, {
			binding,
			blobs: join(binding, "blobs"),
			captures: join(binding, "captures"),
			root: currentPaths.root,
		});
	}
	const plans: BindingRetirementPlan[] = [];
	for (const paths of bindingPaths.values()) {
		plans.push(
			await planBindingRetirement(
				paths,
				env,
				paths.binding === currentPaths.binding ? keepBlobIds : new Set(),
			),
		);
	}
	const unsentCaptures = plans.reduce(
		(total, plan) => total + plan.unsent.length,
		0,
	);
	const unsentBytes = plans.reduce(
		(total, plan) =>
			total + plan.unsent.reduce((sum, capture) => sum + capture.bytes, 0),
		0,
	);
	const retiredCaptures = plans.reduce(
		(total, plan) => total + plan.retired.length,
		0,
	);
	if (retiredCaptures === 0) {
		return {
			freedBytes: 0,
			retiredBlobs: 0,
			retiredCaptures: 0,
			unsentBytes,
			unsentCaptures,
		};
	}

	await writeSpoolAccounting({ ...before, state: "dirty" }, env);
	let freedBytes = 0;
	let retiredBlobs = 0;
	for (const plan of plans) {
		const applied = await applyBindingRetirement(plan);
		freedBytes += applied.freedBytes;
		retiredBlobs += applied.retiredBlobs;
	}
	await writeSpoolAccounting(
		{
			...before,
			blobCount: Math.max(0, before.blobCount - retiredBlobs),
			captureCount: Math.max(0, before.captureCount - retiredCaptures),
			state: "clean",
			usedBytes: Math.max(0, before.usedBytes - freedBytes),
		},
		env,
	);
	return {
		freedBytes,
		retiredBlobs,
		retiredCaptures,
		unsentBytes,
		unsentCaptures,
	};
}

async function planBindingRetirement(
	paths: SpoolPaths,
	env: RepositorySpoolEnv,
	keepBlobIds: ReadonlySet<string>,
): Promise<BindingRetirementPlan> {
	const names = await readNamesIfDirectory(paths.captures);
	const acceptedMarkers = new Set(
		names.filter((name) => name.endsWith(ACCEPTED_MARKER_SUFFIX)),
	);
	const abandonedMarkers = new Set(
		names.filter((name) => name.endsWith(ABANDONED_MARKER_SUFFIX)),
	);
	const captures: RetirementCapture[] = [];
	for (const name of names.filter((item) =>
		item.endsWith(CAPTURE_FILE_SUFFIX),
	)) {
		const path = join(paths.captures, name);
		env.onCaptureRead?.("scan", path);
		captures.push({
			bytes: await sizeIfRegularFile(path),
			path,
			record: await readStoredCapture(path),
		});
	}
	const heads = new Set<string>();
	for (const artifactKind of ["local-context", "github"] as const) {
		const head = await readAcceptedRepositoryCapture(
			getAcceptedCapturePath(paths, artifactKind),
		);
		if (head) heads.add(head.captureId);
	}
	const isRetirable = (captureId: string) =>
		acceptedMarkers.has(getAcceptedMarkerName(captureId)) ||
		abandonedMarkers.has(getAbandonedMarkerName(captureId));
	const unsent = captures.filter(
		(capture) =>
			capture.record === null || !isRetirable(capture.record.captureId),
	);
	const protectedIds = new Set(heads);
	for (const capture of unsent) {
		if (capture.record?.parentCaptureId) {
			protectedIds.add(capture.record.parentCaptureId);
		}
	}
	const retired = captures.filter(
		(capture) =>
			capture.record !== null &&
			isRetirable(capture.record.captureId) &&
			!protectedIds.has(capture.record.captureId),
	);
	return { captures, keepBlobIds, paths, retired, unsent };
}

async function applyBindingRetirement(
	plan: BindingRetirementPlan,
): Promise<{ readonly freedBytes: number; readonly retiredBlobs: number }> {
	if (plan.retired.length === 0) return { freedBytes: 0, retiredBlobs: 0 };
	const { paths } = plan;
	const retiredPaths = new Set(plan.retired.map((capture) => capture.path));
	let freedBytes = 0;
	for (const capture of plan.retired) {
		freedBytes += capture.bytes;
		await rm(capture.path, { force: true });
		if (capture.record) {
			await rm(getAcceptedMarkerPath(paths, capture.record.captureId), {
				force: true,
			});
			await rm(getAbandonedMarkerPath(paths, capture.record.captureId), {
				force: true,
			});
		}
	}
	const retainedBlobIds = new Set(plan.keepBlobIds);
	for (const capture of plan.captures) {
		if (retiredPaths.has(capture.path) || capture.record === null) continue;
		for (const blobId of capture.record.referencedBlobIds) {
			retainedBlobIds.add(blobId);
		}
		for (const blobId of capture.record.materializedBlobIds) {
			retainedBlobIds.add(blobId);
		}
	}
	let retiredBlobs = 0;
	if (!plan.captures.some((capture) => capture.record === null)) {
		for (const name of await readNamesIfDirectory(paths.blobs)) {
			if (!name.endsWith(BLOB_FILE_SUFFIX)) continue;
			const blobId = `sha256:${name.slice(0, -BLOB_FILE_SUFFIX.length)}`;
			if (retainedBlobIds.has(blobId)) continue;
			const path = join(paths.blobs, name);
			freedBytes += await sizeIfRegularFile(path);
			retiredBlobs += 1;
			await rm(path, { force: true });
		}
	}
	return { freedBytes, retiredBlobs };
}

export async function retireAcceptedRepositoryCaptures(
	binding: RepositorySpoolBinding,
	env: RepositorySpoolEnv,
): Promise<RepositorySpoolRetirementResult> {
	const paths = getSpoolPaths(binding, env);
	await ensureSpoolDirectories(paths);
	const releaseLock = await acquireSpoolWriteLock(paths.root, env);
	try {
		return await retireAcceptedCapturesLocked(paths, env, new Set());
	} finally {
		await releaseLock();
	}
}

export async function listRepositorySpool(
	binding: RepositorySpoolBinding,
	repositoryRoot: string,
	env: RepositorySpoolEnv,
): Promise<RepositorySpoolListing> {
	return inspectSpool(binding, repositoryRoot, env);
}

async function inspectSpool(
	binding: RepositorySpoolBinding,
	_repositoryRoot: string,
	env: RepositorySpoolEnv,
): Promise<RepositorySpoolListing> {
	const paths = getSpoolPaths(binding, env);
	const captureNames = await readNamesIfDirectory(paths.captures);
	const captures: RepositorySpoolCaptureSummary[] = [];
	for (const name of captureNames.filter((item) =>
		item.endsWith(CAPTURE_FILE_SUFFIX),
	)) {
		const inspected = await inspectCaptureIfPresent(
			join(paths.captures, name),
			paths,
			env,
		);
		if (inspected) captures.push(inspected.summary);
	}
	captures.sort((left, right) =>
		right.capturedAt.localeCompare(left.capturedAt),
	);

	const globalStatus = await inspectGlobalUsage(env);
	const oldestCaptureAt = captures.reduce<string | null>(
		(oldest, capture) =>
			oldest === null || capture.capturedAt < oldest
				? capture.capturedAt
				: oldest,
		null,
	);
	return {
		bindingKey: getBindingKey(binding),
		captures,
		quota: globalStatus.quota,
		retention: {
			automaticCleanup: true,
			policy: "retire-accepted-on-quota-pressure",
			oldestCaptureAt,
			abandonedTemporaryFiles: globalStatus.temporaryFiles,
		},
	};
}

function toUsage(
	accounting: Pick<SpoolAccounting, "usedBytes" | "captureCount" | "blobCount">,
	env: RepositorySpoolEnv,
): RepositorySpoolUsage {
	return {
		usedBytes: accounting.usedBytes,
		maxBytes: env.maxStoredBytes,
		remainingBytes: Math.max(0, env.maxStoredBytes - accounting.usedBytes),
		captureCount: accounting.captureCount,
		maxCaptures: env.maxCaptures,
		blobCount: accounting.blobCount,
	};
}

function getAccountingPath(env: RepositorySpoolEnv): string {
	return join(
		env.configDir,
		"repo-context-spool",
		`accounting.v${SPOOL_SCHEMA_VERSION}.json`,
	);
}

async function readSpoolAccounting(
	env: RepositorySpoolEnv,
): Promise<SpoolAccounting | null> {
	const bytes = await readFileIfPresent(getAccountingPath(env));
	if (!bytes) return null;
	let value: unknown;
	try {
		value = JSON.parse(bytes.toString("utf8"));
	} catch {
		return null;
	}
	if (
		!isRecord(value) ||
		value.version !== ACCOUNTING_VERSION ||
		(value.state !== "clean" && value.state !== "dirty") ||
		!isNonNegativeInteger(value.usedBytes) ||
		!isNonNegativeInteger(value.captureCount) ||
		!isNonNegativeInteger(value.blobCount)
	) {
		return null;
	}
	return {
		blobCount: value.blobCount,
		captureCount: value.captureCount,
		state: value.state,
		usedBytes: value.usedBytes,
		version: ACCOUNTING_VERSION,
	};
}

async function writeSpoolAccounting(
	accounting: Omit<SpoolAccounting, "version">,
	env: RepositorySpoolEnv,
): Promise<void> {
	await writeMutablePrivateFile(
		getAccountingPath(env),
		`${JSON.stringify({ ...accounting, version: ACCOUNTING_VERSION })}\n`,
		env,
	);
}

async function getSpoolUsage(
	env: RepositorySpoolEnv,
): Promise<RepositorySpoolUsage> {
	const accounting = await readSpoolAccounting(env);
	if (accounting?.state === "clean") return toUsage(accounting, env);
	return (await inspectGlobalUsage(env)).quota;
}

async function ensureCleanAccountingLocked(
	env: RepositorySpoolEnv,
): Promise<SpoolAccounting> {
	const accounting = await readSpoolAccounting(env);
	if (accounting?.state === "clean") return accounting;
	const { quota } = await inspectGlobalUsage(env);
	const rebuilt: SpoolAccounting = {
		blobCount: quota.blobCount,
		captureCount: quota.captureCount,
		state: "clean",
		usedBytes: quota.usedBytes,
		version: ACCOUNTING_VERSION,
	};
	await writeSpoolAccounting(rebuilt, env);
	return rebuilt;
}

function getAcceptedMarkerName(captureId: string): string {
	return `${sha256(captureId)}${ACCEPTED_MARKER_SUFFIX}`;
}

function getAcceptedMarkerPath(paths: SpoolPaths, captureId: string): string {
	return join(paths.captures, getAcceptedMarkerName(captureId));
}

function getAbandonedMarkerName(captureId: string): string {
	return `${sha256(captureId)}${ABANDONED_MARKER_SUFFIX}`;
}

function getAbandonedMarkerPath(paths: SpoolPaths, captureId: string): string {
	return join(paths.captures, getAbandonedMarkerName(captureId));
}

async function inspectGlobalUsage(env: RepositorySpoolEnv): Promise<{
	readonly quota: RepositorySpoolQuota;
	readonly temporaryFiles: number;
}> {
	const root = join(
		env.configDir,
		"repo-context-spool",
		`v${SPOOL_SCHEMA_VERSION}`,
	);
	const bindingNames = await readNamesIfDirectory(root);
	let usedBytes = 0;
	let captureCount = 0;
	let blobCount = 0;
	let temporaryFiles = 0;
	let orphanBlobCount = 0;
	let orphanBlobBytes = 0;

	for (const bindingName of bindingNames) {
		const bindingPath = join(root, bindingName);
		const capturePath = join(bindingPath, "captures");
		const blobPath = join(bindingPath, "blobs");
		const captureNames = await readNamesIfDirectory(capturePath);
		const referenced = new Set<string>();
		for (const name of captureNames) {
			const path = join(capturePath, name);
			if (name.endsWith(TEMP_FILE_SUFFIX)) {
				temporaryFiles += 1;
				usedBytes += await sizeIfRegularFile(path);
				continue;
			}
			if (!name.endsWith(CAPTURE_FILE_SUFFIX)) continue;
			captureCount += 1;
			usedBytes += await sizeIfRegularFile(path);
			env.onCaptureRead?.("scan", path);
			const record = await readStoredCapture(path);
			if (record) {
				for (const blobId of record.referencedBlobIds) referenced.add(blobId);
			}
		}

		const blobNames = await readNamesIfDirectory(blobPath);
		for (const name of blobNames) {
			const path = join(blobPath, name);
			if (name.endsWith(TEMP_FILE_SUFFIX)) {
				temporaryFiles += 1;
				usedBytes += await sizeIfRegularFile(path);
				continue;
			}
			if (!name.endsWith(BLOB_FILE_SUFFIX)) continue;
			const size = await sizeIfRegularFile(path);
			blobCount += 1;
			usedBytes += size;
			const blobId = `sha256:${name.slice(0, -BLOB_FILE_SUFFIX.length)}`;
			if (!referenced.has(blobId)) {
				orphanBlobCount += 1;
				orphanBlobBytes += size;
			}
		}
	}

	return {
		quota: {
			usedBytes,
			maxBytes: env.maxStoredBytes,
			remainingBytes: Math.max(0, env.maxStoredBytes - usedBytes),
			captureCount,
			maxCaptures: env.maxCaptures,
			blobCount,
			orphanBlobCount,
			orphanBlobBytes,
		},
		temporaryFiles,
	};
}

function createStoredCaptureRecord(
	candidate: RepositoryBundleCandidate,
	binding: RepositorySpoolBinding,
	repositoryRoot: string,
	captureLifecycle: RepositoryCaptureLifecycle,
	capturedAt: string,
	contentHash: string,
	newlyMaterializedBytes: number,
	deduplicatedMaterializedBytes: number,
): StoredCaptureRecord {
	const body: StoredCaptureRecordBody = {
		schemaVersion: SPOOL_SCHEMA_VERSION,
		artifactKind: candidate.artifactKind,
		captureId: candidate.captureId,
		contentHash,
		captureLifecycle,
		capturedAt,
		parentCaptureId: candidate.parentCaptureId,
		baseGitCommit: candidate.baseGitCommit,
		repositoryName: basename(repositoryRoot),
		repositoryKey: binding.repositoryKey,
		binding,
		manifest: candidate.manifest,
		materializedBlobIds: candidate.blobs.map((blob) => blob.id),
		referencedBlobIds: [...new Set(candidate.referencedBlobIds)].sort(),
		externalObjectIds: [...new Set(candidate.externalObjectIds)].sort(),
		sourceObjects: normalizeSourceObjects(candidate.sourceObjects),
		metrics: {
			inventoryBytes: candidate.inventoryBytes,
			materializedBytes: candidate.materializedBytes,
			uploadCandidateBytes: candidate.uploadCandidateBytes,
			newlyMaterializedBytes,
			reusedBytes: candidate.reusedBytes + deduplicatedMaterializedBytes,
			gitObjectBytes: candidate.gitObjectBytes,
			omittedBytes: candidate.omittedBytes,
			dependencyExclusions: candidate.dependencyExclusions,
		},
	};
	return { ...body, recordHash: hashRecordBody(body) };
}

async function findMissingBlobIds(
	blobs: readonly RepositorySpoolBlob[],
	paths: SpoolPaths,
	env: RepositorySpoolEnv,
	blobCheck: "exists" | "verify",
): Promise<readonly string[]> {
	const missing: string[] = [];
	for (const blob of blobs) {
		validateBlob(blob, env);
		const path = getBlobPath(paths, blob.id);
		if (blobCheck === "exists") {
			if (!(await isRegularFile(path))) missing.push(blob.id);
			continue;
		}
		const existing = await readFileIfPresent(path);
		if (existing === null) {
			missing.push(blob.id);
			continue;
		}
		await enforcePrivateFile(path);
		if (sha256(existing) !== blobDigest(blob.id)) {
			throw new RepositorySpoolCorruptionError(
				`Stored repository blob ${blob.id} failed its content hash.`,
			);
		}
	}
	return missing;
}

async function assertReferencedBlobsAvailable(
	candidate: RepositoryBundleCandidate,
	paths: SpoolPaths,
	env: RepositorySpoolEnv,
	blobCheck: "exists" | "verify",
): Promise<void> {
	const materializedIds = new Set(candidate.blobs.map((blob) => blob.id));
	for (const blobId of candidate.referencedBlobIds) {
		if (materializedIds.has(blobId)) continue;
		const path = getBlobPath(paths, blobId);
		if (blobCheck === "exists") {
			if (!(await isRegularFile(path)))
				throw new RepositorySpoolCorruptionError(
					`Capture ${candidate.captureId} references unavailable parent blob ${blobId}.`,
				);
			continue;
		}
		const content = await readFileIfPresent(path);
		if (content === null) {
			throw new RepositorySpoolCorruptionError(
				`Capture ${candidate.captureId} references unavailable parent blob ${blobId}.`,
			);
		}
		await enforcePrivateFile(path);
		if (
			content.byteLength > env.maxBlobBytes ||
			sha256(content) !== blobDigest(blobId)
		) {
			throw new RepositorySpoolCorruptionError(
				`Capture ${candidate.captureId} references corrupt parent blob ${blobId}.`,
			);
		}
	}
}

async function writeBlob(
	blob: RepositorySpoolBlob,
	paths: SpoolPaths,
	env: RepositorySpoolEnv,
): Promise<void> {
	validateBlob(blob, env);
	await writeImmutablePrivateFile(
		getBlobPath(paths, blob.id),
		blob.content,
		paths.blobs,
		env,
	);
}

async function writeImmutablePrivateFile(
	finalPath: string,
	content: string,
	parentDirectory: string,
	env: RepositorySpoolEnv,
): Promise<void> {
	const temporaryPath = join(
		parentDirectory,
		`.${basename(finalPath)}.${process.pid}.${env.createNonce()}${TEMP_FILE_SUFFIX}`,
	);
	const handle = await open(temporaryPath, "wx", PRIVATE_FILE_MODE);
	try {
		await handle.writeFile(content, "utf8");
		await handle.sync();
		await handle.close();
		await enforcePrivateFile(temporaryPath);
		try {
			await env.commitImmutableFile(temporaryPath, finalPath);
		} catch (error) {
			if (!isErrorCode(error, "EEXIST")) throw error;
			const [existing, expected] = await Promise.all([
				readFile(finalPath),
				Promise.resolve(Buffer.from(content)),
			]);
			if (!existing.equals(expected)) {
				throw new RepositorySpoolCorruptionError(
					`Immutable spool file already exists with different content: ${basename(finalPath)}`,
				);
			}
		}
		await syncDirectory(parentDirectory);
	} finally {
		await handle.close().catch(() => undefined);
		await rm(temporaryPath, { force: true });
	}
}

async function inspectCaptureIfPresent(
	path: string,
	paths: SpoolPaths,
	env: RepositorySpoolEnv,
): Promise<InspectedCapture | null> {
	const content = await readFileIfPresent(path);
	if (content === null) return null;
	env.onCaptureRead?.("verify", path);
	await enforcePrivateFile(path);
	const storedBytes = content.byteLength;
	const record = parseStoredCapture(content.toString("utf8"));
	if (!record) {
		return {
			record: null,
			summary: corruptSummary(
				path,
				storedBytes,
				"Capture record is invalid JSON or has an unsupported schema.",
			),
		};
	}
	const expectedPath = getCapturePath(paths, record.captureId);
	if (expectedPath !== path) {
		return {
			record,
			summary: toCaptureSummary(
				record,
				storedBytes,
				"Capture ID does not match its immutable file name.",
			),
		};
	}
	let hashError = validateStoredCaptureRecord(record);
	try {
		if (hashError === null) {
			const serialized = await serializeStoredBundle(record, paths, env);
			if (sha256(serialized) !== record.contentHash) {
				hashError =
					"Capture content hash does not match its manifest and materialized blobs.";
			}
		}
	} catch (error) {
		hashError =
			error instanceof Error
				? error.message
				: "Capture content could not be reconstructed.";
	}
	return {
		record,
		summary: toCaptureSummary(record, storedBytes, hashError),
	};
}

function validateStoredCaptureRecord(
	record: StoredCaptureRecord,
): string | null {
	if (hashRecordBody(toRecordBody(record)) !== record.recordHash) {
		return "Capture record hash does not match its immutable metadata and indexes.";
	}
	if (record.repositoryKey !== record.binding.repositoryKey) {
		return "Capture repository binding is inconsistent.";
	}
	if (!isSortedUnique(record.materializedBlobIds)) {
		return "Capture materialized blob index is not sorted and unique.";
	}
	if (!isSortedUnique(record.referencedBlobIds)) {
		return "Capture referenced blob index is not sorted and unique.";
	}
	if (!isSortedUnique(record.externalObjectIds)) {
		return "Capture external-object index is not sorted and unique.";
	}
	if (!isSortedUnique(record.sourceObjects.map((item) => item.id))) {
		return "Capture source-object index is not sorted and unique.";
	}
	const referenced = new Set(record.referencedBlobIds);
	for (const blobId of record.materializedBlobIds) {
		try {
			blobDigest(blobId);
		} catch {
			return "Capture materialized blob index contains an invalid ID.";
		}
		if (!referenced.has(blobId)) {
			return "Capture materialized blob index is not a subset of referenced blobs.";
		}
	}
	for (const blobId of record.referencedBlobIds) {
		try {
			blobDigest(blobId);
		} catch {
			return "Capture referenced blob index contains an invalid ID.";
		}
	}
	for (const sourceObject of record.sourceObjects) {
		if (sourceObject.blobId !== null && !referenced.has(sourceObject.blobId)) {
			return "Capture source-object inventory references an unindexed blob.";
		}
	}
	if (
		record.metrics.newlyMaterializedBytes > record.metrics.materializedBytes
	) {
		return "Capture byte metrics are internally inconsistent.";
	}
	return null;
}

function isSortedUnique(values: readonly string[]): boolean {
	for (let index = 0; index < values.length; index += 1) {
		const previous = values[index - 1];
		const current = values[index];
		if (
			current === undefined ||
			(previous !== undefined && previous >= current)
		) {
			return false;
		}
	}
	return true;
}

async function serializeStoredBundle(
	record: StoredCaptureRecord,
	paths: SpoolPaths,
	env: RepositorySpoolEnv,
): Promise<string> {
	const blobs = await readBlobs(record.materializedBlobIds, paths, env);
	return JSON.stringify({ manifest: record.manifest, blobs });
}

async function readBlobs(
	blobIds: readonly string[],
	paths: SpoolPaths,
	env: RepositorySpoolEnv,
): Promise<
	readonly {
		readonly id: string;
		readonly algorithm: "sha256";
		readonly byteLength: number;
		readonly encoding: "utf-8";
		readonly content: string;
	}[]
> {
	const blobs = [];
	for (const blobId of [...new Set(blobIds)].sort()) {
		const path = getBlobPath(paths, blobId);
		const content = await readFileIfPresent(path);
		if (content === null) {
			throw new RepositorySpoolCorruptionError(
				`Stored repository blob is missing: ${blobId}`,
			);
		}
		await enforcePrivateFile(path);
		const digest = sha256(content);
		if (digest !== blobDigest(blobId)) {
			throw new RepositorySpoolCorruptionError(
				`Stored repository blob failed its content hash: ${blobId}`,
			);
		}
		if (content.byteLength > env.maxBlobBytes) {
			throw new RepositorySpoolCorruptionError(
				`Stored repository blob exceeds the configured per-blob limit: ${blobId}`,
			);
		}
		blobs.push({
			id: blobId,
			algorithm: "sha256" as const,
			byteLength: content.byteLength,
			encoding: "utf-8" as const,
			content: content.toString("utf8"),
		});
	}
	return blobs;
}

function validateCandidate(candidate: RepositoryBundleCandidate): void {
	if (!candidate.captureId.trim()) {
		throw new Error("Repository capture ID is empty.");
	}
	if (Number.isNaN(Date.parse(candidate.capturedAt))) {
		throw new Error("Repository capture timestamp is invalid.");
	}
	if (candidate.serializedBundle.includes("\u0000")) {
		throw new Error("Repository bundle contains an unsupported NUL character.");
	}
	if (
		Buffer.byteLength(candidate.serializedBundle) !==
		candidate.uploadCandidateBytes
	) {
		throw new Error(
			"Repository upload-candidate bytes do not match the exact serialized thin bundle.",
		);
	}
	for (const value of [
		candidate.inventoryBytes,
		candidate.materializedBytes,
		candidate.uploadCandidateBytes,
		candidate.reusedBytes,
		candidate.gitObjectBytes,
		candidate.omittedBytes,
		candidate.dependencyExclusions,
	]) {
		if (!Number.isSafeInteger(value) || value < 0) {
			throw new Error(
				"Repository bundle byte metrics must be non-negative integers.",
			);
		}
	}
	const referenced = new Set(candidate.referencedBlobIds);
	for (const blob of candidate.blobs) {
		if (!referenced.has(blob.id)) {
			throw new Error(
				`Repository bundle materialized blob is absent from its reference index: ${blob.id}`,
			);
		}
	}
	for (const sourceObject of candidate.sourceObjects) {
		if (sourceObject.blobId !== null && !referenced.has(sourceObject.blobId)) {
			throw new Error(
				`Repository source-object inventory references an unavailable blob: ${sourceObject.id}`,
			);
		}
	}
}

function validateBlob(
	blob: RepositorySpoolBlob,
	env: RepositorySpoolEnv,
): void {
	const actualBytes = Buffer.byteLength(blob.content);
	if (actualBytes !== blob.byteLength) {
		throw new RepositorySpoolCorruptionError(
			`Repository blob ${blob.id} has an incorrect byte length.`,
		);
	}
	if (actualBytes > env.maxBlobBytes) {
		throw new RepositorySpoolQuotaError(
			`Repository blob ${blob.id} is ${actualBytes} bytes; the per-blob limit is ${env.maxBlobBytes} bytes. No capture was committed.`,
		);
	}
	if (sha256(blob.content) !== blobDigest(blob.id)) {
		throw new RepositorySpoolCorruptionError(
			`Repository blob ${blob.id} does not match its content hash.`,
		);
	}
}

function assertWithinQuota(
	quota: RepositorySpoolUsage,
	newBytes: number,
	newCaptures: number,
	env: RepositorySpoolEnv,
): void {
	if (quota.usedBytes + newBytes > env.maxStoredBytes) {
		throw new RepositorySpoolCapacityError(
			`Repository spool needs ${newBytes} new bytes but only ${quota.remainingBytes} bytes remain. Accepted or abandoned captures are retired automatically when space runs out; captures awaiting delivery are never deleted.`,
		);
	}
	if (quota.captureCount + newCaptures > env.maxCaptures) {
		throw new RepositorySpoolCapacityError(
			`Repository spool capture limit (${env.maxCaptures}) reached. Accepted or abandoned captures are retired automatically when space runs out; captures awaiting delivery are never deleted.`,
		);
	}
}

function getSpoolPaths(
	binding: RepositorySpoolBinding,
	env: RepositorySpoolEnv,
): SpoolPaths {
	const root = join(
		env.configDir,
		"repo-context-spool",
		`v${SPOOL_SCHEMA_VERSION}`,
	);
	const bindingPath = join(root, getBindingKey(binding));
	return {
		root,
		binding: bindingPath,
		blobs: join(bindingPath, "blobs"),
		captures: join(bindingPath, "captures"),
	};
}

function getBindingKey(binding: RepositorySpoolBinding): string {
	return sha256(JSON.stringify(binding));
}

function getCapturePath(paths: SpoolPaths, captureId: string): string {
	return join(paths.captures, `${sha256(captureId)}${CAPTURE_FILE_SUFFIX}`);
}

function getAcceptedCapturePath(
	paths: SpoolPaths,
	artifactKind: "local-context" | "github",
): string {
	return join(paths.binding, `${artifactKind}.accepted.json`);
}

function getBlobPath(paths: SpoolPaths, blobId: string): string {
	return join(paths.blobs, `${blobDigest(blobId)}${BLOB_FILE_SUFFIX}`);
}

async function ensureSpoolDirectories(paths: SpoolPaths): Promise<void> {
	for (const path of [
		dirname(paths.root),
		paths.root,
		paths.binding,
		paths.blobs,
		paths.captures,
	]) {
		await ensurePrivateDirectory(path);
	}
}

async function readAcceptedRepositoryCapture(
	path: string,
): Promise<AcceptedRepositoryCapture | null> {
	const bytes = await readFileIfPresent(path);
	if (!bytes) return null;
	try {
		const value: unknown = JSON.parse(bytes.toString("utf8"));
		if (typeof value !== "object" || value === null) return null;
		if (
			!("version" in value) ||
			value.version !== ACCEPTED_CAPTURE_VERSION ||
			!("captureId" in value) ||
			typeof value.captureId !== "string" ||
			!("capturedAt" in value) ||
			typeof value.capturedAt !== "string"
		) {
			return null;
		}
		return {
			captureId: value.captureId,
			capturedAt: value.capturedAt,
			version: ACCEPTED_CAPTURE_VERSION,
		};
	} catch {
		return null;
	}
}

function compareCaptureOrder(
	left: Pick<AcceptedRepositoryCapture, "captureId" | "capturedAt">,
	right: Pick<AcceptedRepositoryCapture, "captureId" | "capturedAt">,
): number {
	const timeOrder = left.capturedAt.localeCompare(right.capturedAt);
	return timeOrder === 0
		? left.captureId.localeCompare(right.captureId)
		: timeOrder;
}

async function writeMutablePrivateFile(
	path: string,
	content: string,
	env: RepositorySpoolEnv,
): Promise<void> {
	const temporaryPath = `${path}.${process.pid}.${env.createNonce()}${TEMP_FILE_SUFFIX}`;
	const handle = await open(temporaryPath, "wx", PRIVATE_FILE_MODE);
	try {
		await handle.writeFile(content, "utf8");
		await handle.sync();
	} finally {
		await handle.close();
	}
	try {
		await enforcePrivateFile(temporaryPath);
		await rename(temporaryPath, path);
		await enforcePrivateFile(path);
		await syncDirectory(dirname(path));
	} finally {
		await rm(temporaryPath, { force: true });
	}
}

/** Spool write locks this process holds: released if it is told to stop. */
const heldWriteLocks = new Map<string, string>();
const RELEASE_SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"] as const;
let releaseHandlersInstalled = false;

function releaseHeldWriteLocksSync(): void {
	for (const [lockPath, ownerToken] of heldWriteLocks) {
		try {
			if (readFileSync(join(lockPath, "owner"), "utf8") === ownerToken)
				rmSync(lockPath, { recursive: true, force: true });
		} catch {
			// Already gone, or no longer ours.
		}
	}
	heldWriteLocks.clear();
}

function onReleaseSignal(signal: NodeJS.Signals): void {
	releaseHeldWriteLocksSync();
	uninstallReleaseHandlers();
	// Without another listener the signal's default action (exit) was
	// replaced by ours: restore it so the process still ends.
	if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
}

/**
 * While a spool lock is held, a host that stops the hook (SIGTERM, SIGINT,
 * SIGHUP, e.g. `claude -p` exiting about a second after start) or a normal
 * exit releases it, instead of leaving other hooks to wait it out.
 */
function installReleaseHandlers(): void {
	if (releaseHandlersInstalled) return;
	releaseHandlersInstalled = true;
	process.on("exit", releaseHeldWriteLocksSync);
	for (const signal of RELEASE_SIGNALS) process.on(signal, onReleaseSignal);
}

function uninstallReleaseHandlers(): void {
	if (!releaseHandlersInstalled) return;
	releaseHandlersInstalled = false;
	process.off("exit", releaseHeldWriteLocksSync);
	for (const signal of RELEASE_SIGNALS) process.off(signal, onReleaseSignal);
}

export async function acquireSpoolWriteLock(
	spoolRoot: string,
	env: RepositorySpoolEnv,
): Promise<() => Promise<void>> {
	const lockPath = join(spoolRoot, WRITE_LOCK_NAME);
	const ownerPath = join(lockPath, "owner");
	const ownerToken = `${process.pid}:${env.createNonce()}`;
	// Monotonic elapsed time: hooks under test may freeze Date.now().
	const startedAt = performance.now();
	while (true) {
		let createdLock = false;
		try {
			await mkdir(lockPath, { mode: PRIVATE_DIRECTORY_MODE });
			createdLock = true;
			await ensurePrivateDirectory(lockPath);
			const owner = await open(ownerPath, "wx", PRIVATE_FILE_MODE);
			try {
				await owner.writeFile(ownerToken, "utf8");
				await owner.sync();
			} finally {
				await owner.close();
			}
			await enforcePrivateFile(ownerPath);
			await syncDirectory(spoolRoot);
			heldWriteLocks.set(lockPath, ownerToken);
			installReleaseHandlers();
			const heartbeat = setInterval(
				() => {
					void renewOwnedWriteLock(lockPath, ownerPath, ownerToken).catch(
						() => undefined,
					);
				},
				Math.max(10, Math.floor(env.writeLockStaleMs / 3)),
			);
			return async () => {
				clearInterval(heartbeat);
				heldWriteLocks.delete(lockPath);
				if (heldWriteLocks.size === 0) uninstallReleaseHandlers();
				const currentOwner = await readFileIfPresent(ownerPath);
				if (currentOwner?.toString("utf8") === ownerToken) {
					await rm(lockPath, { recursive: true, force: true });
					await syncDirectory(spoolRoot);
				}
			};
		} catch (error) {
			if (createdLock) {
				await rm(lockPath, { recursive: true, force: true });
				throw error;
			}
			if (!isErrorCode(error, "EEXIST")) {
				throw error;
			}
			if (await recoverStaleWriteLock(lockPath, env)) continue;
			if (performance.now() - startedAt >= env.writeLockTimeoutMs) {
				throw new Error(
					"Timed out waiting for another repository spool writer. No capture was changed.",
				);
			}
			await delay(env.writeLockPollMs);
		}
	}
}

async function recoverStaleWriteLock(
	lockPath: string,
	env: RepositorySpoolEnv,
): Promise<boolean> {
	let ageMs: number;
	try {
		ageMs = env.now().getTime() - (await stat(lockPath)).mtimeMs;
	} catch (error) {
		if (isErrorCode(error, "ENOENT")) return true;
		throw error;
	}
	// A holder whose process is gone (killed by its host, crashed) is stale
	// at once; otherwise only once it stopped renewing the lock.
	const owner = await getWriteLockOwnerState(lockPath);
	if (owner !== "dead" && (ageMs < env.writeLockStaleMs || owner === "alive")) {
		return false;
	}
	const stalePath = `${lockPath}.stale.${env.createNonce()}`;
	try {
		await rename(lockPath, stalePath);
	} catch (error) {
		if (isErrorCode(error, "ENOENT")) return true;
		throw error;
	}
	await rm(stalePath, { recursive: true, force: true });
	return true;
}

async function renewOwnedWriteLock(
	lockPath: string,
	ownerPath: string,
	ownerToken: string,
): Promise<void> {
	const currentOwner = await readFileIfPresent(ownerPath);
	if (currentOwner?.toString("utf8") !== ownerToken) return;
	const now = new Date();
	try {
		await utimes(lockPath, now, now);
	} catch (error) {
		if (!isErrorCode(error, "ENOENT")) throw error;
	}
}

/**
 * `dead` only when the owner file names a process that no longer exists;
 * `unknown` when there is no readable owner yet (a lock being created).
 */
async function getWriteLockOwnerState(
	lockPath: string,
): Promise<"alive" | "dead" | "unknown"> {
	const owner = await readFileIfPresent(join(lockPath, "owner"));
	const processIdText = owner?.toString("utf8").split(":", 1)[0];
	if (!processIdText || !/^\d+$/u.test(processIdText)) return "unknown";
	const processId = Number(processIdText);
	if (processId === process.pid) return "alive";
	try {
		process.kill(processId, 0);
		return "alive";
	} catch (error) {
		return isErrorCode(error, "ESRCH") ? "dead" : "alive";
	}
}

async function delay(milliseconds: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function ensurePrivateDirectory(path: string): Promise<void> {
	await mkdir(path, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
	const details = await lstat(path);
	if (!details.isDirectory() || details.isSymbolicLink()) {
		throw new Error(`Private spool path is not a directory: ${path}`);
	}
	if (process.platform !== "win32") {
		await chmod(path, PRIVATE_DIRECTORY_MODE);
		if (((await stat(path)).mode & 0o777) !== PRIVATE_DIRECTORY_MODE) {
			throw new Error(`Unable to establish private spool permissions: ${path}`);
		}
	}
}

async function enforcePrivateFile(path: string): Promise<void> {
	const details = await lstat(path);
	if (!details.isFile() || details.isSymbolicLink()) {
		throw new RepositorySpoolCorruptionError(
			`Private spool entry is not a regular file: ${basename(path)}`,
		);
	}
	if (process.platform !== "win32") {
		await chmod(path, PRIVATE_FILE_MODE);
		if (((await stat(path)).mode & 0o777) !== PRIVATE_FILE_MODE) {
			throw new Error(
				`Unable to establish private spool permissions: ${basename(path)}`,
			);
		}
	}
}

async function syncDirectory(path: string): Promise<void> {
	if (process.platform === "win32") return;
	const handle = await open(path, "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

async function readNamesIfDirectory(path: string): Promise<readonly string[]> {
	try {
		const details = await lstat(path);
		if (!details.isDirectory() || details.isSymbolicLink()) return [];
		if (process.platform !== "win32") await chmod(path, PRIVATE_DIRECTORY_MODE);
		return await readdir(path);
	} catch (error) {
		if (isErrorCode(error, "ENOENT")) return [];
		throw error;
	}
}

async function readFileIfPresent(path: string): Promise<Buffer | null> {
	try {
		return await readFile(path);
	} catch (error) {
		if (isErrorCode(error, "ENOENT")) return null;
		throw error;
	}
}

async function isRegularFile(path: string): Promise<boolean> {
	try {
		const details = await lstat(path);
		return details.isFile();
	} catch (error) {
		if (isErrorCode(error, "ENOENT")) return false;
		throw error;
	}
}

async function sizeIfRegularFile(path: string): Promise<number> {
	try {
		const details = await lstat(path);
		return details.isFile() && !details.isSymbolicLink() ? details.size : 0;
	} catch (error) {
		if (isErrorCode(error, "ENOENT")) return 0;
		throw error;
	}
}

async function readStoredCapture(
	path: string,
): Promise<StoredCaptureRecord | null> {
	const content = await readFileIfPresent(path);
	return content ? parseStoredCapture(content.toString("utf8")) : null;
}

function parseStoredCapture(content: string): StoredCaptureRecord | null {
	let value: unknown;
	try {
		value = JSON.parse(content);
	} catch {
		return null;
	}
	if (!isRecord(value) || value.schemaVersion !== SPOOL_SCHEMA_VERSION)
		return null;
	if (
		(value.artifactKind !== "local-context" &&
			value.artifactKind !== "github") ||
		typeof value.captureId !== "string" ||
		typeof value.contentHash !== "string" ||
		typeof value.recordHash !== "string" ||
		!isCaptureLifecycle(value.captureLifecycle) ||
		typeof value.capturedAt !== "string" ||
		!isNullableString(value.parentCaptureId) ||
		!isNullableString(value.baseGitCommit) ||
		typeof value.repositoryName !== "string" ||
		typeof value.repositoryKey !== "string" ||
		!isRepositorySpoolBinding(value.binding) ||
		!isStringArray(value.materializedBlobIds) ||
		!isStringArray(value.referencedBlobIds) ||
		!isStringArray(value.externalObjectIds) ||
		!isSourceObjects(value.sourceObjects) ||
		!isRecord(value.metrics)
	) {
		return null;
	}
	const metrics = value.metrics;
	if (
		!isNonNegativeInteger(metrics.inventoryBytes) ||
		!isNonNegativeInteger(metrics.materializedBytes) ||
		!isNonNegativeInteger(metrics.uploadCandidateBytes) ||
		!isNonNegativeInteger(metrics.newlyMaterializedBytes) ||
		!isNonNegativeInteger(metrics.reusedBytes) ||
		!isNonNegativeInteger(metrics.gitObjectBytes) ||
		!isNonNegativeInteger(metrics.omittedBytes) ||
		!isNonNegativeInteger(metrics.dependencyExclusions)
	) {
		return null;
	}
	const body: StoredCaptureRecordBody = {
		schemaVersion: SPOOL_SCHEMA_VERSION,
		artifactKind: value.artifactKind,
		captureId: value.captureId,
		contentHash: value.contentHash,
		captureLifecycle: value.captureLifecycle,
		capturedAt: value.capturedAt,
		parentCaptureId: value.parentCaptureId,
		baseGitCommit: value.baseGitCommit,
		repositoryName: value.repositoryName,
		repositoryKey: value.repositoryKey,
		binding: value.binding,
		manifest: value.manifest,
		materializedBlobIds: value.materializedBlobIds,
		referencedBlobIds: value.referencedBlobIds,
		externalObjectIds: value.externalObjectIds,
		sourceObjects: value.sourceObjects,
		metrics: {
			inventoryBytes: metrics.inventoryBytes,
			materializedBytes: metrics.materializedBytes,
			uploadCandidateBytes: metrics.uploadCandidateBytes,
			newlyMaterializedBytes: metrics.newlyMaterializedBytes,
			reusedBytes: metrics.reusedBytes,
			gitObjectBytes: metrics.gitObjectBytes,
			omittedBytes: metrics.omittedBytes,
			dependencyExclusions: metrics.dependencyExclusions,
		},
	};
	return { ...body, recordHash: value.recordHash };
}

function serializeRecord(record: StoredCaptureRecord): string {
	return `${JSON.stringify(record)}\n`;
}

function hashRecordBody(body: StoredCaptureRecordBody): string {
	return sha256(JSON.stringify(body));
}

function toRecordBody(record: StoredCaptureRecord): StoredCaptureRecordBody {
	return {
		schemaVersion: record.schemaVersion,
		artifactKind: record.artifactKind,
		captureId: record.captureId,
		contentHash: record.contentHash,
		captureLifecycle: record.captureLifecycle,
		capturedAt: record.capturedAt,
		parentCaptureId: record.parentCaptureId,
		baseGitCommit: record.baseGitCommit,
		repositoryName: record.repositoryName,
		repositoryKey: record.repositoryKey,
		binding: record.binding,
		manifest: record.manifest,
		materializedBlobIds: record.materializedBlobIds,
		referencedBlobIds: record.referencedBlobIds,
		externalObjectIds: record.externalObjectIds,
		sourceObjects: record.sourceObjects,
		metrics: record.metrics,
	};
}

function toCaptureSummary(
	record: StoredCaptureRecord,
	storedBytes: number,
	integrityError: string | null,
): RepositorySpoolCaptureSummary {
	return {
		artifactKind: record.artifactKind,
		captureId: record.captureId,
		contentHash: record.contentHash,
		captureLifecycle: record.captureLifecycle,
		capturedAt: record.capturedAt,
		parentCaptureId: record.parentCaptureId,
		baseGitCommit: record.baseGitCommit,
		repositoryName: record.repositoryName,
		inventoryBytes: record.metrics.inventoryBytes,
		materializedBytes: record.metrics.materializedBytes,
		uploadCandidateBytes: record.metrics.uploadCandidateBytes,
		newlyMaterializedBytes: record.metrics.newlyMaterializedBytes,
		reusedBytes: record.metrics.reusedBytes,
		gitObjectBytes: record.metrics.gitObjectBytes,
		omittedBytes: record.metrics.omittedBytes,
		dependencyExclusions: record.metrics.dependencyExclusions,
		storedBytes,
		referencedBlobCount: record.referencedBlobIds.length,
		materializedBlobCount: record.materializedBlobIds.length,
		selfContained: record.externalObjectIds.length === 0,
		integrity: integrityError === null ? "valid" : "corrupt",
		integrityError,
	};
}

function corruptSummary(
	path: string,
	storedBytes: number,
	error: string,
): RepositorySpoolCaptureSummary {
	return {
		artifactKind: "local-context",
		captureId: `unknown:${basename(path)}`,
		contentHash: "unknown",
		captureLifecycle: "manual",
		capturedAt: "unknown",
		parentCaptureId: null,
		baseGitCommit: null,
		repositoryName: "unknown",
		inventoryBytes: 0,
		materializedBytes: 0,
		uploadCandidateBytes: 0,
		newlyMaterializedBytes: 0,
		reusedBytes: 0,
		gitObjectBytes: 0,
		omittedBytes: 0,
		dependencyExclusions: 0,
		storedBytes,
		referencedBlobCount: 0,
		materializedBlobCount: 0,
		selfContained: false,
		integrity: "corrupt",
		integrityError: error,
	};
}

function normalizeEndpoint(value: string | null): string | null {
	if (value === null) return null;
	try {
		const url = new URL(value);
		url.username = "";
		url.password = "";
		url.search = "";
		url.hash = "";
		return url.toString().replace(/\/+$/u, "");
	} catch {
		return value.replace(/\/+$/u, "");
	}
}

function hashOptionalIdentity(
	kind: string,
	value: string | null,
): string | null {
	return value === null ? null : hashIdentity(kind, value);
}

function hashIdentity(kind: string, value: string): string {
	return sha256(`${kind}\u0000${value}`);
}

function sha256(value: string | Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

function blobDigest(blobId: string): string {
	const match = SHA256_BLOB_ID.exec(blobId);
	if (!match?.[1]) {
		throw new RepositorySpoolCorruptionError(
			`Unsupported repository blob ID: ${blobId}`,
		);
	}
	return match[1];
}

function isRepositorySpoolBinding(
	value: unknown,
): value is RepositorySpoolBinding {
	if (!isRecord(value)) return false;
	return (
		isNullableString(value.endpointKey) &&
		isNullableString(value.accountKey) &&
		typeof value.installationKey === "string" &&
		isNullableString(value.workspaceKey) &&
		typeof value.repositoryKey === "string" &&
		typeof value.worktreeKey === "string"
	);
}

function isCaptureLifecycle(
	value: unknown,
): value is RepositoryCaptureLifecycle {
	return (
		value === "start" ||
		value === "resume" ||
		value === "checkpoint" ||
		value === "end" ||
		value === "manual"
	);
}

function isStringArray(value: unknown): value is readonly string[] {
	return (
		Array.isArray(value) && value.every((item) => typeof item === "string")
	);
}

function isSourceObjects(
	value: unknown,
): value is readonly RepositorySpoolSourceObject[] {
	return (
		Array.isArray(value) &&
		value.every(
			(item) =>
				isRecord(item) &&
				typeof item.id === "string" &&
				isNullableString(item.blobId),
		)
	);
}

function normalizeSourceObjects(
	values: readonly RepositorySpoolSourceObject[],
): readonly RepositorySpoolSourceObject[] {
	const byId = new Map<string, string | null>();
	for (const value of values) byId.set(value.id, value.blobId);
	return [...byId.entries()]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([id, blobId]) => ({ id, blobId }));
}

function isNullableString(value: unknown): value is string | null {
	return value === null || typeof value === "string";
}

function isNonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isErrorCode(error: unknown, code: string): boolean {
	return isRecord(error) && error.code === code;
}
