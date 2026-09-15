import { readFile, stat } from "node:fs/promises";
import { createORPCClient, ORPCError } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ContractRouterClient } from "@orpc/contract";
import {
	type contract,
	INGEST_AGGREGATE_CONTENT_MAX_BYTES,
	INGEST_LIMIT_REASONS,
	type IngestSessionInput,
	parseSafeApiEndpoint,
	REDACTION_BUDGET_EXCEEDED_CODE,
	REDACTION_DID_NOT_CONVERGE_CODE,
	SECRET_FILTER_JSON_INTEGRITY_CODE,
	SESSION_OWNERSHIP_CONFLICT_CODE,
	SESSION_UPLOAD_SHRINK_REJECTED_CODE,
} from "../contracts/index.js";
import {
	type FileBackedUploadRequest,
	isMissingTranscriptTimestampMessage,
} from "../internal/agent-adapters/index.js";
import {
	FILTER_VERSION,
	filterSessionTextFields,
	getRedactionBudgetAnomaly,
	getRedactionCount,
	mergeRedactionCounts,
	type RedactionBudgetAnomaly,
	type RedactionCounts,
	SecretFilterConvergenceError,
	SecretFilterJsonIntegrityError,
	type SessionTextFilterResult,
} from "../internal/secret-filter/index.js";
import { hasR2IngestUpgradeHint } from "./r2-ingest-contract.js";
import type { R2MultipartProgress } from "./r2-multipart-upload.js";
import {
	forgetR2UploadCapability,
	hasAdvertisedR2UploadCapability,
	rememberR2UploadCapability,
} from "./r2-upload-capability.js";
import {
	formatR2UploadFlowError,
	isR2InitUnsupported,
	uploadSessionViaR2,
} from "./r2-upload-flow.js";
import type { UploadResult } from "./types.js";
import { describeUploadEndpointRejection } from "./upload-endpoint.js";

export interface UploadConfig {
	endpoint: string;
	token: string;
	allowInsecureEndpoint: boolean;
	authType?: "bearer" | "api-key";
	maxAggregateBytes?: number;
	onRetry?: (attempt: number, maxAttempts: number, error: string) => void;
	onProgress?: (progress: R2MultipartProgress) => void;
	signal?: AbortSignal;
	r2MultipartBaseDelayMs?: number;
	r2StatusPollIntervalMs?: number;
}

const RETRYABLE_STATUS_CODES = new Set([408, 502, 503, 504]);
const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 1_000;
const LEGACY_MATERIALIZATION_MAX_BYTES = 32 * 1024 * 1024;

interface ErrorData {
	readonly authMessage: string | null;
	readonly actualBytes: number | null;
	readonly code: string | null;
	readonly limit: number | null;
	readonly maxBytes: number | null;
	readonly reason: string | null;
	readonly tryAgainIn: number | null;
	readonly windowSeconds: number | null;
}

type UploadSubagent = NonNullable<IngestSessionInput["subagents"]>[number];
type UploadSessionRequest = FileBackedUploadRequest | IngestSessionInput;

type LegacyUploadPreparation =
	| {
			readonly status: "empty-main";
	  }
	| {
			readonly anomaly: RedactionBudgetAnomaly;
			readonly status: "redaction-budget";
	  }
	| {
			readonly actualBytes: number;
			readonly maxBytes: number;
			readonly status: "legacy-too-large";
	  }
	| {
			readonly actualBytes: number;
			readonly maxBytes: number;
			readonly status: "too-large";
	  }
	| {
			readonly filteredRequest: IngestSessionInput;
			readonly filteredText: SessionTextFilterResult<UploadSubagent>;
			readonly status: "ready";
	  };

export function isRetryableUploadError(error: unknown): boolean {
	if (error instanceof ORPCError) {
		return RETRYABLE_STATUS_CODES.has(error.status);
	}
	return true;
}

