import type { Logger } from "@logtape/logtape";
import {
	type FailedUpload,
	recordFailedUpload,
	recordPendingUpload,
} from "./failed-uploads.js";
import {
	type PendingReconcileEnvironment,
	reconcilePendingUploads,
} from "./pending-upload-reconcile.js";
import type { UploadResult } from "./types.js";

/**
 * Make hook upload failures durable and surface destination refusals without
 * interfering with the agent's session. Uploads the server accepted but had
 * not finished are recorded as pending, not failed, and stay silent.
 */
export async function reportHookUploadFailure(
	logger: Logger,
	result: UploadResult,
	failure: Omit<FailedUpload, "error" | "failedAt" | "status">,
): Promise<undefined | Error> {
	if (result.pendingJobId !== undefined) {
		logger.info(
			"Upload for session {sessionId} is still processing on the server (job {jobId}); it will be reconciled later",
			{ jobId: result.pendingJobId, sessionId: failure.sessionId },
		);
		await recordPendingUpload({
			...failure,
			error: result.error ?? "Still processing on the server",
			jobId: result.pendingJobId,
			uploadBytes: result.uploadBytes,
		});
		return;
	}

	const uploadError = result.error ?? "Unknown error";
	logger.error("Upload failed for session {sessionId}: {error}", {
		sessionId: failure.sessionId,
		error: uploadError,
	});

	const disposition = result.retryable === false ? "permanent" : "retryable";
	const verb = result.endpointRejected ? "refused" : "failed";
	process.stderr.write(
		`Opaline hook upload ${verb} for session ${failure.sessionId} [${disposition}]: ${uploadError}\n`,
	);

	await recordFailedUpload({
		...failure,
		error: uploadError,
		failureKind: result.failureKind,
		status: disposition,
		uploadBytes: result.uploadBytes,
	});

	if (result.endpointRejected) {
		return new Error(uploadError);
	}
}

/** Hooks wait this many 1 s status polls before leaving a job to reconciliation. */
export const HOOK_R2_STATUS_MAX_POLLS = 10;
const HOOK_PENDING_RECONCILE_MAX_ENTRIES = 3;

/**
 * Cheap, bounded check of a few uploads still processing on the server.
 * Never fails the hook.
 */
export async function reconcilePendingUploadsInHook(
	logger: Logger,
	environment: PendingReconcileEnvironment,
): Promise<void> {
	try {
		const summary = await reconcilePendingUploads(
			{ maxEntries: HOOK_PENDING_RECONCILE_MAX_ENTRIES },
			environment,
		);
		for (const failure of summary.linkFailures)
			process.stderr.write(`Opaline analysis upload failed for ${failure}\n`);
		if (summary.checked > 0)
			logger.info(
				"Reconciled {checked} pending upload(s): {completed} completed, {stillPending} still processing, {requeued} requeued, {failed} failed",
				{
					checked: summary.checked,
					completed: summary.completed,
					failed: summary.failed,
					requeued: summary.requeued,
					stillPending: summary.stillPending,
				},
			);
	} catch (error) {
		logger.warn("Pending upload reconciliation skipped: {error}", {
			error: error instanceof Error ? error.message : String(error),
		});
	}
}
