import type { RedactionCounts } from "../internal/secret-filter/index.js";
import { PRODUCTION_API_BASE } from "./api-target.js";

export type SessionTag =
	| "research"
	| "new_feature"
	| "bug_fix"
	| "refactoring"
	| "documentation"
	| "tests"
	| "other";

export const SESSION_TAGS: readonly SessionTag[] = [
	"research",
	"new_feature",
	"bug_fix",
	"refactoring",
	"documentation",
	"tests",
	"other",
] as const;

export interface UploadTransferProgress {
	phase: "uploading" | "processing";
	uploadedBytes: number | undefined;
	totalBytes: number;
}

export interface UploadResult {
	success: boolean;
	totalBytes?: number;
	maxBytes?: number;
	/**
	 * Slimmed, filtered size of the session when this attempt measured it, on
	 * retryable failures and pending uploads. Failed uploads keep it so
	 * retries can order sessions by what is sent.
	 */
	uploadBytes?: number;
	status?: number;
	error?: string;
	attempts?: number;
	rateLimited?: boolean;
	/** Whether a failed upload belongs in the durable retry queue. */
	retryable?: boolean;
	failureKind?: "json-integrity" | "session-shrink-rejected";
	redacted?: RedactionCounts;
	redactedBytes?: number;
	redactionBudgetExceeded?: boolean;
	redactionConvergenceExceeded?: boolean;
	endpointRejected?: boolean;
	usageChecksum?: string;
	/**
	 * The server accepted the upload but was still processing it when local
	 * polling ended. Not a failure: reconcile later with `ingest.status`.
	 */
	pendingJobId?: string;
	/** The server stored an analysis upload without confirming its link. */
	analysisLinkMissing?: boolean;
	/** The server refused the analysis id (unknown, not visible, log off). */
	analysisRejected?: boolean;
}

export const DEFAULT_ENDPOINT = `${PRODUCTION_API_BASE}/rpc`;
