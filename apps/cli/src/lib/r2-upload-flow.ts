import { ORPCError } from "@orpc/client";
import {
	INGEST_DIRECT_CONTENT_MAX_BYTES,
	type IngestSessionInput,
} from "../contracts/index.js";
import type { FileBackedUploadRequest } from "../internal/agent-adapters/index.js";
import {
	getRedactionBudgetAnomaly,
	mergeRedactionCounts,
	type RedactionBudgetAnomaly,
	type RedactionCounts,
} from "../internal/secret-filter/index.js";
import {
	cleanupStagedUpload,
	createFilteredUploadSources,
	type StagedFilteredUpload,
	type StagedUploadObject,
	stageFilteredUpload,
} from "./filtered-upload-staging.js";
import {
	createR2IngestRpcClient,
	isR2IngestCommitOutput,
	isR2IngestInitOutput,
	isR2IngestStatusOutput,
	type R2IngestCommitInput,
	type R2IngestInitInput,
	type R2IngestStatusOutput,
	type R2IngestSuccess,
	type R2IngestUploadObject,
} from "./r2-ingest-contract.js";
import {
	type R2MultipartProgress,
	R2MultipartUploadError,
	uploadR2MultipartObjects,
} from "./r2-multipart-upload.js";
import type { UploadTransferProgress } from "./types.js";

const RPC_MAX_ATTEMPTS = 3;
const RPC_BASE_DELAY_MS = 500;
// Commit normally returns the terminal result. This longer fallback is used
// only when another worker owns the accepted job, and stays bounded so an
// automatic-upload hook cannot remain alive indefinitely.
const STATUS_MAX_POLLS = 300;
const STATUS_POLL_INTERVAL_MS = 1_000;
const COMMITTED_JOB_IN_PROGRESS_REASONS = new Set([
	"R2_INGEST_JOB_BUSY",
	"R2_INGEST_JOB_RETRY_LATER",
]);
// The server accepted the uploaded objects but its materialization queue was
// full. Repeating the commit only queues again; the job is finished by the
// server's recovery worker and confirmed by status polling or reconciliation.
const MATERIALIZATION_QUEUED_REASON = "R2_INGEST_GATE_QUEUE_TIMEOUT";
// Server job failures that are not caused by the transcript itself: a fresh
// upload of the same session can succeed.
const RETRYABLE_JOB_FAILURE_CODES = new Set([
	"R2_INGEST_JOB_EXPIRED",
	"R2_INGEST_ATTEMPTS_EXHAUSTED",
]);

export interface R2UploadFlowConfig {
	readonly authType: "api-key" | "bearer";
	readonly endpoint: URL;
	/** Per-session limit for an upload with this slimming outcome. */
	readonly maxAggregateBytes: (slimming: TranscriptSlimming) => number;
	/**
	 * Asked only when slimming changes the transcript: whether the server
	 * accepts slimmed transcripts. Otherwise the upload is restaged unslimmed.
	 */
	readonly canSlim: () => Promise<boolean>;
	readonly multipartBaseDelayMs: number | undefined;
	readonly onProgress: ((progress: R2MultipartProgress) => void) | undefined;
	readonly onTransferProgress?: (progress: UploadTransferProgress) => void;
	readonly onRetry:
		| ((attempt: number, maxAttempts: number, error: string) => void)
		| undefined;
	readonly statusPollIntervalMs: number | undefined;
	/** Status polls before an accepted job is left to later reconciliation. */
	readonly statusMaxPolls: number | undefined;
	readonly token: string;
	/** Receives the slimmed, filtered session size once it is staged. */
	readonly onStaged?: (aggregateBytes: number) => void;
}

/**
 * `applied`: slimmed for a server that accepts it; `unchanged`: slimming
 * changes nothing in this transcript; `unsupported`: the server does not
 * accept slimmed transcripts, so it is sent unslimmed.
 */
export type TranscriptSlimming = "applied" | "unchanged" | "unsupported";

