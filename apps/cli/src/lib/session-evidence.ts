import { spawn } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
	INGEST_AGGREGATE_CONTENT_MAX_BYTES,
	type IngestSessionInput,
	type RepositoryEvidenceCommitOutput,
} from "../contracts/index.js";
import type {
	FileBackedUploadRequest,
	FileBackedUploadSubagentDiscovery,
} from "../internal/agent-adapters/index.js";
import { getRedactionBudgetAnomaly } from "../internal/secret-filter/index.js";
import { getApiBaseOverride } from "./api-target.js";
import {
	isRepositoryAutoUploadAllowed,
	loadAutoUploadConfig,
} from "./auto-upload-config.js";
import type { Credentials } from "./credentials.js";
import { type FileLease, tryAcquireFileLease } from "./file-lease.js";
import {
	cleanupStagedUpload,
	createFilteredUploadSources,
	stageFilteredUpload,
} from "./filtered-upload-staging.js";
import { getGitInfo } from "./git-info.js";
import { getConfigDir } from "./local-state.js";
import { collectSessionRepositoryContext } from "./repo-context.js";
import {
	createRepositorySpoolBinding,
	createRepositorySpoolEnv,
	markRepositorySpoolCaptureAbandoned,
	markRepositorySpoolCaptureAccepted,
	removeRepositorySpoolCapture,
} from "./repo-spool.js";
import {
	getLegacyRepositoryKey,
	resolveUploadRepositoryIdentity,
} from "./repository-discovery.js";
import {
	isEvidenceCaptureDisabledError,
	pauseRepositoryEvidenceCapture,
	readRepositoryEvidencePauseUntil,
} from "./repository-evidence-pause.js";
import {
	acquirePendingRepositoryEvidenceLease,
	deferPendingRepositoryEvidence,
	getRepositoryEvidenceLeaseDirectory,
	hasPendingRepositoryEvidence,
	normalizeRepositoryEvidenceEndpoint,
	type PendingRepositoryEvidence,
	readPendingRepositoryEvidence,
	removePendingRepositoryEvidence,
	supersedePendingRepositoryEvidence,
	writePendingRepositoryEvidence,
} from "./repository-evidence-pending.js";
import {
	buildRepositoryEvidenceUpload,
	getTranscriptDeliveryBudget,
	isRetryableRepositoryEvidenceError,
	requireRepositoryEvidenceApiKey,
	uploadRepositoryEvidence,
} from "./repository-evidence-upload.js";
import {
	buildSessionAttribution,
	type SessionAttributionHookKind,
	type SessionAttributionSourceStream,
} from "./session-attribution.js";
import {
	continueAcceptedTranscript,
	persistTranscriptSource,
	transcriptSourcePath,
} from "./transcript-continuation.js";
import { planTranscriptRevisionFile } from "./transcript-revision.js";
import {
	advanceTranscriptRevision,
	readTranscriptRevision,
	type TranscriptRevisionDeliveryScope,
} from "./transcript-revision-store.js";
import { extractObservedSkills } from "./transcript-skills.js";
import { allowsInsecureEndpointFromEnv } from "./upload-endpoint.js";

type EvidenceLifecycle = "start" | "resume" | "checkpoint" | "end";

// Collecting the repository context and staging the transcript, up to the
// point where the capture is spooled as a pending item.
const EVIDENCE_CAPTURE_BUDGET_MS = 45_000;
// Delivery inside the hook. Whatever is not delivered by then stays spooled
// and is delivered by a detached background process.
const EVIDENCE_INLINE_DELIVERY_BUDGET_MS = 30_000;
export const EVIDENCE_BACKGROUND_DELIVERY_BUDGET_MS = 15 * 60_000;
const EVIDENCE_BACKGROUND_MAX_ITEMS = 200;
// Per item in the background: one minute plus 256 KiB/s of evidence bytes.
const EVIDENCE_BACKGROUND_ITEM_BASE_MS = 60_000;
const EVIDENCE_BACKGROUND_ITEM_BYTES_PER_SECOND = 256 * 1024;
export const EVIDENCE_TRANSCRIPT_INPUT_MAX_BYTES =
	INGEST_AGGREGATE_CONTENT_MAX_BYTES;