function isRateLimited(error: unknown): error is ORPCError<string, unknown> {
	return error instanceof ORPCError && error.status === 429;
}

function isPayloadTooLarge(
	error: unknown,
): error is ORPCError<string, unknown> {
	return error instanceof ORPCError && error.status === 413;
}

function isServerError(error: unknown): error is ORPCError<string, unknown> {
	return (
		error instanceof ORPCError && error.status >= 500 && error.status <= 599
	);
}

function isApiKeyRateLimited(
	error: unknown,
): error is ORPCError<string, unknown> {
	if (!(error instanceof ORPCError)) {
		return false;
	}

	const data = getErrorData(error);
	return (
		data.reason === "api_key_rate_limited" ||
		data.code === "RATE_LIMITED" ||
		(error.status === 429 && data.authMessage !== null)
	);
}

export function getSecretFilterUploadFailure(
	error: unknown,
): UploadResult | null {
	if (error instanceof SecretFilterJsonIntegrityError) {
		return {
			success: false,
			error:
				"Redaction safety check stopped upload because filtering could not preserve transcript JSON integrity. The filtered transcript was not uploaded.",
			attempts: 0,
			failureKind: "json-integrity",
			retryable: false,
		};
	}
	if (error instanceof SecretFilterConvergenceError) {
		return {
			success: false,
			error:
				"Redaction safety check stopped upload because known-pattern filtering did not converge. The unfiltered transcript was not uploaded.",
			attempts: 0,
			redactionConvergenceExceeded: true,
			retryable: false,
		};
	}
	return null;
}

export function formatUploadError(error: unknown): string {
	if (isApiKeyRateLimited(error)) {
		const data = getErrorData(error);
		const wait = data.tryAgainIn
			? ` Wait about ${formatWait(data.tryAgainIn)} before retrying, or run \`opaline login\` to create a fresh ingest key.`
			: " Run `opaline login` to create a fresh ingest key, or wait for the key's rate-limit window to reset.";
		return `API key rate limit reached.${wait}`;
	}

	if (isRateLimited(error)) {
		const data = getErrorData(error);
		const isRequestLimit = data.reason === INGEST_LIMIT_REASONS.requestLimit;
		if (isRequestLimit || data.reason === INGEST_LIMIT_REASONS.byteLimit) {
			const limit =
				data.limit === null
					? null
					: isRequestLimit
						? `${data.limit} requests`
						: `${formatMebibytes(data.limit)} MiB`;
			const detail =
				limit && data.windowSeconds
					? ` (${limit} per ${Math.round(data.windowSeconds / 60)} min)`
					: "";
			const kind = isRequestLimit ? "request" : "byte";
			return `Ingest ${kind} limit reached${detail}. Wait and retry with: opaline upload --retry`;
		}
		const windowMin = data?.windowSeconds
			? Math.round(data.windowSeconds / 60)
			: 60;
		const limit = data?.limit ?? "unknown";
		return `Rate limit reached (${limit} sessions per ${windowMin} min). Wait and retry with: opaline upload --retry`;
	}
	if (
		error instanceof ORPCError &&
		error.code === SESSION_OWNERSHIP_CONFLICT_CODE
	) {
		return "This session ID is already owned by another organization member. Upload it from the original member account or use a different session ID.";
	}
	if (
		error instanceof ORPCError &&
		error.code === SESSION_UPLOAD_SHRINK_REJECTED_CODE
	) {
		return "Opaline refused this upload because it is smaller than the stored session. Check that the transcript is complete, then run `opaline upload <session> --force-replace` only if the replacement is intentional. If this CLI does not recognize the flag, upgrade your Opaline CLI installation first.";
	}
	if (
		error instanceof ORPCError &&
		error.code === REDACTION_BUDGET_EXCEEDED_CODE
	) {
		const data = getRedactionBudgetErrorData(error);
		return data
			? formatRedactionBudgetError(data)
			: "Redaction safety check stopped upload because known-pattern redaction exceeded the 20% transcript budget. The unfiltered transcript was not uploaded.";
	}
	if (
		error instanceof ORPCError &&
		error.code === REDACTION_DID_NOT_CONVERGE_CODE
	) {
		return "Redaction safety check stopped upload because known-pattern filtering did not converge. The unfiltered transcript was not uploaded.";
	}
	if (
		error instanceof ORPCError &&
		error.code === SECRET_FILTER_JSON_INTEGRITY_CODE
	) {
		return "Redaction safety check stopped upload because filtering could not preserve transcript JSON integrity. The filtered transcript was not uploaded.";
	}
	if (isPayloadTooLarge(error)) {
		const data = getErrorData(error);
		if (data.reason === INGEST_LIMIT_REASONS.transcriptTooLarge) {
			return formatTranscriptTooLargeError(data.actualBytes, data.maxBytes);
		}
		return formatPayloadTooLargeError(error);
	}
	if (isServerError(error)) {
		return formatServerUploadError(error);
	}
	if (error instanceof ORPCError) {
		return `${error.status} ${error.message}`;
	}
	const message = error instanceof Error ? error.message : "connection failed";
	return `Network error while contacting Opaline API: ${message}. Check your connection and retry with: opaline upload --retry`;
}