export type R2UploadFlowResult =
	| {
			readonly actualBytes: number;
			readonly maxBytes: number;
			/** Slimming of the measured upload. */
			readonly slimming: TranscriptSlimming;
			readonly status: "too-large";
	  }
	| {
			readonly status: "empty-main";
	  }
	| {
			readonly anomaly: RedactionBudgetAnomaly;
			readonly status: "redaction-budget";
	  }
	| {
			readonly attempts: number;
			readonly redactedBytes: number;
			readonly redactions: RedactionCounts;
			readonly result: R2IngestSuccess;
			readonly status: "success";
	  };

export class R2IngestInitError extends Error {
	readonly causeValue: unknown;
	readonly retryable: boolean;

	constructor(causeValue: unknown, retryable: boolean) {
		const detail = causeValue instanceof Error ? causeValue.message : "unknown";
		super(`Could not initialize direct R2 upload: ${detail}`);
		this.name = "R2IngestInitError";
		this.causeValue = causeValue;
		this.retryable = retryable;
	}
}

export class R2IngestFlowError extends Error {
	readonly retryable: boolean;

	constructor(message: string, retryable: boolean) {
		super(message);
		this.name = "R2IngestFlowError";
		this.retryable = retryable;
	}
}

/**
 * The server accepted the upload but had not finished processing it when the
 * local polling window ended. The job keeps running server-side; callers record
 * it as pending and reconcile it later with `ingest.status`.
 */
export class R2IngestPendingError extends Error {
	readonly jobId: string;

	constructor(jobId: string) {
		super(
			"Opaline accepted the upload and is still processing it; it will be checked again on the next upload or `opaline upload --retry`.",
		);
		this.name = "R2IngestPendingError";
		this.jobId = jobId;
	}
}

export function isRetryableR2JobFailure(code: string | undefined): boolean {
	return code !== undefined && RETRYABLE_JOB_FAILURE_CODES.has(code);
}

export async function uploadSessionViaR2(
	request: IngestSessionInput | FileBackedUploadRequest,
	config: R2UploadFlowConfig,
): Promise<R2UploadFlowResult> {
	let staged = await stageFilteredUpload(
		createFilteredUploadSources(request, { slim: true }),
	);
	// Slimming that changed nothing needs no negotiation; slimmed bytes go
	// only to a server that accepts them.
	let slimming: TranscriptSlimming =
		staged.aggregateBytes < staged.unslimmedBytes ? "applied" : "unchanged";
	if (slimming === "applied" && !(await config.canSlim())) {
		await cleanupStagedUpload(staged);
		staged = await stageFilteredUpload(
			createFilteredUploadSources(request, { slim: false }),
		);
		slimming = "unsupported";
	}
	config.onStaged?.(staged.aggregateBytes);
	try {
		const preflight = getPreflightFailure(
			staged,
			config.maxAggregateBytes(slimming),
			slimming,
		);
		if (preflight) return preflight;
		return await uploadStagedSession(staged, config);
	} finally {
		await cleanupStagedUpload(staged);
	}
}

export function isR2InitUnsupported(error: unknown): boolean {
	if (!(error instanceof R2IngestInitError)) return false;
	const cause = error.causeValue;
	return (
		cause instanceof ORPCError &&
		(cause.status === 404 ||
			cause.status === 405 ||
			cause.status === 501 ||
			cause.code === "R2_INGEST_DISABLED")
	);
}

function getPreflightFailure(
	staged: StagedFilteredUpload,
	maxAggregateBytes: number,
	slimming: TranscriptSlimming,
): Exclude<R2UploadFlowResult, { readonly status: "success" }> | null {
	const main = staged.objects.find((object) => object.kind === "main");
	if (!main || main.byteLength === 0) return { status: "empty-main" };
	// The filter ran over the raw input, as in 0.11.
	const anomaly = getRedactionBudgetAnomaly(
		staged.redactedBytes,
		staged.inputBytes,
		staged.redactions,
	);
	if (anomaly) return { anomaly, status: "redaction-budget" };
	if (staged.aggregateBytes > maxAggregateBytes) {
		return {
			actualBytes: staged.aggregateBytes,
			maxBytes: maxAggregateBytes,
			slimming,
			status: "too-large",
		};
	}
	return null;
}