export class EvidenceBudgetError extends Error {
	constructor(readonly phase: "capture" | "delivery") {
		super(
			phase === "capture"
				? `Repository evidence capture exceeded its ${EVIDENCE_CAPTURE_BUDGET_MS}ms budget.`
				: "Repository evidence delivery reached its time budget; the capture stays spooled and is delivered in the background.",
		);
		this.name = "EvidenceBudgetError";
	}
}

export async function captureAndUploadSessionEvidence(input: {
	readonly credentials: Credentials;
	readonly lifecycle: EvidenceLifecycle;
	readonly hookReceivedAt: string;
	readonly onWarning?: (message: string) => void;
	readonly organizationId: string;
	readonly request: IngestSessionInput | FileBackedUploadRequest;
	readonly requestMaterializedAt?: {
		readonly completedAt: string;
		readonly startedAt: string;
	};
	readonly terminalTranscript: boolean;
}): Promise<
	{ readonly contextId: string; readonly receiptId: string } | undefined
> {
	if (readRepositoryEvidencePauseUntil() !== undefined) return undefined;
	const captureDeadlineAt = Date.now() + EVIDENCE_CAPTURE_BUDGET_MS;
	const user = input.credentials.user;
	if (!user) {
		throw new Error("Repository evidence requires an authenticated CLI user.");
	}
	requireRepositoryEvidenceApiKey(input.credentials.authType);
	const configDir = getConfigDir();
	const apiBase = getApiBaseOverride() ?? input.credentials.apiBaseUrl;
	const endpoint = normalizeRepositoryEvidenceEndpoint(`${apiBase}/rpc`);
	// An older pending capture of this session never blocks a new one: the new
	// capture is spooled and delivered first, older items are retried after it.
	const materialized = await materializeEvidenceRequest(
		input.request,
		input.requestMaterializedAt,
		configDir,
		captureDeadlineAt,
	);
	const request = materialized.request;
	const sourceId = materialized.sourceId;
	let hasPending = false;
	let contextCapture:
		| Awaited<ReturnType<typeof collectSessionRepositoryContext>>
		| undefined;
	try {
		contextCapture = await collectSessionRepositoryContext({
			accountId: user.id,
			endpoint,
			lifecycle: input.lifecycle,
			organizationId: input.organizationId,
			repositoryPath: request.projectPath,
			deadlineAt: captureDeadlineAt,
			observedSkillNames: extractObservedSkills(request),
		});
		const scope = {
			actorId: user.id,
			provider: request.source,
			providerInstanceId: contextCapture.context.localIdentity.installationId,
			sessionId: request.sessionId,
		} as const;
		const deliveryScope: TranscriptRevisionDeliveryScope = {
			endpoint,
			organizationId: input.organizationId,
			transcriptScope: scope,
		};
		const previous = await readTranscriptRevision(deliveryScope);
		const gitInfo = await getGitInfo(request.projectPath);
		const repository = resolveUploadRepositoryIdentity(
			request.projectPath,
			gitInfo,
		);
		assertCaptureBudget(captureDeadlineAt);
		const transcriptRevision = await planTranscriptRevisionFile({
			path: transcriptSourcePath(configDir, sourceId),
			limits: {
				maxDeliveryBytes: getTranscriptDeliveryBudget(contextCapture.bundle),
			},
			previous,
			scope,
			terminal: input.terminalTranscript,
		});
		const firstActionAt = findFirstTranscriptTimestamp(request.content);
		const timing = getFirstActionTiming(
			input.lifecycle,
			firstActionAt,
			contextCapture.bundle.manifest.completedAt,
		);
		const attribution = buildSessionAttribution({
			captureId: contextCapture.bundle.manifest.captureId,
			childDiscovery: materialized.childDiscovery,
			hook: {
				kind: getAttributionHookKind(input.lifecycle, request.source),
				nativeBeforeActionBoundary:
					input.lifecycle === "start" && request.source === "claude_code",
				receivedAt: input.hookReceivedAt,
			},
			opalineSessionId: request.sessionId,
			source: request.source,
			streams: materialized.streams,
			terminal: input.terminalTranscript,
			transcriptRevision: transcriptRevision.manifest,
		});
		const upload = buildRepositoryEvidenceUpload({
			attribution,
			bundle: contextCapture.bundle,
			captureLifecycle: input.lifecycle,
			context: contextCapture.context,
			firstActionAt: timing.firstActionAt,
			firstActionBasis: timing.firstActionBasis,
			firstActionRelationship: timing.firstActionRelationship,
			organizationId: input.organizationId,
			session: request,
			terminalTranscript: input.terminalTranscript,
			transcriptLastEventAt: attribution.streams[0]?.prefix.lastEventAt ?? null,
			transcriptRevision,
		});
		const currentPending: PendingRepositoryEvidence = {
			repositorySelection: {
				repoKey: repository.repoKey,
				legacyKeys: [getLegacyRepositoryKey(request.projectPath, gitInfo)],
				source: request.source,
			},
			continuation: { sourceId, terminal: input.terminalTranscript },
			endpoint,
			transcriptRevision: transcriptRevision.manifest,
			upload,
		};
		if (transcriptRevision.delivery.status !== "complete") {
			input.onWarning?.(
				transcriptRevision.delivery.status === "deferred"
					? `Transcript evidence for session ${request.sessionId} exceeds one delivery; ${transcriptRevision.delivery.remainingBytes} bytes remain for upload --retry.`
					: `Transcript evidence for session ${request.sessionId} is blocked by a ${transcriptRevision.delivery.recordBytes}-byte record that exceeds the delivery limit.`,
			);
		}
		assertCaptureBudget(captureDeadlineAt);
		// Spool first: from here on the capture survives a timeout, a crash or a
		// killed hook and is delivered by a later hook or the background process.
		await writePendingRepositoryEvidence(currentPending, configDir);
		hasPending = true;
		await supersedePendingRepositoryEvidence(
			currentPending,
			configDir,
			(warning) => input.onWarning?.(warning.message),
		);
		const deliveryDeadlineAt = Date.now() + EVIDENCE_INLINE_DELIVERY_BUDGET_MS;
		const outcome = await deliverPendingRepositoryEvidence(
			currentPending,
			input.credentials,
			configDir,
			{
				backoffOnBudget: false,
				deadlineAt: deliveryDeadlineAt,
				onWarning: input.onWarning,
			},
		);
		let pendingError: unknown;
		if (outcome.status === "delivered") {
			try {
				pendingError = await retryOnePendingRepositoryEvidence(
					input.credentials,
					user.id,
					endpoint,
					configDir,
					deliveryDeadlineAt,
					input.onWarning,
				);
			} catch (error) {
				pendingError = error;
			}
		}
		await scheduleBackgroundEvidenceDelivery(
			user.id,
			endpoint,
			configDir,
			input.onWarning,
		);
		switch (outcome.status) {
			case "delivered":
				if (pendingError !== undefined) throw pendingError;
				return {
					contextId: outcome.receipt.contextId,
					receiptId: outcome.receipt.receiptId,
				};
			case "deferred":
				throw outcome.error;
			case "paused":
			case "busy":
			case "skipped":
				return undefined;
		}
	} catch (error) {
		if (isEvidenceCaptureDisabledError(error)) {
			await handleDisabledCapture(error, undefined, configDir, input.onWarning);
			return undefined;
		}
		throw error;
	} finally {
		if (!hasPending) {
			await rm(transcriptSourcePath(configDir, sourceId), { force: true });
			if (contextCapture) {
				await markRepositorySpoolCaptureAbandoned(
					contextCapture.context.binding,
					contextCapture.stored.capture.captureId,
					"local-context",
					contextCapture.context.spoolEnv,
				);
			}
		}
	}
}