function formatPayloadTooLargeError(error: ORPCError<string, unknown>): string {
	const status = `${error.status} ${error.message}`;
	const detail = getPayloadTooLargeDetail(error);
	const detailText = detail ? ` ${detail}` : "";
	return `Upload request is too large (${status}).${detailText} This is a request-size limit, not an auth or proxy issue. This session will keep failing until its transcript/subagent payload is smaller; other failed sessions can still be retried with: opaline upload --retry`;
}

function formatServerUploadError(error: ORPCError<string, unknown>): string {
	const status = `${error.status} ${error.message}`;
	if (RETRYABLE_STATUS_CODES.has(error.status)) {
		return `Temporary Opaline server/proxy error (${status}). The CLI retries these automatically; retry remaining failed uploads with: opaline upload --retry`;
	}

	return `Opaline server error (${status}). This is not an auth problem. Retry later with: opaline upload --retry; if it repeats, share this status with the Opaline team.`;
}

function getPayloadTooLargeDetail(
	error: ORPCError<string, unknown>,
): string | null {
	const data = isRecord(error.data) ? error.data : null;
	const bodyValue = data?.body;
	const body = isRecord(bodyValue) ? bodyValue : null;
	return getStringField(body, "error") ?? getStringField(data, "error");
}

function getErrorData(error: ORPCError<string, unknown>): ErrorData {
	const data = isRecord(error.data) ? error.data : null;
	return {
		authMessage: getStringField(data, "authMessage"),
		actualBytes: getNumberField(data, "actualBytes"),
		code: getStringField(data, "code"),
		limit: getNumberField(data, "limit"),
		maxBytes: getNumberField(data, "maxBytes"),
		reason: getStringField(data, "reason"),
		tryAgainIn: getNumberField(data, "tryAgainIn"),
		windowSeconds: getNumberField(data, "windowSeconds"),
	};
}

function getRedactionBudgetErrorData(
	error: ORPCError<string, unknown>,
): RedactionBudgetAnomaly | null {
	const data = isRecord(error.data) ? error.data : null;
	const inputBytes = getNumberField(data, "inputBytes");
	const redactedBytes = getNumberField(data, "redactedBytes");
	const ruleIdsValue = data?.ruleIds;
	if (
		inputBytes === null ||
		redactedBytes === null ||
		!Array.isArray(ruleIdsValue) ||
		!ruleIdsValue.every((ruleId) => typeof ruleId === "string")
	) {
		return null;
	}
	return { inputBytes, redactedBytes, ruleIds: ruleIdsValue };
}

