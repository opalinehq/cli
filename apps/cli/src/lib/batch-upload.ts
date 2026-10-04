import { stat } from "node:fs/promises";
import pMap from "p-map";
import type { Source } from "../contracts/index.js";
import { MissingTranscriptTimestampError } from "../internal/agent-adapters/index.js";
import {
	mergeRedactionCounts,
	type RedactionCounts,
	SecretFilterJsonIntegrityError,
} from "../internal/secret-filter/index.js";
import {
	type FailedUpload,
	recordFailedUpload,
	recordPendingUpload,
	removeFailedUpload,
} from "./failed-uploads.js";
import type { UploadResult } from "./types.js";

export interface BatchUploadItem {
	sessionId: string;
	label: string;
	transcriptPath: string;
	projectPath: string;
	source?: Source;
	organizationId?: string;
	analysisId?: string;
}

export interface BatchUploadOptions<T extends BatchUploadItem> {
	items: T[];
	upload: (
		item: T,
		onRetry: (attempt: number, maxAttempts: number, error: string) => void,
	) => Promise<UploadResult>;
	concurrency?: number;
	signal?: AbortSignal;
	onItemComplete?: (completed: number, total: number) => void;
	onRetry?: (
		label: string,
		attempt: number,
		maxAttempts: number,
		error: string,
	) => void;
}

export interface BatchUploadSummary {
	succeeded: number;
	/** Accepted by the server but still processing; reconciled later. */
	pending: number;
	failed: number;
	skipped: number;
	total: number;
	errors: Array<{ label: string; error: string }>;
	skippedItems: Array<{ label: string; reason: string }>;
	redacted: RedactionCounts;
	redactedBytes: number;
}

export async function batchUpload<T extends BatchUploadItem>(
	options: BatchUploadOptions<T>,
): Promise<BatchUploadSummary> {
	const { upload, concurrency = 5, onItemComplete, onRetry } = options;
	// Small sessions first: one heavy transcript must not hold back the rest.
	const items = await orderBySizeAscending(options.items);
	const recordFailure = async (
		item: T,
		failure: {
			error: string;
			status: "permanent" | "retryable";
			failureKind?: FailedUpload["failureKind"];
		},
	) => {
		await recordFailedUpload({
			sessionId: item.sessionId,
			transcriptPath: item.transcriptPath,
			projectPath: item.projectPath,
			source: item.source,
			organizationId: item.organizationId,
			analysisId: item.analysisId,
			...failure,
		});
	};
	const total = items.length;
	let succeeded = 0;
	let pending = 0;
	let failed = 0;
	let skipped = 0;
	let deferred = 0;
	let completed = 0;
	let rateLimited = false;
	const errors: Array<{ label: string; error: string }> = [];
	const skippedItems: Array<{ label: string; reason: string }> = [];
	let redacted: RedactionCounts = {};
	let redactedBytes = 0;

	await pMap(
		items,
		async (item) => {
			if (options.signal?.aborted) return;
			if (rateLimited) {
				deferred++;
				const error =
					"Skipped — rate limit reached. Run `opaline upload` to upload remaining sessions.";
				await recordFailure(item, { error, status: "retryable" });
				completed++;
				onItemComplete?.(completed, total);
				return;
			}

			const itemOnRetry = (
				attempt: number,
				maxAttempts: number,
				error: string,
			) => {
				onRetry?.(item.label, attempt, maxAttempts, error);
			};

			try {
				const result = await upload(item, itemOnRetry);
				if (result.success) {
					succeeded++;
					redacted = mergeRedactionCounts(redacted, result.redacted ?? {});
					redactedBytes += result.redactedBytes ?? 0;
					await removeFailedUpload(item.sessionId);
				} else if (result.pendingJobId !== undefined) {
					pending++;
					await recordPendingUpload({
						sessionId: item.sessionId,
						transcriptPath: item.transcriptPath,
						projectPath: item.projectPath,
						source: item.source,
						organizationId: item.organizationId,
						analysisId: item.analysisId,
						error: result.error ?? "Still processing on the server",
						jobId: result.pendingJobId,
					});
				} else if (result.retryable === false) {
					skipped++;
					skippedItems.push({
						label: item.label,
						reason: result.error ?? "Upload cannot be retried",
					});
					await recordFailure(item, {
						error: result.error ?? "Upload cannot be retried",
						failureKind: result.failureKind,
						status: "permanent",
					});
				} else {
					failed++;
					const error = result.error ?? "Unknown error";
					errors.push({ label: item.label, error });
					if (result.rateLimited) {
						rateLimited = true;
					}
					await recordFailure(item, {
						error,
						failureKind: result.failureKind,
						status: "retryable",
					});
				}
			} catch (err) {
				if (options.signal?.aborted) return;
				const error = err instanceof Error ? err.message : String(err);
				if (
					err instanceof MissingTranscriptTimestampError ||
					err instanceof SecretFilterJsonIntegrityError
				) {
					skipped++;
					skippedItems.push({ label: item.label, reason: error });
					await recordFailure(item, {
						error,
						failureKind:
							err instanceof SecretFilterJsonIntegrityError
								? "json-integrity"
								: undefined,
						status: "permanent",
					});
				} else {
					failed++;
					errors.push({ label: item.label, error });
					await recordFailure(item, { error, status: "retryable" });
				}
			} finally {
				completed++;
				onItemComplete?.(completed, total);
			}
		},
		{ concurrency, stopOnError: false },
	);

	if (rateLimited && deferred > 0) {
		errors.push({
			label: "Rate limit",
			error: `${deferred} session(s) skipped. Run \`opaline upload\` later to upload them.`,
		});
		failed += deferred;
	}

	return {
		succeeded,
		pending,
		failed,
		skipped,
		total,
		errors,
		skippedItems,
		redacted,
		redactedBytes,
	};
}

/**
 * Order uploads by main transcript size, smallest first. Unreadable files keep
 * their relative order at the end, where their upload reports the real error.
 */
export async function orderBySizeAscending<
	T extends { transcriptPath: string },
>(items: readonly T[]): Promise<T[]> {
	const sized = await pMap(
		items,
		async (item, index) => ({
			index,
			item,
			size: await stat(item.transcriptPath).then(
				(stats) => stats.size,
				() => Number.POSITIVE_INFINITY,
			),
		}),
		{ concurrency: 16 },
	);
	return sized
		.sort((left, right) =>
			left.size === right.size
				? left.index - right.index
				: left.size - right.size,
		)
		.map((entry) => entry.item);
}