async function uploadStagedSession(
	staged: StagedFilteredUpload,
	config: R2UploadFlowConfig,
): Promise<Extract<R2UploadFlowResult, { readonly status: "success" }>> {
	const transferred = new Map<string, number>();
	const totalBytes = staged.aggregateBytes;
	config.onTransferProgress?.({
		phase: "uploading",
		uploadedBytes: 0,
		totalBytes,
	});
	const client = createR2IngestRpcClient(config);
	let initCall: Awaited<ReturnType<typeof callRpcWithRetry>>;
	try {
		initCall = await callRpcWithRetry(
			() => client.ingest.init(buildInitInput(staged)),
			config.onRetry,
		);
	} catch (error) {
		if (isServerSessionSizeRejection(error, staged.aggregateBytes)) {
			throw new R2IngestFlowError(
				formatServerSessionSizeRejection(staged.aggregateBytes),
				true,
			);
		}
		throw new R2IngestInitError(error, isRetryableRpcError(error));
	}
	if (!isR2IngestInitOutput(initCall.value)) {
		throw new R2IngestInitError(
			new Error("Opaline API returned an invalid R2 init response"),
			false,
		);
	}
	const sources = matchUploadSources(staged.objects, initCall.value.objects);
	const multipart = await uploadR2MultipartObjects({
		baseDelayMs: config.multipartBaseDelayMs,
		fetch: undefined,
		maxAttempts: RPC_MAX_ATTEMPTS,
		onProgress: (progress) => {
			config.onProgress?.(progress);
			transferred.set(progress.objectKey, progress.objectBytesUploaded);
			config.onTransferProgress?.({
				phase: "uploading",
				uploadedBytes: [...transferred.values()].reduce(
					(sum, bytes) => sum + bytes,
					0,
				),
				totalBytes,
			});
		},
		onRetry: config.onRetry
			? (retry) =>
					config.onRetry?.(retry.attempt, retry.maxAttempts, retry.error)
			: undefined,
		sources,
	});
	config.onTransferProgress?.({
		phase: "processing",
		uploadedBytes: totalBytes,
		totalBytes,
	});
	const commitInput: R2IngestCommitInput = {
		jobId: initCall.value.jobId,
		objects: multipart.objects,
	};
	let commitAttempts = RPC_MAX_ATTEMPTS;
	let commitResult: R2IngestSuccess | null = null;
	try {
		const commitCall = await callRpcWithRetry(
			() => client.ingest.commit(commitInput),
			config.onRetry,
		);
		commitAttempts = commitCall.attempts;
		if (!isR2IngestCommitOutput(commitCall.value)) {
			throw new R2IngestFlowError(
				"Opaline API returned an invalid R2 commit response",
				false,
			);
		}
		if (commitCall.value.jobId !== initCall.value.jobId) {
			throw new R2IngestFlowError(
				"Opaline API returned an R2 commit response for a different job",
				false,
			);
		}
		commitResult = commitCall.value.result;
	} catch (error) {
		if (
			!isCommittedJobInProgressError(error) &&
			!isMaterializationQueuedError(error)
		)
			throw error;
	}
	const statusCall = await pollJobStatus(client, initCall.value.jobId, config);
	const serverResult = statusCall.result ?? commitResult;
	if (!serverResult) {
		throw new R2IngestFlowError(
			"Opaline API returned a completed R2 status without a result",
			false,
		);
	}
	return {
		attempts: Math.max(
			initCall.attempts,
			multipart.attempts,
			commitAttempts,
			statusCall.attempts,
		),
		redactedBytes: staged.redactedBytes + (serverResult.redactedBytes ?? 0),
		redactions: mergeRedactionCounts(
			staged.redactions,
			serverResult.redacted ?? {},
		),
		result: serverResult,
		status: "success",
	};
}

/**
 * Servers released before the 256 MiB limit reject a larger session at init:
 * the size check answers 413, or input validation answers 400 with an issue
 * about object sizes (`objects[n].byteLength` above the limit, or the
 * "Aggregate transcript content exceeds N bytes" refinement on `objects`).
 * Only those are size rejections; any other 400 (for example "Choose an
 * organization with --org or opaline set-org") keeps the server's message.
 */
