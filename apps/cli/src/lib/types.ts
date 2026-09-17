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
}

export const DEFAULT_ENDPOINT = `${PRODUCTION_API_BASE}/rpc`;
