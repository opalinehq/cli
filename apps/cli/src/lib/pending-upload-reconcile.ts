import { ORPCError } from "@orpc/client";
import { parseSafeApiEndpoint } from "../contracts/index.js";
import {
	type FailedUpload,
	loadFailedUploads,
	type PendingUploadOutcome,
	settlePendingUpload,
} from "./failed-uploads.js";
import {
	createR2IngestRpcClient,
	isR2IngestStatusOutput,
} from "./r2-ingest-contract.js";
import {
	formatR2JobFailure,
	isRetryableR2JobFailure,
} from "./r2-upload-flow.js";

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
}

/**
 * Ask the server about uploads it accepted but had not finished: completed
 * jobs are cleared, failed jobs become real failures with the server's error,
 * and expired or unknown jobs return to the retry queue for a fresh upload.
 * Stops at the first transport error so an unreachable server costs one call.
 */
export async function reconcilePendingUploads(
	options: PendingReconcileOptions,
	environment: PendingReconcileEnvironment,
): Promise<PendingReconcileSummary> {
	const counts = {
		checked: 0,
		completed: 0,
		failed: 0,
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
		const outcome = await checkPendingUpload(entry, now, (jobId) =>
			client.ingest.status(
				{ jobId },
				{ signal: AbortSignal.timeout(STATUS_TIMEOUT_MS) },
			),
		);
		if (outcome === null) break;
		counts.checked += 1;
		await settlePendingUpload(entry.sessionId, entry.jobId, outcome);
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
): Promise<PendingUploadOutcome | null> {
	let status: unknown;
	try {
		status = await readStatus(entry.jobId);
	} catch (error) {
		if (error instanceof ORPCError && error.status === 404) {
			return {
				kind: "failed",
				error:
					"Opaline no longer has this upload job; the session will be uploaded again.",
				status: "retryable",
			};
		}
		return null;
	}
	if (!isR2IngestStatusOutput(status) || status.jobId !== entry.jobId)
		return null;
	if (status.status === "completed") return { kind: "completed" };
	if (status.status === "failed") {
		return {
			kind: "failed",
			error: formatR2JobFailure(status.error),
			status: isRetryableR2JobFailure(status.error?.code)
				? "retryable"
				: "permanent",
		};
	}
	if (now.getTime() - Date.parse(entry.failedAt) > PENDING_MAX_AGE_MS) {
		return {
			kind: "failed",
			error:
				"Opaline did not finish processing this upload within 48 hours; the session will be uploaded again.",
			status: "retryable",
		};
	}
	return { kind: "still-pending" };
}
