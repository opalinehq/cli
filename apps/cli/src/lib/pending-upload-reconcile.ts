import { ORPCError } from "@orpc/client";
import { parseSafeApiEndpoint } from "../contracts/index.js";
import { invalidateAnalysisMarkers } from "./analysis-markers.js";
import {
	type FailedUpload,
	loadFailedUploads,
	type PendingUploadOutcome,
	settlePendingUpload,
} from "./failed-uploads.js";
import {
	createR2IngestRpcClient,
	isR2IngestStatusOutput,
	type R2IngestSuccess,
} from "./r2-ingest-contract.js";
import {
	formatR2JobFailure,
	isRetryableR2JobFailure,
} from "./r2-upload-flow.js";
import { ANALYSIS_UPLOAD_UNSUPPORTED_MESSAGE } from "./uploader.js";

// Server jobs expire after 24 hours; an entry still pending well past that is
// re-uploaded instead of being checked forever.
const PENDING_MAX_AGE_MS = 48 * 60 * 60 * 1_000;
const STATUS_TIMEOUT_MS = 5_000;

export interface PendingReconcileOptions {
	/** Upper bound on status checks in this pass (oldest checks first). */
	readonly maxEntries: number;
	readonly now?: Date;
}

export interface PendingReconcileEnvironment {
	readonly allowInsecureEndpoint: boolean;
	readonly authType: "api-key" | "bearer" | undefined;
	/** RPC endpoint, e.g. `https://opaline.so/rpc`. */
	readonly endpoint: string;
	readonly token: string;
}

export interface PendingReconcileSummary {
	readonly checked: number;
	readonly completed: number;
	readonly failed: number;
	readonly requeued: number;
	readonly stillPending: number;
	/** Completed analysis uploads the server stored without confirming the link. */
	readonly linkFailures: readonly string[];
}

type PendingCheck =
	| { readonly kind: "settle"; readonly outcome: PendingUploadOutcome }
	/** The server or the key is unavailable: stop this pass, change nothing. */
	| { readonly kind: "stop" };

/**
 * Ask the server about uploads it accepted but had not finished: completed
 * jobs are cleared, failed jobs become real failures with the server's error,
 * and expired, unknown or inaccessible jobs return to the retry queue for a
 * fresh upload. A completed job counts only when its result names the saved
 * session (and analysis, for analysis uploads). Stops at the first transport
 * or authentication error so an unreachable server costs one call.
 */
export async function reconcilePendingUploads(
	options: PendingReconcileOptions,
	environment: PendingReconcileEnvironment,
): Promise<PendingReconcileSummary> {
	const counts = {
		checked: 0,
		completed: 0,
		failed: 0,
		linkFailures: [] as string[],
		requeued: 0,
		stillPending: 0,
	};
	// Pending entries only come from API-key R2 uploads.
	if (environment.authType !== "api-key" || options.maxEntries <= 0)
		return counts;
	const pending = selectPendingUploads(
		await loadFailedUploads(),
		options.maxEntries,
	);
	if (pending.length === 0) return counts;
	const endpoint = parseSafeApiEndpoint(environment.endpoint, {
		allowPlaintext: environment.allowInsecureEndpoint,
	});
	if (!endpoint.ok) return counts;
	const client = createR2IngestRpcClient({
		authType: "api-key",
		endpoint: new URL(endpoint.url),
		token: environment.token,
	});
	const now = options.now ?? new Date();

	for (const entry of pending) {
		const check = await checkPendingUpload(entry, now, (jobId) =>
			client.ingest.status(
				{ jobId },
				{ signal: AbortSignal.timeout(STATUS_TIMEOUT_MS) },
			),
		);
		if (check.kind === "stop") break;
		const { outcome } = check;
		counts.checked += 1;
		await settlePendingUpload(entry.sessionId, entry.jobId, outcome);
		if (outcome.kind === "failed" && outcome.analysisLinkMissing) {
			counts.linkFailures.push(`${entry.sessionId}: ${outcome.error}`);
			if (entry.analysisId !== undefined)
				await invalidateAnalysisMarkers(entry.analysisId, entry.sessionId);
		}
		if (outcome.kind === "completed") counts.completed += 1;
		else if (outcome.kind === "still-pending") counts.stillPending += 1;
		else if (outcome.status === "retryable") counts.requeued += 1;
		else counts.failed += 1;
	}
	return counts;
}