/**
 * Delivers spooled captures in a detached process after the hook has
 * returned, so a slow network or a large transcript never costs a capture.
 * One background deliverer runs at a time per configuration directory.
 */
export async function deliverPendingSessionEvidenceInBackground(
	credentials: Credentials,
	options: {
		readonly budgetMs?: number;
		readonly onWarning?: (message: string) => void;
	} = {},
): Promise<BackgroundDeliveryResult> {
	const result = {
		alreadyRunning: false,
		busy: 0,
		deferred: 0,
		delivered: 0,
		skipped: 0,
	};
	if (readRepositoryEvidencePauseUntil() !== undefined) return result;
	if (!credentials.user) {
		throw new Error("Repository evidence requires an authenticated CLI user.");
	}
	requireRepositoryEvidenceApiKey(credentials.authType);
	const configDir = getConfigDir();
	const endpoint = normalizeRepositoryEvidenceEndpoint(
		`${getApiBaseOverride() ?? credentials.apiBaseUrl}/rpc`,
	);
	const worker = await waitForBackgroundDeliveryLease(configDir);
	if (worker === null) return { ...result, alreadyRunning: true };
	try {
		const deadlineAt =
			Date.now() + (options.budgetMs ?? EVIDENCE_BACKGROUND_DELIVERY_BUDGET_MS);
		const attempted = new Set<string>();
		for (
			let index = 0;
			index < EVIDENCE_BACKGROUND_MAX_ITEMS && Date.now() < deadlineAt;
			index += 1
		) {
			if (readRepositoryEvidencePauseUntil(configDir) !== undefined) break;
			const [pending] = await readPendingRepositoryEvidence(configDir, {
				actorId: credentials.user.id,
				endpoint,
				excludeOperationIds: attempted,
				maxItems: 1,
				isEligible: (candidate) =>
					(candidate.next_attempt_at ?? 0) <= Date.now() &&
					isPendingRepositoryEvidenceAutoUploadAllowed(candidate, configDir),
				onError: (error) =>
					options.onWarning?.(
						error instanceof Error ? error.message : String(error),
					),
				onWarning: (warning) => options.onWarning?.(warning.message),
			});
			if (!pending) break;
			attempted.add(pending.upload.input.operationId);
			const outcome = await deliverPendingRepositoryEvidence(
				pending,
				credentials,
				configDir,
				{
					backoffOnBudget: true,
					canUpload: () =>
						isPendingRepositoryEvidenceAutoUploadAllowed(pending, configDir),
					deadlineAt: Math.min(
						deadlineAt,
						Date.now() + getBackgroundItemBudgetMs(pending),
					),
					onWarning: options.onWarning,
				},
			);
			if (outcome.status === "delivered") result.delivered += 1;
			if (outcome.status === "busy") result.busy += 1;
			if (outcome.status === "skipped") result.skipped += 1;
			if (outcome.status === "deferred") {
				result.deferred += 1;
				options.onWarning?.(
					`Repository evidence ${pending.upload.input.capture.contextId} deferred: ${getErrorMessage(outcome.error)}`,
				);
			}
			if (outcome.status === "paused") break;
		}
		return result;
	} finally {
		await worker.release();
	}
}

