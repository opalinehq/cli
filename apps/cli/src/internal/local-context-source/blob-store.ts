import { createHash } from "node:crypto";
import {
	FILTER_VERSION,
	filterKnownSecrets,
	getRedactionBudgetAnomaly,
} from "../secret-filter/index.js";
import type {
	ContextBlob,
	ParentCaptureReference,
	SecretFilterMetadata,
} from "./types.js";

const UTF8_ENCODER = new TextEncoder();

export interface BlobStore {
	readonly blobs: Map<string, ContextBlob>;
	readonly parentBlobIds: ReadonlySet<string>;
	readonly parentCaptureId: string | null;
	readonly maxBlobs: number;
	readonly maxBytes: number;
	materializedBytes: number;
}

export type SanitizedBlobResult =
	| {
			readonly status: "available";
			readonly blobId: string;
			readonly sourceByteLength: number;
			readonly storedByteLength: number;
			readonly secretFilter: SecretFilterMetadata;
			readonly reused: boolean;
	  }
	| {
			readonly status: "failure";
			readonly reason:
				| "secret-filter-failure"
				| "secret-filter-budget"
				| "blob-count-cap"
				| "total-content-cap";
			readonly detail: string;
	  };

export function createBlobStore(
	parentCapture: ParentCaptureReference | null,
	maxBlobs: number,
	maxBytes = Number.POSITIVE_INFINITY,
): BlobStore {
	return {
		blobs: new Map(),
		parentBlobIds: new Set(parentCapture?.blobIds ?? []),
		parentCaptureId: parentCapture?.id ?? null,
		maxBlobs,
		maxBytes,
		materializedBytes: 0,
	};
}

export function addSanitizedTextBlob(
	text: string,
	sourceByteLength: number,
	store: BlobStore,
): SanitizedBlobResult {
	try {
		const filtered = filterKnownSecrets(text);
		const anomaly = getRedactionBudgetAnomaly(
			filtered.redactedBytes,
			sourceByteLength,
			filtered.counts,
		);
		if (anomaly !== null) {
			return {
				status: "failure",
				reason: "secret-filter-budget",
				detail: `Secret redaction exceeded the safety budget for rules: ${anomaly.ruleIds.join(", ")}`,
			};
		}

		const bytes = UTF8_ENCODER.encode(filtered.text);
		const digest = createHash("sha256").update(bytes).digest("hex");
		const blobId = `sha256:${digest}`;
		const reused = store.parentBlobIds.has(blobId);
		if (!reused && !store.blobs.has(blobId)) {
			if (store.blobs.size >= store.maxBlobs)
				return {
					status: "failure",
					reason: "blob-count-cap",
					detail:
						"Context blob omitted to reserve protocol object-count headroom.",
				};
			if (store.materializedBytes + bytes.byteLength > store.maxBytes) {
				return {
					status: "failure",
					reason: "total-content-cap",
					detail: "Context blob omitted to bound capture bytes.",
				};
			}
			store.materializedBytes += bytes.byteLength;
			store.blobs.set(blobId, {
				id: blobId,
				algorithm: "sha256",
				byteLength: bytes.byteLength,
				encoding: "utf-8",
				content: filtered.text,
			});
		}
		return {
			status: "available",
			blobId,
			sourceByteLength,
			storedByteLength: bytes.byteLength,
			secretFilter: {
				filterVersion: FILTER_VERSION,
				counts: sortNumberRecord(filtered.counts),
				redactedBytes: filtered.redactedBytes,
			},
			reused,
		};
	} catch (error) {
		return {
			status: "failure",
			reason: "secret-filter-failure",
			detail: getErrorMessage(error),
		};
	}
}

export function getSortedBlobs(store: BlobStore): readonly ContextBlob[] {
	return [...store.blobs.values()].sort((left, right) =>
		left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
	);
}

function sortNumberRecord(
	record: Readonly<Record<string, number>>,
): Readonly<Record<string, number>> {
	return Object.fromEntries(
		Object.entries(record).sort(([left], [right]) =>
			left < right ? -1 : left > right ? 1 : 0,
		),
	);
}

function getErrorMessage(error: unknown): string {
	return error instanceof Error
		? error.message
		: "Unknown secret filter failure";
}
