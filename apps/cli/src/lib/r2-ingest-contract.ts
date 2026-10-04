import type { Client, ORPCError } from "@orpc/client";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { IngestSessionInput } from "../contracts/index.js";
import type { RedactionCounts } from "../internal/secret-filter/index.js";

export const R2_INGEST_PROTOCOL = "r2_multipart_v1" as const;
export const R2_INGEST_PART_SIZE_BYTES = 8 * 1024 * 1024;

export type R2IngestMetadata = Omit<
	IngestSessionInput,
	"content" | "subagents"
>;

interface R2IngestObjectBase {
	readonly byteLength: number;
	readonly sha256: string;
}

export interface R2IngestMainObjectInput extends R2IngestObjectBase {
	readonly kind: "main";
}

export interface R2IngestSubagentObjectInput extends R2IngestObjectBase {
	readonly agentId: string;
	readonly kind: "subagent";
}

export type R2IngestObjectInput =
	| R2IngestMainObjectInput
	| R2IngestSubagentObjectInput;

export interface R2IngestInitInput extends R2IngestMetadata {
	readonly objects: readonly R2IngestObjectInput[];
}

export interface R2IngestUploadPart {
	readonly byteLength: number;
	readonly headers: { readonly "Content-Length": string };
	readonly partNumber: number;
	readonly uploadUrl: string;
}

interface R2IngestUploadObjectBase extends R2IngestObjectBase {
	readonly objectKey: string;
	readonly parts: readonly R2IngestUploadPart[];
	readonly uploadId: string;
}

export interface R2IngestMainUploadObject extends R2IngestUploadObjectBase {
	readonly kind: "main";
}

export interface R2IngestSubagentUploadObject extends R2IngestUploadObjectBase {
	readonly agentId: string;
	readonly kind: "subagent";
}

export type R2IngestUploadObject =
	| R2IngestMainUploadObject
	| R2IngestSubagentUploadObject;

export interface R2IngestInitOutput {
	readonly expiresAt: string;
	readonly jobId: string;
	readonly objects: readonly R2IngestUploadObject[];
	readonly partSizeBytes: typeof R2_INGEST_PART_SIZE_BYTES;
	readonly protocol: typeof R2_INGEST_PROTOCOL;
}

export interface R2IngestCompletedPart {
	readonly etag: string;
	readonly partNumber: number;
}

export interface R2IngestCompletedObject {
	readonly objectKey: string;
	readonly parts: readonly R2IngestCompletedPart[];
	readonly uploadId: string;
}

export interface R2IngestCommitInput {
	readonly jobId: string;
	readonly objects: readonly R2IngestCompletedObject[];
}

export interface R2IngestSuccess {
	readonly success: true;
	readonly sessionId: string;
	readonly analysisId?: string;
	readonly upgradeHint:
		| { readonly protocol: typeof R2_INGEST_PROTOCOL }
		| undefined;
	readonly redacted: RedactionCounts | undefined;
	readonly redactedBytes: number | undefined;
	readonly usageChecksum: string | undefined;
}

export interface R2IngestCommitOutput {
	readonly jobId: string;
	readonly protocol: typeof R2_INGEST_PROTOCOL;
	readonly result: R2IngestSuccess;
	readonly status: "completed";
}

export type R2IngestJobStatus = "pending" | "running" | "completed" | "failed";

export interface R2IngestStatusOutput {
	readonly attempts: number;
	readonly availableAt: string;
	readonly error: { readonly code: string; readonly message: string } | null;
	readonly jobId: string;
	readonly leaseExpiresAt: string | null;
	readonly protocol: typeof R2_INGEST_PROTOCOL;
	readonly result: R2IngestSuccess | null;
	readonly status: R2IngestJobStatus;
	readonly updatedAt: string;
}

type R2Procedure<TInput, TOutput> = Client<
	Record<never, never>,
	TInput,
	TOutput,
	ORPCError<string, unknown>
>;

export type R2IngestRpcClient = {
	readonly ingest: {
		readonly commit: R2Procedure<R2IngestCommitInput, R2IngestCommitOutput>;
		readonly init: R2Procedure<R2IngestInitInput, R2IngestInitOutput>;
		readonly status: R2Procedure<
			{ readonly jobId: string },
			R2IngestStatusOutput
		>;
	};
};

export function createR2IngestRpcClient(config: {
	readonly authType: "api-key" | "bearer";
	readonly endpoint: URL;
	readonly token: string;
}): R2IngestRpcClient {
	const headers =
		config.authType === "api-key"
			? { "x-api-key": config.token }
			: { Authorization: `Bearer ${config.token}` };
	const link = new RPCLink({ headers, url: config.endpoint });
	return createORPCClient<R2IngestRpcClient>(link);
}