export function isServerSessionSizeRejection(
	error: unknown,
	aggregateBytes: number,
): boolean {
	if (aggregateBytes <= INGEST_DIRECT_CONTENT_MAX_BYTES) return false;
	if (!(error instanceof ORPCError)) return false;
	if (error.status === 413) return true;
	if (error.status !== 400) return false;
	const issues = isRecord(error.data) ? error.data.issues : undefined;
	if (!Array.isArray(issues)) return false;
	return issues.some((issue) => {
		if (!isRecord(issue)) return false;
		const message = typeof issue.message === "string" ? issue.message : "";
		const path = Array.isArray(issue.path)
			? issue.path.map((key) => (isRecord(key) ? String(key.key) : String(key)))
			: [];
		return (
			path.some((key) =>
				/^(?:byteLength|expected_total_bytes|expectedTotalBytes)$/u.test(key),
			) || /exceeds \d+ bytes|too (?:large|big)/iu.test(message)
		);
	});
}

function formatServerSessionSizeRejection(aggregateBytes: number): string {
	const size = (aggregateBytes / (1024 * 1024)).toFixed(2);
	const limit = INGEST_DIRECT_CONTENT_MAX_BYTES / (1024 * 1024);
	return `The Opaline server does not accept sessions this large yet: this session is ${size} MiB after slimming, and the server still accepts up to ${limit} MiB. It stays queued; retry with \`opaline upload --retry\` after the server is updated.`;
}

async function pollJobStatus(
	client: ReturnType<typeof createR2IngestRpcClient>,
	jobId: string,
	config: R2UploadFlowConfig,
): Promise<{
	readonly attempts: number;
	readonly result: R2IngestSuccess | null;
}> {
	let maxAttempts = 1;
	const maxPolls = Math.max(1, config.statusMaxPolls ?? STATUS_MAX_POLLS);
	for (let poll = 0; poll < maxPolls; poll += 1) {
		let statusCall: {
			readonly attempts: number;
			readonly value: R2IngestStatusOutput;
		};
		try {
			statusCall = await callRpcWithRetry(
				() => client.ingest.status({ jobId }),
				config.onRetry,
			);
		} catch (error) {
			// The job was accepted; an unreachable status endpoint does not make
			// it fail. Leave it to reconciliation instead of re-uploading.
			if (isRetryableRpcError(error)) throw new R2IngestPendingError(jobId);
			throw error;
		}
		maxAttempts = Math.max(maxAttempts, statusCall.attempts);
		if (!isR2IngestStatusOutput(statusCall.value)) {
			throw new R2IngestFlowError(
				"Opaline API returned an invalid R2 status response",
				false,
			);
		}
		if (statusCall.value.jobId !== jobId) {
			throw new R2IngestFlowError(
				"Opaline API returned an R2 status response for a different job",
				false,
			);
		}
		if (statusCall.value.status === "completed") {
			return { attempts: maxAttempts, result: statusCall.value.result };
		}
		if (statusCall.value.status === "failed") {
			throw new R2IngestFlowError(
				formatR2JobFailure(statusCall.value.error),
				isRetryableR2JobFailure(statusCall.value.error?.code),
			);
		}
		if (poll + 1 < maxPolls) {
			await delay(config.statusPollIntervalMs ?? STATUS_POLL_INTERVAL_MS);
		}
	}
	throw new R2IngestPendingError(jobId);
}

export function formatR2JobFailure(
	error: { readonly code: string; readonly message: string } | null,
): string {
	return `R2 ingest job failed after upload: ${error?.message ?? "unknown processing error"}`;
}

function buildInitInput(staged: StagedFilteredUpload): R2IngestInitInput {
	return {
		...staged.metadata,
		objects: staged.objects.map((object) =>
			object.kind === "main"
				? {
						byteLength: object.byteLength,
						kind: object.kind,
						sha256: object.sha256,
					}
				: {
						agentId: object.agentId,
						byteLength: object.byteLength,
						kind: object.kind,
						sha256: object.sha256,
					},
		),
	};
}

