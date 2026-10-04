import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Source, SourceSchema } from "../contracts/index.js";
import {
	ensurePrivateFile,
	getConfigDir,
	writePrivateFile,
} from "./local-state.js";

// Resolved per call, not at module load: config-directory environment
// overrides must work when set after import (Bun
// snapshots homedir() at process start, so a load-time constant would pin the
// real home directory for the life of the process).
function getFailedUploadsPath(): string {
	return join(getConfigDir(), "failed-uploads.json");
}

/**
 * One locally tracked upload that has not been confirmed by the server.
 * `pending` entries were accepted (R2 job id kept) but not yet finished when
 * the CLI stopped polling; they are reconciled with `ingest.status`, never
 * re-uploaded or reported as failed while the server still works on them.
 */
export interface FailedUpload {
	sessionId: string;
	transcriptPath: string;
	projectPath: string;
	source?: Source;
	organizationId?: string;
	/** Analysis link to keep on retries (`opaline import --analysis`). */
	analysisId?: string;
	/** Endpoint and account the analysis upload was approved for. */
	analysisDestination?: { endpoint: string; account: string };
	error: string;
	failedAt: string;
	status: "permanent" | "retryable" | "pending";
	failureKind?: "json-integrity" | "session-shrink-rejected";
	/** Server ingest job of a `pending` entry. */
	jobId?: string;
	/** Last reconciliation check of a `pending` entry. */
	checkedAt?: string;
}

export type PendingUploadOutcome =
	| { readonly kind: "completed" }
	| { readonly kind: "still-pending" }
	| {
			readonly kind: "failed";
			readonly error: string;
			readonly status: "permanent" | "retryable";
			/** A completed analysis upload without a confirmed link. */
			readonly analysisLinkMissing?: boolean;
	  };

interface FailedUploadsData {
	failures: FailedUpload[];
}

let mutationQueue: Promise<void> = Promise.resolve();

function normalizeSource(raw: unknown): Source | undefined {
	if (typeof raw !== "string") return undefined;
	const normalized = raw.replace(/-/g, "_");
	const parsed = SourceSchema.safeParse(normalized);
	return parsed.success ? parsed.data : undefined;
}

export async function loadFailedUploads(): Promise<FailedUpload[]> {
	try {
		const path = getFailedUploadsPath();
		if (!existsSync(path)) return [];
		await ensurePrivateFile(path, getConfigDir());
		const data = JSON.parse(readFileSync(path, "utf-8")) as FailedUploadsData;
		return data.failures.map((f) => ({
			...f,
			source: normalizeSource(f.source),
			status: normalizeStatus(f),
		}));
	} catch {
		return [];
	}
}

function normalizeStatus(failure: FailedUpload): FailedUpload["status"] {
	if (failure.status === "permanent") return "permanent";
	if (failure.status === "pending" && typeof failure.jobId === "string")
		return "pending";
	return "retryable";
}

async function saveFailedUploads(failures: FailedUpload[]): Promise<void> {
	try {
		const path = getFailedUploadsPath();
		const data: FailedUploadsData = { failures };
		await writePrivateFile(path, JSON.stringify(data, null, 2), getConfigDir());
	} catch {
		// Best-effort — don't break the upload flow
	}
}

export async function recordFailedUpload(
	failure: Omit<FailedUpload, "failedAt" | "status" | "jobId" | "checkedAt"> & {
		status?: "permanent" | "retryable";
	},
): Promise<void> {
	await enqueueMutation(async () => {
		const failures = await loadFailedUploads();
		const existing = failures.findIndex(
			(f) => f.sessionId === failure.sessionId,
		);
		const entry: FailedUpload = {
			...failure,
			failedAt: new Date().toISOString(),
			status: failure.status ?? "retryable",
		};
		if (existing >= 0) {
			failures[existing] = entry;
		} else {
			failures.push(entry);
		}
		await saveFailedUploads(failures);
	});
}

export async function recordPendingUpload(
	pending: Omit<
		FailedUpload,
		"failedAt" | "status" | "failureKind" | "checkedAt" | "jobId"
	> & { jobId: string },
): Promise<void> {
	await enqueueMutation(async () => {
		const failures = await loadFailedUploads();
		const entry: FailedUpload = {
			...pending,
			failedAt: new Date().toISOString(),
			status: "pending",
		};
		const existing = failures.findIndex(
			(f) => f.sessionId === pending.sessionId,
		);
		if (existing >= 0) failures[existing] = entry;
		else failures.push(entry);
		await saveFailedUploads(failures);
	});
}

/**
 * Apply a reconciliation result, but only to the same pending job: a newer
 * upload of the session may already have replaced or cleared the entry.
 */
export async function settlePendingUpload(
	sessionId: string,
	jobId: string,
	outcome: PendingUploadOutcome,
): Promise<void> {
	await enqueueMutation(async () => {
		const failures = await loadFailedUploads();
		const index = failures.findIndex(
			(f) =>
				f.sessionId === sessionId &&
				f.status === "pending" &&
				f.jobId === jobId,
		);
		const current = failures[index];
		if (!current) return;
		if (outcome.kind === "completed") {
			failures.splice(index, 1);
		} else if (outcome.kind === "still-pending") {
			failures[index] = { ...current, checkedAt: new Date().toISOString() };
		} else {
			const { jobId: _jobId, checkedAt: _checkedAt, ...rest } = current;
			failures[index] = {
				...rest,
				error: outcome.error,
				failedAt: new Date().toISOString(),
				status: outcome.status,
			};
		}
		await saveFailedUploads(failures);
	});
}

export async function removeFailedUpload(sessionId: string): Promise<void> {
	await enqueueMutation(async () => {
		const failures = await loadFailedUploads();
		const filtered = failures.filter((f) => f.sessionId !== sessionId);
		if (filtered.length !== failures.length) {
			await saveFailedUploads(filtered);
		}
	});
}

async function enqueueMutation(operation: () => Promise<void>): Promise<void> {
	const queued = mutationQueue.then(operation, operation);
	mutationQueue = queued.catch(() => {});
	await queued;
}

export function isRetryCandidate(
	failure: FailedUpload,
	forceReplace: boolean,
): boolean {
	if (failure.status === "pending") return false;
	if (failure.status === "retryable") return true;
	if (!forceReplace) return false;
	return (
		failure.failureKind === "session-shrink-rejected" ||
		failure.error.includes("--force-replace")
	);
}