function getStringField(record: Record<string, unknown> | null, key: string) {
	const value = record?.[key];
	return typeof value === "string" && value.length > 0 ? value : null;
}

function getNumberField(record: Record<string, unknown> | null, key: string) {
	const value = record?.[key];
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function formatWait(milliseconds: number) {
	const seconds = Math.ceil(milliseconds / 1000);
	if (seconds < 60) {
		return `${seconds}s`;
	}

	const minutes = Math.ceil(seconds / 60);
	if (minutes < 60) {
		return `${minutes} min`;
	}

	const hours = Math.ceil(minutes / 60);
	return `${hours} hr`;
}

/**
 * Upload a session transcript to the backend via oRPC.
 * Retries on transport errors and transient statuses (408, 502, 503, 504)
 * with exponential backoff.
 * Rate limit errors (429) are not retried — the window is too long.
 */
export async function uploadSession(
	request: UploadSessionRequest,
	config: UploadConfig,
): Promise<UploadResult> {
	config.signal?.throwIfAborted();
	const maxAggregateBytes =
		config.maxAggregateBytes ?? INGEST_AGGREGATE_CONTENT_MAX_BYTES;
	const endpoint = parseSafeApiEndpoint(config.endpoint, {
		allowPlaintext: config.allowInsecureEndpoint,
	});
	if (!endpoint.ok) {
		return {
			success: false,
			error: `Upload endpoint refused: ${describeUploadEndpointRejection(endpoint)}`,
			attempts: 0,
			endpointRejected: true,
			retryable: false,
		};
	}

	const link = new RPCLink({
		url: endpoint.url,
		headers:
			config.authType === "api-key"
				? { "x-api-key": config.token }
				: { Authorization: `Bearer ${config.token}` },
	});

	const client: ContractRouterClient<typeof contract> = createORPCClient(link);
	const authType = config.authType ?? "bearer";
	const endpointUrl = new URL(endpoint.url);
	const shouldProbeR2 =
		authType === "api-key" &&
		(hasAdvertisedR2UploadCapability(endpointUrl, authType, config.token) ||
			(await exceedsLegacyMaterializationLimit(request)));
	if (authType === "api-key" && shouldProbeR2) {
		try {
			const r2Result = await uploadSessionViaR2(request, {
				authType,
				endpoint: endpointUrl,
				maxAggregateBytes,
				multipartBaseDelayMs: config.r2MultipartBaseDelayMs,
				onProgress: config.onProgress,
				onRetry: config.onRetry,
				statusPollIntervalMs: config.r2StatusPollIntervalMs,
				token: config.token,
			});
			if (r2Result.status === "redaction-budget") {
				return {
					success: false,
					error: formatRedactionBudgetError(r2Result.anomaly),
					attempts: 0,
					redactionBudgetExceeded: true,
					retryable: false,
				};
			}
			if (r2Result.status === "empty-main") {
				return getEmptyMainUploadFailure();
			}
			if (r2Result.status === "too-large") {
				return {
					success: false,
					error: formatTranscriptTooLargeError(
						r2Result.actualBytes,
						r2Result.maxBytes,
					),
					attempts: 0,
					retryable: false,
				};
			}
			return {
				success: true,
				status: 200,
				attempts: r2Result.attempts,
				redacted: r2Result.redactions,
				redactedBytes: r2Result.redactedBytes,
				usageChecksum: r2Result.result.usageChecksum,
			};
		} catch (error) {
			const filterFailure = getSecretFilterUploadFailure(error);
			if (filterFailure) return filterFailure;
			if (isR2InitUnsupported(error)) {
				await forgetR2UploadCapability(endpointUrl, authType, config.token);
			} else {
				const failure = formatR2UploadFlowError(error);
				return {
					success: false,
					error: failure.message,
					attempts: MAX_ATTEMPTS,
					retryable: failure.retryable,
				};
			}
		}
	}

	let legacy: LegacyUploadPreparation;
	try {
		legacy = await prepareLegacyUpload(request, maxAggregateBytes);
	} catch (error) {
		const filterFailure = getSecretFilterUploadFailure(error);
		if (filterFailure) return filterFailure;
		throw error;
	}
	if (legacy.status === "redaction-budget") {
		return {
			success: false,
			error: formatRedactionBudgetError(legacy.anomaly),
			attempts: 0,
			redactionBudgetExceeded: true,
			retryable: false,
		};
	}
	if (legacy.status === "empty-main") {
		return getEmptyMainUploadFailure();
	}
	if (legacy.status === "legacy-too-large") {
		return {
			success: false,
			error: formatLegacyServerTooLargeError(
				legacy.actualBytes,
				legacy.maxBytes,
			),
			attempts: 0,
			retryable: false,
		};
	}
	if (legacy.status === "too-large") {
		return {
			success: false,
			error: formatTranscriptTooLargeError(legacy.actualBytes, legacy.maxBytes),
			attempts: 0,
			retryable: false,
		};
	}
	const { filteredRequest, filteredText } = legacy;

	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		config.signal?.throwIfAborted();
		try {
			const response: unknown = await client.ingestSession(filteredRequest);
			// A proxy or SSO gateway can answer 200 with an HTML page or arbitrary
			// JSON. oRPC deserializes those to strings/undefined rather than
			// throwing, so without this guard a dropped upload reports success.
			if (!isIngestSessionResponse(response)) {
				return {
					success: false,
					error: formatUnrecognizedResponseError(),
					attempts: attempt,
					retryable: false,
				};
			}
			if (authType === "api-key" && hasR2IngestUpgradeHint(response)) {
				await rememberR2UploadCapability(endpointUrl, authType, config.token);
			}
			return {
				success: true,
				status: 200,
				attempts: attempt,
				redacted: mergeRedactionCounts(
					filteredText.counts,
					response.redacted ?? {},
				),
				redactedBytes:
					filteredText.redactedBytes + (response.redactedBytes ?? 0),
				usageChecksum: response.usageChecksum,
			};
		} catch (error) {
			if (
				error instanceof ORPCError &&
				error.status === 400 &&
				isMissingTranscriptTimestampMessage(
					filteredRequest.source,
					error.message,
				)
			) {
				return {
					success: false,
					error: error.message,
					attempts: attempt,
					retryable: false,
				};
			}
			if (
				error instanceof ORPCError &&
				error.code === SESSION_UPLOAD_SHRINK_REJECTED_CODE
			) {
				return {
					success: false,
					error: formatUploadError(error),
					attempts: attempt,
					failureKind: "session-shrink-rejected",
					retryable: false,
				};
			}
			if (
				error instanceof ORPCError &&
				error.code === SECRET_FILTER_JSON_INTEGRITY_CODE
			) {
				return {
					success: false,
					error: formatUploadError(error),
					attempts: attempt,
					failureKind: "json-integrity",
					retryable: false,
				};
			}

			const errorMessage = formatUploadError(error);

			if (isRateLimited(error) || isApiKeyRateLimited(error)) {
				return {
					success: false,
					error: errorMessage,
					attempts: attempt,
					rateLimited: true,
					retryable: true,
				};
			}

			if (isRetryableUploadError(error) && attempt < MAX_ATTEMPTS) {
				config.onRetry?.(attempt, MAX_ATTEMPTS, errorMessage);
				const delay = BASE_DELAY_MS * 2 ** (attempt - 1);
				await new Promise((resolve) => setTimeout(resolve, delay));
				continue;
			}

			return {
				success: false,
				error: errorMessage,
				attempts: attempt,
				retryable: isRetryableUploadError(error) || isServerError(error),
			};
		}
	}

	return {
		success: false,
		error: "Max retries exceeded",
		attempts: MAX_ATTEMPTS,
		retryable: true,
	};
}