export interface BackgroundDeliveryResult {
	readonly alreadyRunning: boolean;
	readonly busy: number;
	readonly deferred: number;
	readonly delivered: number;
	readonly skipped: number;
}

export async function retryPendingSessionEvidence(
	credentials: Credentials,
	options: {
		readonly allowInsecureEndpoint?: boolean;
		readonly endpoint?: string;
		readonly maxItems?: number;
		readonly onWarning?: (message: string) => void;
	} = {},
): Promise<number> {
	if (readRepositoryEvidencePauseUntil() !== undefined) return 0;
	if (!credentials.user) {
		throw new Error("Repository evidence requires an authenticated CLI user.");
	}
	requireRepositoryEvidenceApiKey(credentials.authType);
	const configDir = getConfigDir();
	const requestedEndpoint = normalizeRepositoryEvidenceEndpoint(
		options.endpoint ?? `${getApiBaseOverride() ?? credentials.apiBaseUrl}/rpc`,
	);
	let completed = 0;
	const failures: unknown[] = [];
	const maxItems = options.maxItems ?? 25;
	const attemptedOperationIds = new Set<string>();
	for (let attempted = 0; attempted < maxItems; attempted++) {
		if (readRepositoryEvidencePauseUntil(configDir) !== undefined) break;
		const readErrors: unknown[] = [];
		const [pending] = await readPendingRepositoryEvidence(configDir, {
			actorId: credentials.user.id,
			endpoint: requestedEndpoint,
			excludeOperationIds: attemptedOperationIds,
			maxItems: 1,
			onError: (error) => readErrors.push(error),
			onWarning: (warning) => options.onWarning?.(warning.message),
		});
		failures.push(...readErrors);
		if (!pending) {
			if (readErrors.length > 0) continue;
			break;
		}
		attemptedOperationIds.add(pending.upload.input.operationId);
		const outcome = await deliverPendingRepositoryEvidence(
			pending,
			credentials,
			configDir,
			{
				allowInsecureEndpoint: options.allowInsecureEndpoint,
				backoffOnBudget: true,
				deadlineAt: undefined,
				onWarning: options.onWarning,
			},
		);
		if (outcome.status === "delivered") completed++;
		if (outcome.status === "deferred") failures.push(outcome.error);
		if (outcome.status === "busy")
			options.onWarning?.(
				`Repository evidence ${pending.upload.input.capture.contextId} is being delivered by another Opaline process.`,
			);
		if (outcome.status === "paused") break;
	}
	if (failures.length > 0) {
		throw new AggregateError(
			failures,
			`${failures.length} pending repository evidence capture(s) remain.`,
		);
	}
	return completed;
}