export function isR2IngestInitOutput(
	value: unknown,
): value is R2IngestInitOutput {
	return (
		isRecord(value) &&
		value.protocol === R2_INGEST_PROTOCOL &&
		value.partSizeBytes === R2_INGEST_PART_SIZE_BYTES &&
		isNonEmptyString(value.expiresAt) &&
		isNonEmptyString(value.jobId) &&
		Array.isArray(value.objects) &&
		value.objects.length > 0 &&
		value.objects.every(isR2IngestUploadObject)
	);
}

export function isR2IngestCommitOutput(
	value: unknown,
): value is R2IngestCommitOutput {
	return (
		isRecord(value) &&
		value.protocol === R2_INGEST_PROTOCOL &&
		value.status === "completed" &&
		isNonEmptyString(value.jobId) &&
		isR2IngestSuccess(value.result)
	);
}

export function isR2IngestStatusOutput(
	value: unknown,
): value is R2IngestStatusOutput {
	return (
		isRecord(value) &&
		value.protocol === R2_INGEST_PROTOCOL &&
		isNonEmptyString(value.jobId) &&
		isNonNegativeInteger(value.attempts) &&
		isNonEmptyString(value.availableAt) &&
		isNonEmptyString(value.updatedAt) &&
		(value.leaseExpiresAt === null || isNonEmptyString(value.leaseExpiresAt)) &&
		isR2IngestJobStatus(value.status) &&
		(value.error === null || isR2IngestStatusError(value.error)) &&
		(value.result === null || isR2IngestSuccess(value.result))
	);
}

export function hasR2IngestUpgradeHint(value: unknown): boolean {
	return (
		isRecord(value) &&
		isRecord(value.upgradeHint) &&
		value.upgradeHint.protocol === R2_INGEST_PROTOCOL
	);
}

function isR2IngestUploadObject(value: unknown): value is R2IngestUploadObject {
	if (
		!isRecord(value) ||
		(value.kind !== "main" && value.kind !== "subagent") ||
		!isPositiveInteger(value.byteLength) ||
		!isSha256(value.sha256) ||
		!isNonEmptyString(value.objectKey) ||
		!isNonEmptyString(value.uploadId) ||
		!Array.isArray(value.parts) ||
		value.parts.length === 0 ||
		!value.parts.every(isR2IngestUploadPart)
	) {
		return false;
	}
	return value.kind === "main" || isNonEmptyString(value.agentId);
}

function isR2IngestUploadPart(value: unknown): value is R2IngestUploadPart {
	return (
		isRecord(value) &&
		isPositiveInteger(value.byteLength) &&
		isPositiveInteger(value.partNumber) &&
		isNonEmptyString(value.uploadUrl) &&
		isRecord(value.headers) &&
		typeof value.headers["Content-Length"] === "string" &&
		/^[1-9][0-9]*$/u.test(value.headers["Content-Length"])
	);
}

function isR2IngestSuccess(value: unknown): value is R2IngestSuccess {
	if (
		!isRecord(value) ||
		value.success !== true ||
		!isNonEmptyString(value.sessionId) ||
		(value.upgradeHint !== undefined &&
			(!isRecord(value.upgradeHint) ||
				value.upgradeHint.protocol !== R2_INGEST_PROTOCOL)) ||
		(value.redacted !== undefined && !isRedactionCounts(value.redacted)) ||
		(value.redactedBytes !== undefined &&
			!isNonNegativeInteger(value.redactedBytes)) ||
		(value.usageChecksum !== undefined && !isSha256(value.usageChecksum)) ||
		(value.analysisId !== undefined && !isNonEmptyString(value.analysisId))
	) {
		return false;
	}
	return true;
}

function isR2IngestStatusError(
	value: unknown,
): value is { readonly code: string; readonly message: string } {
	return (
		isRecord(value) &&
		isNonEmptyString(value.code) &&
		isNonEmptyString(value.message)
	);
}

function isR2IngestJobStatus(value: unknown): value is R2IngestJobStatus {
	return (
		value === "pending" ||
		value === "running" ||
		value === "completed" ||
		value === "failed"
	);
}

function isRedactionCounts(value: unknown): value is RedactionCounts {
	return isRecord(value) && Object.values(value).every(isNonNegativeInteger);
}

function isSha256(value: unknown): value is string {
	return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function isPositiveInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && typeof value === "number" && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && typeof value === "number" && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