async function prepareLegacyUpload(
	request: UploadSessionRequest,
	maxAggregateBytes: number,
): Promise<LegacyUploadPreparation> {
	if (isFileBackedUploadRequest(request)) {
		const sourceBytes = await getFileBackedAggregateBytes(request);
		if (sourceBytes > LEGACY_MATERIALIZATION_MAX_BYTES) {
			return {
				actualBytes: sourceBytes,
				maxBytes: LEGACY_MATERIALIZATION_MAX_BYTES,
				status: "legacy-too-large",
			};
		}
	}
	const materialized = await materializeLegacyUploadRequest(request);
	const inputBytes = getUploadAggregateBytes(materialized);
	const filteredText = filterSessionTextFields({
		content: materialized.content,
		subagents: materialized.subagents,
	});
	if (Buffer.byteLength(filteredText.content, "utf8") === 0) {
		return { status: "empty-main" };
	}
	const anomaly = getRedactionBudgetAnomaly(
		filteredText.redactedBytes,
		inputBytes,
		filteredText.counts,
	);
	if (anomaly) return { anomaly, status: "redaction-budget" };
	const nonEmptySubagents = filteredText.subagents?.filter(
		(subagent) => Buffer.byteLength(subagent.content, "utf8") > 0,
	);
	const filteredRequest: IngestSessionInput = {
		...materialized,
		content: filteredText.content,
		subagents:
			nonEmptySubagents && nonEmptySubagents.length > 0
				? [...nonEmptySubagents]
				: undefined,
		filter_version: FILTER_VERSION,
	};
	const aggregateBytes = getUploadAggregateBytes(filteredRequest);
	if (aggregateBytes > maxAggregateBytes) {
		return {
			actualBytes: aggregateBytes,
			maxBytes: maxAggregateBytes,
			status: "too-large",
		};
	}
	return { filteredRequest, filteredText, status: "ready" };
}