async function retryOnePendingRepositoryEvidence(
	credentials: Credentials,
	actorId: string,
	endpoint: string,
	configDir: string,
	deadlineAt: number,
	onWarning: ((message: string) => void) | undefined,
): Promise<unknown | undefined> {
	if (
		Date.now() >= deadlineAt ||
		readRepositoryEvidencePauseUntil(configDir) !== undefined
	)
		return undefined;
	const failures: unknown[] = [];
	for (const pending of await readPendingRepositoryEvidence(configDir, {
		actorId,
		endpoint,
		maxItems: 1,
		isEligible: (pending) =>
			(pending.next_attempt_at ?? 0) <= Date.now() &&
			isPendingRepositoryEvidenceAutoUploadAllowed(pending, configDir),
		onError: (error) => failures.push(error),
		onWarning: (warning) => onWarning?.(warning.message),
	})) {
		const outcome = await deliverPendingRepositoryEvidence(
			pending,
			credentials,
			configDir,
			{
				backoffOnBudget: false,
				canUpload: () =>
					isPendingRepositoryEvidenceAutoUploadAllowed(pending, configDir),
				deadlineAt,
				onWarning,
			},
		);
		if (
			outcome.status === "deferred" &&
			!(outcome.error instanceof EvidenceBudgetError)
		)
			failures.push(outcome.error);
	}
	return failures[0];
}

type DeliveryOutcome =
	| {
			readonly status: "delivered";
			readonly receipt: RepositoryEvidenceCommitOutput;
	  }
	| { readonly status: "deferred"; readonly error: unknown }
	| { readonly status: "busy" }
	| { readonly status: "paused" }
	| { readonly status: "skipped" };

/**
 * Delivers one spooled capture under its exclusive lease. Retryable and
 * permanent failures keep the item with backoff. A delivery cut by its time
 * budget keeps the item due for the background deliverer unless
 * `backoffOnBudget` is set (the background deliverer itself backs off so an
 * item that cannot finish in its budget does not loop).
 */
async function deliverPendingRepositoryEvidence(
	pending: PendingRepositoryEvidence,
	credentials: Credentials,
	configDir: string,
	options: {
		readonly allowInsecureEndpoint?: boolean;
		readonly backoffOnBudget: boolean;
		readonly canUpload?: () => boolean;
		readonly deadlineAt: number | undefined;
		readonly onWarning: ((message: string) => void) | undefined;
	},
): Promise<DeliveryOutcome> {
	const lease = await acquirePendingRepositoryEvidenceLease(pending, configDir);
	if (lease === null) return { status: "busy" };
	try {
		// Another process may have delivered or superseded the item between our
		// read and the lease.
		if (!(await hasPendingRepositoryEvidence(pending, configDir)))
			return { status: "busy" };
		const receipt = await uploadWithBoundedRetries(
			pending.upload,
			credentials,
			{
				allowInsecureEndpoint: options.allowInsecureEndpoint,
				canUpload: options.canUpload,
				deadlineAt: options.deadlineAt,
				endpoint: pending.endpoint,
			},
		);
		await markPendingRepositoryCaptureAccepted(pending, configDir);
		await advanceTranscriptRevision(
			pending.transcriptRevision,
			getPendingDeliveryScope(pending),
			configDir,
		);
		await continueAcceptedTranscript(pending, configDir);
		return { status: "delivered", receipt };
	} catch (error) {
		if (isEvidenceCaptureDisabledError(error)) {
			await handleDisabledCapture(error, pending, configDir, options.onWarning);
			return { status: "paused" };
		}
		if (error instanceof RepositoryAutoUploadDisabledError)
			return { status: "skipped" };
		if (!(error instanceof EvidenceBudgetError) || options.backoffOnBudget)
			await deferPendingRepositoryEvidence(pending, configDir);
		return { status: "deferred", error };
	} finally {
		await lease.release();
	}
}