function matchUploadSources(
	stagedObjects: readonly StagedUploadObject[],
	uploadObjects: readonly R2IngestUploadObject[],
): readonly { readonly path: string; readonly upload: R2IngestUploadObject }[] {
	if (stagedObjects.length !== uploadObjects.length) {
		throw new R2IngestFlowError(
			"R2 init response returned a different number of upload objects",
			false,
		);
	}
	const stagedByIdentity = new Map(
		stagedObjects.map((object) => [getObjectIdentity(object), object]),
	);
	return uploadObjects.map((upload) => {
		const staged = stagedByIdentity.get(getObjectIdentity(upload));
		if (!staged) {
			throw new R2IngestFlowError(
				"R2 init response returned an unexpected upload object",
				false,
			);
		}
		if (
			staged.byteLength !== upload.byteLength ||
			staged.sha256 !== upload.sha256
		) {
			throw new R2IngestFlowError(
				"R2 init response changed an upload object's size or SHA-256",
				false,
			);
		}
		return { path: staged.path, upload };
	});
}

function getObjectIdentity(
	object: StagedUploadObject | R2IngestUploadObject,
): string {
	return object.kind === "main" ? "main" : `subagent:${object.agentId}`;
}

async function callRpcWithRetry<TValue>(
	operation: () => Promise<TValue>,
	onRetry:
		| ((attempt: number, maxAttempts: number, error: string) => void)
		| undefined,
): Promise<{ readonly attempts: number; readonly value: TValue }> {
	for (let attempt = 1; attempt <= RPC_MAX_ATTEMPTS; attempt += 1) {
		try {
			return { attempts: attempt, value: await operation() };
		} catch (error) {
			if (
				!isRetryableRpcError(error) ||
				isMaterializationQueuedError(error) ||
				attempt === RPC_MAX_ATTEMPTS
			) {
				throw error;
			}
			const detail =
				error instanceof Error ? error.message : "connection failed";
			onRetry?.(attempt, RPC_MAX_ATTEMPTS, detail);
			await delay(RPC_BASE_DELAY_MS * 2 ** (attempt - 1));
		}
	}
	throw new Error("R2 RPC retries were exhausted");
}

function isRetryableRpcError(error: unknown): boolean {
	if (error instanceof ORPCError) {
		return (
			error.status === 408 ||
			error.status === 425 ||
			error.status === 429 ||
			error.status >= 500
		);
	}
	return true;
}

function isCommittedJobInProgressError(error: unknown): boolean {
	if (!(error instanceof ORPCError) || !isRecord(error.data)) return false;
	const reason = error.data.reason;
	return (
		typeof reason === "string" && COMMITTED_JOB_IN_PROGRESS_REASONS.has(reason)
	);
}

// Older APIs answer a full materialization queue with the gate's own reason;
// current APIs mark the job for their recovery worker and say `queued: true`.
function isMaterializationQueuedError(error: unknown): boolean {
	return (
		error instanceof ORPCError &&
		isRecord(error.data) &&
		(error.data.reason === MATERIALIZATION_QUEUED_REASON ||
			error.data.queued === true)
	);
}

export function formatR2UploadFlowError(error: unknown): {
	readonly message: string;
	readonly retryable: boolean;
} {
	if (error instanceof R2MultipartUploadError) {
		return { message: error.message, retryable: error.retryable };
	}
	if (error instanceof R2IngestFlowError) {
		return { message: error.message, retryable: error.retryable };
	}
	if (error instanceof R2IngestInitError) {
		return { message: error.message, retryable: error.retryable };
	}
	if (error instanceof ORPCError) {
		return {
			message: `${error.status} ${error.message}`,
			retryable: isRetryableRpcError(error),
		};
	}
	const message = error instanceof Error ? error.message : "connection failed";
	return {
		message: `Network error during direct R2 upload: ${message}`,
		retryable: true,
	};
}

async function delay(milliseconds: number): Promise<void> {
	if (milliseconds <= 0) return;
	await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