function selectPendingUploads(
	failures: readonly FailedUpload[],
	maxEntries: number,
): Array<FailedUpload & { jobId: string }> {
	return (
		failures
			.flatMap((failure) =>
				failure.status === "pending" && failure.jobId !== undefined
					? [{ ...failure, jobId: failure.jobId }]
					: [],
			)
			// Never-checked entries first, then the least recently checked.
			.sort(
				(left, right) =>
					Number(left.checkedAt !== undefined) -
						Number(right.checkedAt !== undefined) ||
					Date.parse(left.checkedAt ?? left.failedAt) -
						Date.parse(right.checkedAt ?? right.failedAt),
			)
			.slice(0, maxEntries)
	);
}

async function checkPendingUpload(
	entry: FailedUpload & { jobId: string },
	now: Date,
	readStatus: (jobId: string) => Promise<unknown>,
): Promise<PendingCheck> {
	let status: unknown;
	try {
		status = await readStatus(entry.jobId);
	} catch (error) {
		return classifyStatusError(error);
	}
	// A malformed or foreign answer says nothing about this job: note the
	// check so the next pass rotates to other entries.
	if (!isR2IngestStatusOutput(status) || status.jobId !== entry.jobId)
		return settle({ kind: "still-pending" });
	if (status.status === "completed")
		return settle(checkCompletedResult(entry, status.result));
	if (status.status === "failed") {
		return settle({
			kind: "failed",
			error: formatR2JobFailure(status.error),
			status: isRetryableR2JobFailure(status.error?.code)
				? "retryable"
				: "permanent",
		});
	}
	if (now.getTime() - Date.parse(entry.failedAt) > PENDING_MAX_AGE_MS) {
		return settle({
			kind: "failed",
			error:
				"Opaline did not finish processing this upload within 48 hours; the session will be uploaded again.",
			status: "retryable",
		});
	}
	return settle({ kind: "still-pending" });
}

function classifyStatusError(error: unknown): PendingCheck {
	if (!(error instanceof ORPCError)) return { kind: "stop" };
	// Outages, throttling and an invalid key affect every job alike.
	if (
		error.status === 401 ||
		error.status === 408 ||
		error.status === 425 ||
		error.status === 429 ||
		error.status >= 500
	)
		return { kind: "stop" };
	if (error.status === 404)
		return settle({
			kind: "failed",
			error:
				"Opaline no longer has this upload job; the session will be uploaded again.",
			status: "retryable",
		});
	// Any other refusal (403 and similar) concerns this job only: it can
	// never be confirmed, so the session goes back to the retry queue.
	return settle({
		kind: "failed",
		error: `Opaline refused the status of this upload job (${error.status} ${error.message}); the session will be uploaded again.`,
		status: "retryable",
	});
}

function checkCompletedResult(
	entry: FailedUpload,
	result: R2IngestSuccess | null,
): PendingUploadOutcome {
	if (result !== null && result.sessionId !== entry.sessionId)
		return {
			kind: "failed",
			error: `Opaline completed this upload job for a different session (${result.sessionId}); the session will be uploaded again.`,
			status: "retryable",
		};
	if (entry.analysisId !== undefined && result?.analysisId !== entry.analysisId)
		return {
			analysisLinkMissing: true,
			kind: "failed",
			error: `Opaline stored this session without its link to analysis ${entry.analysisId}. ${ANALYSIS_UPLOAD_UNSUPPORTED_MESSAGE}`,
			status: "permanent",
		};
	return { kind: "completed" };
}

function settle(outcome: PendingUploadOutcome): PendingCheck {
	return { kind: "settle", outcome };
}