/**
 * Starts the detached background deliverer when spooled captures are due.
 * It is a separate process so the host agent's hook timeout cannot cut it.
 */
async function scheduleBackgroundEvidenceDelivery(
	actorId: string,
	endpoint: string,
	configDir: string,
	onWarning: ((message: string) => void) | undefined,
): Promise<boolean> {
	if (readRepositoryEvidencePauseUntil(configDir) !== undefined) return false;
	const [due] = await readPendingRepositoryEvidence(configDir, {
		actorId,
		endpoint,
		maxItems: 1,
		isEligible: (pending) =>
			(pending.next_attempt_at ?? 0) <= Date.now() &&
			isPendingRepositoryEvidenceAutoUploadAllowed(pending, configDir),
		onError: () => undefined,
	});
	if (!due) return false;
	try {
		spawnBackgroundEvidenceDelivery();
		return true;
	} catch (error) {
		onWarning?.(
			`Could not start background repository evidence delivery: ${getErrorMessage(error)}`,
		);
		return false;
	}
}

function spawnBackgroundEvidenceDelivery(): void {
	const entrypoint = process.argv[1];
	if (!entrypoint) throw new Error("The CLI entrypoint is unknown.");
	// Windows does not end children with their parent, and DETACHED_PROCESS
	// interferes with console-less launches; POSIX detaches into its own group.
	const child = spawn(
		process.execPath,
		[...process.execArgv, entrypoint, "hooks", "evidence-deliver"],
		{
			detached: process.platform !== "win32",
			env: process.env,
			stdio: "ignore",
			windowsHide: true,
		},
	);
	child.on("error", () => undefined);
	child.unref();
}