async function getFileBackedAggregateBytes(
	request: FileBackedUploadRequest,
): Promise<number> {
	const files = await Promise.all([
		stat(request.transcriptPath),
		...request.subagents.map((subagent) => stat(subagent.path)),
	]);
	return files.reduce((total, file) => total + file.size, 0);
}

async function exceedsLegacyMaterializationLimit(
	request: UploadSessionRequest,
): Promise<boolean> {
	if (!isFileBackedUploadRequest(request)) return false;
	return (
		(await getFileBackedAggregateBytes(request)) >
		LEGACY_MATERIALIZATION_MAX_BYTES
	);
}

async function materializeLegacyUploadRequest(
	request: UploadSessionRequest,
): Promise<IngestSessionInput> {
	if (!isFileBackedUploadRequest(request)) return request;
	const content = await readFile(request.transcriptPath, "utf8");
	const subagents: UploadSubagent[] = [];
	for (const subagent of request.subagents) {
		subagents.push({
			agentId: subagent.agentId,
			content: await readFile(subagent.path, "utf8"),
		});
	}
	return {
		...request.metadata,
		content,
		subagents: subagents.length > 0 ? subagents : undefined,
	};
}

function isFileBackedUploadRequest(
	request: UploadSessionRequest,
): request is FileBackedUploadRequest {
	return "kind" in request && request.kind === "file";
}

function getEmptyMainUploadFailure(): UploadResult {
	return {
		success: false,
		error: "The main session transcript is empty. Nothing was uploaded.",
		attempts: 0,
		retryable: false,
	};
}

export function formatRedactionSummary(
	counts: RedactionCounts | undefined,
	redactedBytes: number | undefined,
): string | null {
	if (!counts) {
		return null;
	}

	const total = getRedactionCount(counts);
	if (total === 0) {
		return null;
	}

	const details = Object.entries(counts)
		.filter(([, count]) => count > 0)
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([ruleId, count]) => `${ruleId} ×${count}`)
		.join(", ");
	const subject = total === 1 ? "value" : "values";
	const verb = total === 1 ? "was" : "were";
	const byteDetail =
		redactedBytes === undefined ? "" : `, ${formatBytes(redactedBytes)}`;
	return `${total} ${subject} matching known secret patterns ${verb} redacted (${details}${byteDetail}).`;
}

