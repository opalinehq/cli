import { readFile, rm } from "node:fs/promises";
import type { IngestSessionInput } from "../contracts/index.js";
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
	deferPendingRepositoryEvidence,
	normalizeRepositoryEvidenceEndpoint,
	type PendingRepositoryEvidence,
	readPendingRepositoryEvidence,
	removePendingRepositoryEvidence,
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
import { allowsInsecureEndpointFromEnv } from "./upload-endpoint.js";

type EvidenceLifecycle = "start" | "resume" | "checkpoint" | "end";

const EVIDENCE_DELIVERY_BUDGET_MS = 20_000;
const DISABLED_CLEANUP_LOCK_WAIT_MS = 2_000;
export const EVIDENCE_TRANSCRIPT_INPUT_MAX_BYTES = 32 * 1024 * 1024;

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
	const deadlineAt = Date.now() + EVIDENCE_DELIVERY_BUDGET_MS;
	if (!input.credentials.user) {
		throw new Error("Repository evidence requires an authenticated CLI user.");
	}
	requireRepositoryEvidenceApiKey(input.credentials.authType);
	const configDir = getConfigDir();
	const apiBase = getApiBaseOverride() ?? input.credentials.apiBaseUrl;
	const endpoint = normalizeRepositoryEvidenceEndpoint(`${apiBase}/rpc`);
	const materialized = await materializeEvidenceRequest(
		input.request,
		input.requestMaterializedAt,
		configDir,
		deadlineAt,
	);
	const request = materialized.request;
	const sourceId = materialized.sourceId;
	let hasPending = false;
	let currentPending: PendingRepositoryEvidence | undefined;
	let contextCapture:
		| Awaited<ReturnType<typeof collectSessionRepositoryContext>>
		| undefined;
	try {
		contextCapture = await collectSessionRepositoryContext({
			accountId: input.credentials.user.id,
			endpoint,
			lifecycle: input.lifecycle,
			organizationId: input.organizationId,
			repositoryPath: request.projectPath,
			deadlineAt,
		});
		const scope = {
			actorId: input.credentials.user.id,
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
		assertCaptureBudget(deadlineAt);
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
		currentPending = {
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
		assertCaptureBudget(deadlineAt);
		await writePendingRepositoryEvidence(currentPending, configDir);
		hasPending = true;
		const receipt = await uploadWithBoundedRetries(upload, input.credentials, {
			deadlineAt,
			endpoint,
		});
		await markRepositorySpoolCaptureAccepted(
			contextCapture.context.binding,
			contextCapture.stored.capture.captureId,
			"local-context",
			contextCapture.context.spoolEnv,
		);
		await advanceTranscriptRevision(
			transcriptRevision.manifest,
			deliveryScope,
			configDir,
		);
		await continueAcceptedTranscript(currentPending, configDir);
		let pendingError: unknown;
		try {
			pendingError = await retryOnePendingRepositoryEvidence(
				input.credentials,
				input.credentials.user.id,
				endpoint,
				configDir,
				deadlineAt,
				input.onWarning,
			);
		} catch (error) {
			pendingError = error;
		}
		if (pendingError !== undefined) throw pendingError;
		return {
			contextId: receipt.contextId,
			receiptId: receipt.receiptId,
		};
	} catch (error) {
		if (isEvidenceCaptureDisabledError(error)) {
			await handleDisabledCapture(
				error,
				currentPending,
				configDir,
				input.onWarning,
				deadlineAt,
			);
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
		try {
			await uploadWithBoundedRetries(pending.upload, credentials, {
				allowInsecureEndpoint: options.allowInsecureEndpoint,
				endpoint: pending.endpoint,
			});
			await markPendingRepositoryCaptureAccepted(pending, configDir);
			await advanceTranscriptRevision(
				pending.transcriptRevision,
				getPendingDeliveryScope(pending),
				configDir,
			);
			await continueAcceptedTranscript(pending, configDir);
			completed++;
		} catch (error) {
			if (isEvidenceCaptureDisabledError(error)) {
				await handleDisabledCapture(
					error,
					pending,
					configDir,
					options.onWarning,
				);
				break;
			}
			failures.push(error);
			await deferPendingRepositoryEvidence(pending, configDir);
		}
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
			isPendingRepositoryEvidenceAutoUploadAllowed(pending, configDir),
		onError: (error) => failures.push(error),
		onWarning: (warning) => onWarning?.(warning.message),
	})) {
		try {
			await uploadWithBoundedRetries(pending.upload, credentials, {
				canUpload: () =>
					isPendingRepositoryEvidenceAutoUploadAllowed(pending, configDir),
				deadlineAt,
				endpoint: pending.endpoint,
			});
			await markPendingRepositoryCaptureAccepted(pending, configDir);
			await advanceTranscriptRevision(
				pending.transcriptRevision,
				getPendingDeliveryScope(pending),
				configDir,
			);
			await continueAcceptedTranscript(pending, configDir);
		} catch (error) {
			if (isEvidenceCaptureDisabledError(error)) {
				await handleDisabledCapture(
					error,
					pending,
					configDir,
					onWarning,
					deadlineAt,
				);
				return undefined;
			}
			if (error instanceof RepositoryAutoUploadDisabledError) continue;
			failures.push(error);
			await deferPendingRepositoryEvidence(pending, configDir);
		}
	}
	return failures[0];
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
	deadlineAt?: number,
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
					const env = createRepositorySpoolEnv(configDir);
					await removeRepositorySpoolCapture(
						binding,
						pending.upload.input.capture.contextId,
						deadlineAt === undefined
							? env
							: {
									...env,
									writeLockTimeoutMs: Math.min(
										DISABLED_CLEANUP_LOCK_WAIT_MS,
										Math.max(0, deadlineAt - Date.now()),
									),
								},
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
		const remainingMs = overrides.deadlineAt
			? overrides.deadlineAt - Date.now()
			: undefined;
		if (remainingMs !== undefined && remainingMs <= 0) {
			throw deliveryBudgetExceeded();
		}
		try {
			return await uploadRepositoryEvidence(upload, {
				...config,
				operationTimeoutMs: remainingMs,
			});
		} catch (error) {
			lastError = error;
			if (isEvidenceCaptureDisabledError(error)) throw error;
			if (!isRetryableRepositoryEvidenceError(error) || attempt === 3) break;
			const retryDelayMs = overrides.deadlineAt
				? Math.min(attempt * 100, overrides.deadlineAt - Date.now())
				: attempt * 100;
			if (retryDelayMs <= 0) throw deliveryBudgetExceeded();
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

function deliveryBudgetExceeded(): Error {
	return new Error(
		`Repository evidence delivery exceeded its ${EVIDENCE_DELIVERY_BUDGET_MS}ms budget.`,
	);
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
	if (Date.now() >= deadlineAt) throw deliveryBudgetExceeded();
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