async function waitForBackgroundDeliveryLease(
	configDir: string,
): Promise<FileLease | null> {
	const path = join(
		getRepositoryEvidenceLeaseDirectory(configDir),
		"background-delivery.lease",
	);
	// A deliverer that is just finishing may still hold the lease; wait for it
	// briefly so items spooled meanwhile are not left until the next hook.
	// Elapsed time uses the monotonic clock (tests may freeze Date.now).
	const waitUntil = performance.now() + 10_000;
	while (true) {
		const lease = await tryAcquireFileLease(path);
		if (lease !== null || performance.now() >= waitUntil) return lease;
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
}

function getBackgroundItemBudgetMs(pending: PendingRepositoryEvidence): number {
	const bytes = [...pending.upload.objects.values()].reduce(
		(total, object) => total + object.bytes.byteLength,
		0,
	);
	return (
		EVIDENCE_BACKGROUND_ITEM_BASE_MS +
		Math.ceil((bytes / EVIDENCE_BACKGROUND_ITEM_BYTES_PER_SECOND) * 1000)
	);
}

class RepositoryAutoUploadDisabledError extends Error {
	constructor() {
		super("Automatic retry skipped because repository uploads are OFF.");
	}
}

export function isPendingRepositoryEvidenceAutoUploadAllowed(
	pending: Awaited<ReturnType<typeof readPendingRepositoryEvidence>>[number],
	configDir: string,
): boolean {
	const selection = pending.repositorySelection;
	if (!selection) return loadAutoUploadConfig(configDir) === null;
	return isRepositoryAutoUploadAllowed(
		selection.repoKey,
		selection.source,
		selection.legacyKeys,
		configDir,
	);
}

async function markPendingRepositoryCaptureAccepted(
	pending: Awaited<ReturnType<typeof readPendingRepositoryEvidence>>[number],
	configDir: string,
): Promise<void> {
	const binding = await createRepositorySpoolBinding({
		accountId: pending.transcriptRevision.scope.actorId,
		apiBaseUrl: pending.endpoint,
		localIdentity: pending.upload.input.repository.local,
		workspaceId: pending.upload.input.organizationId,
	});
	await markRepositorySpoolCaptureAccepted(
		binding,
		pending.upload.input.capture.contextId,
		"local-context",
		createRepositorySpoolEnv(configDir),
	);
}

async function handleDisabledCapture(
	error: Parameters<typeof pauseRepositoryEvidenceCapture>[0],
	pending: PendingRepositoryEvidence | undefined,
	configDir: string,
	onWarning: ((message: string) => void) | undefined,
): Promise<void> {
	try {
		await pauseRepositoryEvidenceCapture(error, configDir);
	} catch (persistenceError) {
		onWarning?.(
			`Could not persist repository evidence pause: ${String(persistenceError)}`,
		);
	} finally {
		if (pending) {
			const cleanups = [
				() => removePendingRepositoryEvidence(pending, configDir),
				async () => {
					if (pending.continuation)
						await rm(
							transcriptSourcePath(configDir, pending.continuation.sourceId),
							{ force: true },
						);
				},
				async () => {
					const binding = await createRepositorySpoolBinding({
						accountId: pending.transcriptRevision.scope.actorId,
						apiBaseUrl: pending.endpoint,
						localIdentity: pending.upload.input.repository.local,
						workspaceId: pending.upload.input.organizationId,
					});
					await removeRepositorySpoolCapture(
						binding,
						pending.upload.input.capture.contextId,
						createRepositorySpoolEnv(configDir),
					);
				},
			];
			for (const cleanup of cleanups) {
				try {
					await cleanup();
				} catch (cleanupError) {
					onWarning?.(
						`Could not discard disabled repository evidence capture: ${String(cleanupError)}`,
					);
				}
			}
		}
	}
}

async function uploadWithBoundedRetries(
	upload: ReturnType<typeof buildRepositoryEvidenceUpload>,
	credentials: Credentials,
	overrides: {
		readonly allowInsecureEndpoint?: boolean;
		readonly deadlineAt?: number;
		readonly endpoint?: string;
		readonly canUpload?: () => boolean;
	} = {},
) {
	const apiBase = getApiBaseOverride() ?? credentials.apiBaseUrl;
	const config = {
		allowInsecureEndpoint:
			overrides.allowInsecureEndpoint ?? allowsInsecureEndpointFromEnv(),
		authType: credentials.authType,
		endpoint: overrides.endpoint ?? `${apiBase}/rpc`,
		token: credentials.token,
	};
	let lastError: unknown;
	for (let attempt = 1; attempt <= 3; attempt++) {
		if (overrides.canUpload && !overrides.canUpload())
			throw new RepositoryAutoUploadDisabledError();
		const remainingMs =
			overrides.deadlineAt === undefined
				? undefined
				: overrides.deadlineAt - Date.now();
		if (remainingMs !== undefined && remainingMs <= 0) {
			throw new EvidenceBudgetError("delivery");
		}
		try {
			return await uploadRepositoryEvidence(upload, {
				...config,
				operationTimeoutMs: remainingMs,
			});
		} catch (error) {
			lastError = error;
			if (isEvidenceCaptureDisabledError(error)) throw error;
			// A request aborted by the operation deadline is a budget cut, not a
			// server failure.
			if (
				overrides.deadlineAt !== undefined &&
				Date.now() >= overrides.deadlineAt
			)
				throw new EvidenceBudgetError("delivery");
			if (!isRetryableRepositoryEvidenceError(error) || attempt === 3) break;
			const retryDelayMs =
				overrides.deadlineAt === undefined
					? attempt * 100
					: Math.min(attempt * 100, overrides.deadlineAt - Date.now());
			if (retryDelayMs <= 0) throw new EvidenceBudgetError("delivery");
			await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
		}
	}
	throw lastError;
}

function getPendingDeliveryScope(
	pending: Awaited<ReturnType<typeof readPendingRepositoryEvidence>>[number],
): TranscriptRevisionDeliveryScope {
	return {
		endpoint: pending.endpoint,
		organizationId: pending.upload.input.organizationId,
		transcriptScope: pending.transcriptRevision.scope,
	};
}

async function materializeEvidenceRequest(
	request: IngestSessionInput | FileBackedUploadRequest,
	requestMaterializedAt:
		| { readonly completedAt: string; readonly startedAt: string }
		| undefined,
	configDir: string,
	deadlineAt: number,
): Promise<{
	readonly childDiscovery: FileBackedUploadSubagentDiscovery;
	readonly request: IngestSessionInput;
	readonly streams: readonly SessionAttributionSourceStream[];
	readonly sourceId: string;
}> {
	const startedAt = new Date().toISOString();
	if ((request.subagents?.length ?? 0) >= 256)
		throw new Error("Transcript capture exceeded its source-count budget.");
	const staged = await stageFilteredUpload(
		createFilteredUploadSources(request),
		{
			deadlineAt,
			maxInputBytes: EVIDENCE_TRANSCRIPT_INPUT_MAX_BYTES,
			includeEmptySubagents: true,
		},
	);
	try {
		const anomaly = getRedactionBudgetAnomaly(
			staged.redactedBytes,
			staged.inputBytes,
			staged.redactions,
		);
		if (anomaly)
			throw new Error(
				`Transcript redaction exceeded the safety budget for rules: ${anomaly.ruleIds.join(", ")}`,
			);
		if (staged.aggregateBytes > EVIDENCE_TRANSCRIPT_INPUT_MAX_BYTES)
			throw new Error(
				"Filtered transcript evidence exceeded its materialization budget.",
			);
		const streams: SessionAttributionSourceStream[] = [];
		for (const object of staged.objects) {
			assertCaptureBudget(deadlineAt);
			streams.push({
				content: await readFile(object.path, {
					encoding: "utf8",
					signal: AbortSignal.timeout(Math.max(1, deadlineAt - Date.now())),
				}),
				declaredAgentId: object.kind === "main" ? null : object.agentId,
				materializedAt: requestMaterializedAt ?? {
					startedAt,
					completedAt: new Date().toISOString(),
				},
				role: object.kind === "main" ? "root" : "child",
			});
		}
		assertCaptureBudget(deadlineAt);
		const main = staged.objects[0];
		if (!main) throw new Error("Missing filtered root transcript.");
		const sourceId = await persistTranscriptSource(
			{ path: main.path },
			configDir,
			deadlineAt,
		);
		return {
			childDiscovery: isFileBackedEvidenceRequest(request)
				? request.subagentDiscovery
				: {
						omittedCount: null,
						reason:
							"In-memory hook input did not include a child stream directory",
						status: "unavailable",
					},
			request: {
				...staged.metadata,
				content: streams[0]?.content ?? "",
				subagents:
					streams.length > 1
						? streams.slice(1).map((stream) => ({
								agentId: stream.declaredAgentId ?? "",
								content: stream.content,
							}))
						: undefined,
			},
			streams,
			sourceId,
		};
	} finally {
		await cleanupStagedUpload(staged);
	}
}

function assertCaptureBudget(deadlineAt: number): void {
	if (Date.now() >= deadlineAt) throw new EvidenceBudgetError("capture");
}

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function getAttributionHookKind(
	lifecycle: EvidenceLifecycle,
	source: IngestSessionInput["source"],
): SessionAttributionHookKind {
	if (source === "codex") return "codex-agent-turn-complete";
	return lifecycle === "start" ? "claude-session-start" : "claude-session-end";
}

function isFileBackedEvidenceRequest(
	request: IngestSessionInput | FileBackedUploadRequest,
): request is FileBackedUploadRequest {
	return "kind" in request && request.kind === "file";
}

function getFirstActionTiming(
	lifecycle: EvidenceLifecycle,
	firstActionAt: string | null,
	captureCompletedAt: string,
) {
	if (lifecycle === "start") {
		return {
			firstActionAt: null,
			firstActionBasis: "native-hook" as const,
			firstActionRelationship: "before-first-action" as const,
		};
	}
	if (
		firstActionAt !== null &&
		Date.parse(captureCompletedAt) >= Date.parse(firstActionAt)
	) {
		return {
			firstActionAt,
			firstActionBasis: "transcript-watermark" as const,
			firstActionRelationship: "after-first-action" as const,
		};
	}
	return {
		firstActionAt: null,
		firstActionBasis: "unavailable" as const,
		firstActionRelationship: "unknown" as const,
	};
}

function findFirstTranscriptTimestamp(content: string): string | null {
	for (const line of content.split("\n")) {
		const timestamp = readTimestamp(line);
		if (timestamp !== null) return timestamp;
	}
	return null;
}

function readTimestamp(line: string): string | null {
	if (!line.trim()) return null;
	try {
		const value: unknown = JSON.parse(line);
		if (
			typeof value === "object" &&
			value !== null &&
			"timestamp" in value &&
			typeof value.timestamp === "string" &&
			!Number.isNaN(Date.parse(value.timestamp))
		) {
			return value.timestamp;
		}
	} catch {
		return null;
	}
	return null;
}