export function formatRedactionBudgetError(
	anomaly: RedactionBudgetAnomaly,
): string {
	const ratio = ((anomaly.redactedBytes / anomaly.inputBytes) * 100).toFixed(1);
	const rules = anomaly.ruleIds.join(", ");
	return `Redaction safety check stopped upload: known-pattern redaction would replace ${formatBytes(anomaly.redactedBytes)} of ${formatBytes(anomaly.inputBytes)} (${ratio}%), above the 20% transcript budget (${rules}). The unfiltered transcript was not uploaded.`;
}

interface IngestSessionResponse {
	readonly success: true;
	readonly sessionId: string;
	readonly upgradeHint?: { readonly protocol: "r2_multipart_v1" };
	readonly redacted?: RedactionCounts;
	readonly redactedBytes?: number;
	readonly usageChecksum?: string;
}

// success + sessionId is the floor every deployed API version returns; redacted
// and redactedBytes only exist on filtering servers, so their absence must not
// fail a response from an older API.
function isIngestSessionResponse(
	value: unknown,
): value is IngestSessionResponse {
	if (!isRecord(value) || value.success !== true) {
		return false;
	}
	if (typeof value.sessionId !== "string") {
		return false;
	}
	if (value.redacted !== undefined && !isRecord(value.redacted)) {
		return false;
	}
	if (
		value.usageChecksum !== undefined &&
		(typeof value.usageChecksum !== "string" ||
			!/^[a-f0-9]{64}$/u.test(value.usageChecksum))
	) {
		return false;
	}
	return (
		value.redactedBytes === undefined || typeof value.redactedBytes === "number"
	);
}

function formatUnrecognizedResponseError(): string {
	return "Opaline API returned an unrecognized response instead of an ingest confirmation, so this upload cannot be verified and was treated as failed. This usually means a proxy, SSO gateway, or wrong endpoint URL answered instead of the Opaline API. Check the endpoint and retry with: opaline upload --retry";
}

function getUploadAggregateBytes(request: IngestSessionInput): number {
	return (
		Buffer.byteLength(request.content, "utf8") +
		(request.subagents ?? []).reduce(
			(total, subagent) => total + Buffer.byteLength(subagent.content, "utf8"),
			0,
		)
	);
}

function formatTranscriptTooLargeError(
	actualBytes: number | null,
	maxBytes: number | null,
): string {
	if (actualBytes === null || maxBytes === null) {
		return "Session transcript payload exceeds the per-session limit. Reduce the transcript/subagent payload before retrying.";
	}

	const actualText = `${formatMebibytes(actualBytes)} MiB`;
	const limitText = `the ${formatMebibytes(maxBytes)} MiB per-session limit`;
	return `Session transcript payload is ${actualText}, above ${limitText}. Reduce the transcript/subagent payload before retrying.`;
}

function formatLegacyServerTooLargeError(
	actualBytes: number,
	maxBytes: number,
): string {
	return `Transcript too large for this server: the ${formatMebibytes(actualBytes)} MiB transcript/subagent payload exceeds the CLI's ${formatMebibytes(maxBytes)} MiB safe limit for legacy uploads. Upgrade the Opaline server to one that supports direct R2 uploads, or upload a smaller transcript.`;
}

function formatMebibytes(bytes: number): string {
	return (bytes / (1024 * 1024)).toFixed(2);
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) {
		return `${bytes} B`;
	}
	if (bytes < 1024 * 1024) {
		return `${(bytes / 1024).toFixed(1)} KB`;
	}
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
