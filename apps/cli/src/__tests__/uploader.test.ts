import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ORPCError } from "@orpc/client";
import {
	INGEST_AGGREGATE_CONTENT_MAX_BYTES,
	INGEST_LIMIT_REASONS,
	type IngestSessionInput,
	REDACTION_DID_NOT_CONVERGE_CODE,
	SECRET_FILTER_JSON_INTEGRITY_CODE,
	SESSION_OWNERSHIP_CONFLICT_CODE,
	SESSION_UPLOAD_SHRINK_REJECTED_CODE,
} from "../contracts/index.js";
import {
	SecretFilterConvergenceError,
	SecretFilterJsonIntegrityError,
} from "../internal/secret-filter/index.js";
import {
	formatRedactionSummary,
	formatUploadError,
	getSecretFilterUploadFailure,
	getUploadSizeFailure,
	isRetryableUploadError,
	uploadSession,
} from "../lib/uploader.js";
import {
	INGEST_STUB_TEST_TOKEN,
	startIngestStub,
} from "./helpers/ingest-stub.js";

describe("formatUploadError", () => {
	test("explains API key rate limits from ingest auth", () => {
		const error = new ORPCError("TOO_MANY_REQUESTS", {
			message: "API key rate limit exceeded",
			data: {
				reason: "api_key_rate_limited",
				code: "RATE_LIMITED",
				authMessage: "Rate limit exceeded",
			},
		});

		expect(formatUploadError(error)).toBe(
			"API key rate limit reached. Run `opaline login` to create a fresh ingest key, or wait for the key's rate-limit window to reset.",
		);
	});

	test("keeps existing session ingest rate limit message", () => {
		const error = new ORPCError("TOO_MANY_REQUESTS", {
			message: "Rate limit exceeded",
			data: {
				limit: 500,
				windowSeconds: 3600,
			},
		});

		expect(formatUploadError(error)).toBe(
			"Rate limit reached (500 sessions per 60 min). Wait and retry with: opaline upload",
		);
	});

	test("explains ingest request limits", () => {
		const error = new ORPCError("TOO_MANY_REQUESTS", {
			data: {
				limit: 15_000,
				reason: INGEST_LIMIT_REASONS.requestLimit,
				windowSeconds: 3600,
			},
		});

		expect(formatUploadError(error)).toBe(
			"Ingest request limit reached (15000 requests per 60 min). Wait and retry with: opaline upload",
		);
	});

	test("explains ingest byte limits", () => {
		const error = new ORPCError("TOO_MANY_REQUESTS", {
			data: {
				limit: 10 * 1024 * 1024 * 1024,
				reason: INGEST_LIMIT_REASONS.byteLimit,
				windowSeconds: 3600,
			},
		});

		expect(formatUploadError(error)).toBe(
			"Ingest byte limit reached (10240.00 MiB per 60 min). Wait and retry with: opaline upload",
		);
	});

	test("keeps plain unauthorized errors unchanged", () => {
		const error = new ORPCError("UNAUTHORIZED");

		expect(formatUploadError(error)).toBe("401 Unauthorized");
	});

	test("explains session ownership conflicts", () => {
		const error = new ORPCError(SESSION_OWNERSHIP_CONFLICT_CODE, {
			status: 409,
		});

		expect(formatUploadError(error)).toBe(
			"This session ID is already owned by another organization member. Upload it from the original member account or use a different session ID.",
		);
	});

	test("makes the intentional smaller-session override explicit", () => {
		const error = new ORPCError(SESSION_UPLOAD_SHRINK_REJECTED_CODE, {
			status: 409,
			data: {
				currentAssistantLineCount: 2,
				currentContentBytes: 50_000,
				previousAssistantLineCount: 4,
				previousContentBytes: 100_000,
			},
		});

		expect(formatUploadError(error)).toContain(
			"opaline upload <session> --force-replace",
		);
	});

	test("explains server-side convergence rejection without exposing content", () => {
		const error = new ORPCError(REDACTION_DID_NOT_CONVERGE_CODE, {
			status: 422,
			data: { maxPasses: 4 },
		});

		expect(formatUploadError(error)).toBe(
			"Redaction safety check stopped upload because known-pattern filtering did not converge. The unfiltered transcript was not uploaded.",
		);
	});

	test("explains oversized upload requests", () => {
		const error = new ORPCError("PAYLOAD_TOO_LARGE", {
			status: 413,
			data: {
				body: {
					error: "Request body too large. Maximum size is 500 MB.",
				},
			},
		});

		expect(formatUploadError(error)).toBe(
			"Upload request is too large (413 Payload Too Large). Request body too large. Maximum size is 500 MB. This is a request-size limit, not an auth or proxy issue. This session will keep failing until its transcript/subagent payload is smaller; other failed sessions can still be retried with: opaline upload",
		);
	});

	test("explains the per-session transcript limit", () => {
		const error = new ORPCError("PAYLOAD_TOO_LARGE", {
			data: {
				actualBytes: 5 * 1024 * 1024,
				maxBytes: 4 * 1024 * 1024,
				reason: INGEST_LIMIT_REASONS.transcriptTooLarge,
			},
		});

		expect(formatUploadError(error)).toBe(
			"Session transcript payload is 5.00 MiB, above the 4.00 MiB per-session limit. Reduce the transcript/subagent payload before retrying.",
		);
	});

	test("explains transient gateway errors", () => {
		const error = new ORPCError("BAD_GATEWAY");

		expect(formatUploadError(error)).toBe(
			"Temporary Opaline server/proxy error (502 Bad Gateway). The CLI retries these automatically; retry remaining failed uploads with: opaline upload",
		);
	});

	test("explains non-retryable server errors", () => {
		const error = new ORPCError("INTERNAL_SERVER_ERROR");

		expect(formatUploadError(error)).toBe(
			"Opaline server error (500 Internal Server Error). This is not an auth problem. Retry later with: opaline upload; if it repeats, share this status with the Opaline team.",
		);
	});

	test("explains network errors", () => {
		const error = new TypeError("fetch failed");

		expect(formatUploadError(error)).toBe(
			"Network error while contacting Opaline API: fetch failed. Check your connection and retry with: opaline upload",
		);
	});
});

describe("isRetryableUploadError", () => {
	test("treats Bun FailedToOpenSocket failures as retryable without a code allowlist", () => {
		const error = Object.assign(new Error("failed to open socket"), {
			code: "FailedToOpenSocket",
		});

		expect(isRetryableUploadError(error)).toBe(true);
	});

	test("keeps permanent RPC responses non-retryable", () => {
		expect(isRetryableUploadError(new ORPCError("BAD_REQUEST"))).toBe(false);
		expect(isRetryableUploadError(new ORPCError("BAD_GATEWAY"))).toBe(true);
	});

	test("keeps mid-write incomplete extraction retryable", () => {
		expect(
			isRetryableUploadError(
				new ORPCError("SERVICE_UNAVAILABLE", {
					data: {
						reason: "usage_extraction_incomplete",
						retryAfterMs: 1_000,
					},
				}),
			),
		).toBe(true);
	});
});

describe("uploadSession aggregate size guard", () => {
	test("rejects an oversized aggregate before making a network attempt", async () => {
		const result = await uploadSession(
			{
				source: "claude_code",
				sessionId: "oversized-test",
				projectPath: "/test/project",
				content: "a".repeat(1024 * 1024),
				subagents: [{ agentId: "subagent", content: "b".repeat(1024 * 1024) }],
			},
			{
				endpoint: "http://127.0.0.1:1/rpc",
				allowInsecureEndpoint: false,
				maxAggregateBytes: 1024 * 1024,
				token: "unused",
			},
		);

		expect(result).toEqual({
			totalBytes: 2 * 1024 * 1024,
			maxBytes: 1024 * 1024,
			success: false,
			error:
				"Skipped: session files total 2.00 MiB, above the 1.00 MiB per-session limit. No upload attempted.",
			attempts: 0,
			retryable: false,
		});
	});

	test("permits the exact size limit and skips one byte above it", () => {
		const limit = INGEST_AGGREGATE_CONTENT_MAX_BYTES;
		expect(getUploadSizeFailure(limit)).toBeUndefined();
		expect(getUploadSizeFailure(limit + 1)).toMatchObject({
			success: false,
			totalBytes: limit + 1,
			maxBytes: limit,
			attempts: 0,
			retryable: false,
		});
	});

	for (const authType of ["api-key", "bearer"] as const) {
		for (const includeSubagent of [false, true]) {
			test(`skips oversized files before parsing or staging (${authType}, subagent: ${includeSubagent})`, async () => {
				const directory = await mkdtemp(join(tmpdir(), "opaline-size-guard-"));
				try {
					const transcriptPath = join(directory, "main.jsonl");
					const subagentPath = join(directory, "subagent.jsonl");
					const limit = INGEST_AGGREGATE_CONTENT_MAX_BYTES;
					// Sparse, invalid transcripts: reading/filtering them must not run.
					await writeFile(transcriptPath, "invalid transcript\n");
					await truncate(
						transcriptPath,
						includeSubagent ? limit / 2 : limit + 1,
					);
					if (includeSubagent) {
						await writeFile(subagentPath, "invalid subagent\n");
						await truncate(subagentPath, limit / 2 + 1);
					}
					const transfers: unknown[] = [];
					const retries: number[] = [];
					const result = await uploadSession(
						{
							kind: "file",
							metadata: {
								source: "claude_code",
								sessionId: "oversized-file",
								projectPath: directory,
							},
							transcriptPath,
							subagents: includeSubagent
								? [{ agentId: "child", path: subagentPath }]
								: [],
						},
						{
							endpoint: "http://127.0.0.1:1/rpc",
							allowInsecureEndpoint: false,
							authType,
							token: "unused",
							onTransferProgress: (progress) => transfers.push(progress),
							onRetry: (attempt) => retries.push(attempt),
						},
					);
					expect(result).toEqual(getUploadSizeFailure(limit + 1));
					expect(transfers).toEqual([]);
					expect(retries).toEqual([]);
				} finally {
					await rm(directory, { recursive: true, force: true });
				}
			});
		}
	}
});

describe("uploadSession transient transport handling", () => {
	test("returns the server usage checksum for client attestation", async () => {
		const usageChecksum = "c".repeat(64);
		const stub = startIngestStub({
			respond: () =>
				Response.json({
					json: {
						success: true,
						sessionId: "attested-upload",
						usageChecksum,
					},
				}),
		});
		try {
			const result = await uploadSession(
				{
					source: "claude_code",
					sessionId: "attested-upload",
					projectPath: "/test/project",
					content: '{"type":"user","timestamp":"2026-08-03T10:00:00.000Z"}',
				},
				{
					endpoint: `${stub.loopbackBase}/rpc`,
					token: INGEST_STUB_TEST_TOKEN,
					allowInsecureEndpoint: false,
				},
			);

			expect(result).toMatchObject({ success: true, usageChecksum });
		} finally {
			await stub.server.stop(true);
		}
	});

	test("retries a 408 response and succeeds on the next attempt", async () => {
		const stub = startIngestStub({ failFirstN: { n: 1, status: 408 } });
		const retries: number[] = [];
		try {
			const result = await uploadSession(
				{
					source: "claude_code",
					sessionId: "request-timeout-retry",
					projectPath: "/test/project",
					content: '{"type":"user","timestamp":"2026-08-03T10:00:00.000Z"}',
				},
				{
					endpoint: `${stub.loopbackBase}/rpc`,
					token: INGEST_STUB_TEST_TOKEN,
					allowInsecureEndpoint: false,
					onRetry: (attempt) => retries.push(attempt),
				},
			);

			expect(result).toMatchObject({ success: true, attempts: 2 });
			expect(retries).toEqual([1]);
		} finally {
			await stub.server.stop(true);
		}
	}, 10_000);

	test("retains Bun connection-refused failures for retry", async () => {
		const retries: number[] = [];
		const result = await uploadSession(
			{
				source: "claude_code",
				sessionId: "bun-connection-refused",
				projectPath: "/test/project",
				content: '{"type":"user","timestamp":"2026-08-03T10:00:00.000Z"}',
			},
			{
				endpoint: "http://127.0.0.1:1/rpc",
				token: INGEST_STUB_TEST_TOKEN,
				allowInsecureEndpoint: false,
				onRetry: (attempt) => retries.push(attempt),
			},
		);

		expect(result).toMatchObject({
			success: false,
			attempts: 3,
			retryable: true,
		});
		expect(result.error).toContain(
			"Network error while contacting Opaline API",
		);
		expect(retries).toEqual([1, 2]);
	}, 10_000);
});

describe("uploadSession timestamp validation", () => {
	test.each([
		{
			source: "claude_code" as const,
			message: "Claude Code transcript contains no valid timestamp",
		},
		{
			source: "codex" as const,
			message: "Codex transcript contains no valid timestamp",
		},
	])(
		"marks a $source server rejection as not retryable",
		async ({ source, message }) => {
			const stub = startIngestStub({
				respond: () =>
					Response.json(
						{
							json: {
								defined: false,
								code: "BAD_REQUEST",
								status: 400,
								message,
							},
						},
						{ status: 400 },
					),
			});

			try {
				const result = await uploadSession(
					{
						source,
						sessionId: `${source}-server-timestamp-validation`,
						projectPath: "/test/project",
						content: '{"type":"user","timestamp":"2026-07-31T10:00:00.000Z"}',
					},
					{
						endpoint: `${stub.loopbackBase}/rpc`,
						token: INGEST_STUB_TEST_TOKEN,
						allowInsecureEndpoint: false,
					},
				);

				expect(result).toEqual({
					success: false,
					error: message,
					attempts: 1,
					retryable: false,
				});
			} finally {
				await stub.server.stop(true);
			}
		},
	);
});

describe("uploadSession typed filtering failures", () => {
	test("maps a server JSON-integrity rejection to a permanent result", async () => {
		const stub = startIngestStub({
			respond: () =>
				Response.json(
					{
						json: {
							defined: false,
							code: SECRET_FILTER_JSON_INTEGRITY_CODE,
							status: 422,
							message:
								"Secret filtering could not preserve transcript JSON integrity.",
						},
					},
					{ status: 422 },
				),
		});

		try {
			const result = await uploadSession(
				{
					source: "claude_code",
					sessionId: "server-json-integrity",
					projectPath: "/test/project",
					content: '{"type":"user","timestamp":"2026-07-31T10:00:00.000Z"}',
				},
				{
					endpoint: `${stub.loopbackBase}/rpc`,
					token: INGEST_STUB_TEST_TOKEN,
					allowInsecureEndpoint: false,
				},
			);

			expect(result).toMatchObject({
				success: false,
				attempts: 1,
				failureKind: "json-integrity",
				retryable: false,
			});
		} finally {
			await stub.server.stop(true);
		}
	});
});

describe("formatRedactionSummary", () => {
	test("summarizes counts without including matched values", () => {
		expect(
			formatRedactionSummary(
				{
					"aws-access-key-id": 1,
					"openai-api-key": 2,
				},
				2048,
			),
		).toBe(
			"3 values matching known secret patterns were redacted (aws-access-key-id ×1, openai-api-key ×2, 2.0 KB).",
		);
	});

	test("omits a summary when nothing was redacted", () => {
		expect(formatRedactionSummary({}, 0)).toBeNull();
		expect(formatRedactionSummary(undefined, undefined)).toBeNull();
	});
});

describe("uploadSession redaction safety budget", () => {
	test("aborts before transport one secret byte over 20 percent", async () => {
		const secret = `sk_live_${"a".repeat(13)}`;
		const content = `${secret}\n${"x".repeat(78)}`;
		const result = await uploadSession(
			{
				source: "claude_code",
				sessionId: "redaction-budget-test",
				projectPath: "/test/project",
				content,
			},
			{
				endpoint: "http://127.0.0.1:1/rpc",
				allowInsecureEndpoint: false,
				token: "unused",
			},
		);

		expect(result).toEqual({
			success: false,
			error:
				"Redaction safety check stopped upload: known-pattern redaction would replace 21 B of 100 B (21.0%), above the 20% transcript budget (stripe-access-token). The unfiltered transcript was not uploaded.",
			attempts: 0,
			redactionBudgetExceeded: true,
			retryable: false,
		});
	});

	test("proceeds past the budget check at exactly 20 percent redaction", async () => {
		// A 20-byte flexible-length stripe secret plus newline plus 79 filler
		// bytes: 20 redacted of 100 input bytes, 20% on the nose. The budget
		// check must let this through to the next pre-flight guard.
		const secret = `sk_live_${"a".repeat(12)}`;
		const content = `${secret}\n${"x".repeat(79)}`;
		const result = await uploadSession(
			{
				source: "claude_code",
				sessionId: "redaction-budget-boundary-pass",
				projectPath: "/test/project",
				content,
			},
			{
				endpoint: "http://127.0.0.1:1/rpc",
				allowInsecureEndpoint: false,
				maxAggregateBytes: 100,
				token: "unused",
			},
		);

		expect(result.success).toBe(false);
		expect(result.attempts).toBe(0);
		expect(result.redactionBudgetExceeded).toBeUndefined();
		expect(result.endpointRejected).toBeUndefined();
		expect(result.error).not.toContain("Redaction safety check");
		expect(result.error).toContain("per-session limit");
	});

	test("counts a complete overlong match and aborts before transport", async () => {
		const slackPrefix = "xoxb-1234567890-1234567890-";
		const slackToken = `${slackPrefix}${"A".repeat(8193 - slackPrefix.length)}`;
		const result = await uploadSession(
			{
				source: "claude_code",
				sessionId: "overlong-redaction-budget-test",
				projectPath: "/test/project",
				content: `${slackToken}${".".repeat(100)}`,
			},
			{
				endpoint: "http://127.0.0.1:1/rpc",
				allowInsecureEndpoint: false,
				token: "unused",
			},
		);

		expect(result.success).toBe(false);
		expect(result.attempts).toBe(0);
		expect(result.redactionBudgetExceeded).toBe(true);
		expect(result.error).toContain("8.0 KB of 8.1 KB");
		expect(result.error).toContain("overlong-match, slack-bot-token");
		expect(result.error).not.toContain(slackToken);
	});
});

describe("uploadSession redaction convergence", () => {
	test("maps a convergence error to a zero-attempt upload failure", () => {
		const result = getSecretFilterUploadFailure(
			new SecretFilterConvergenceError(),
		);

		expect(result).toEqual({
			success: false,
			error:
				"Redaction safety check stopped upload because known-pattern filtering did not converge. The unfiltered transcript was not uploaded.",
			attempts: 0,
			redactionConvergenceExceeded: true,
			retryable: false,
		});
		expect(getSecretFilterUploadFailure(new Error("worker failed"))).toBeNull();
	});

	test("maps JSON-integrity failures to a permanent ledger disposition", () => {
		expect(
			getSecretFilterUploadFailure(new SecretFilterJsonIntegrityError()),
		).toEqual({
			success: false,
			error:
				"Redaction safety check stopped upload because filtering could not preserve transcript JSON integrity. The filtered transcript was not uploaded.",
			attempts: 0,
			failureKind: "json-integrity",
			retryable: false,
		});
	});
});

describe("uploadSession endpoint safety", () => {
	const request: IngestSessionInput = {
		source: "claude_code",
		sessionId: "endpoint-safety-test",
		projectPath: "/test/project",
		content: "sensitive transcript",
	};

	test("refuses a plaintext non-loopback endpoint before a network attempt", async () => {
		const result = await uploadSession(request, {
			endpoint: "http://evil.example/rpc",
			token: "must-not-leak",
			allowInsecureEndpoint: false,
		});

		expect(result).toEqual({
			success: false,
			error:
				'Upload endpoint refused: refusing to send credentials over plaintext http: to "evil.example". Pass --allow-insecure-endpoint (or set OPALINE_ALLOW_INSECURE_ENDPOINT=1) if this upload destination really is plaintext. This does not opt login or other API-base traffic into --allow-insecure-api-base.',
			attempts: 0,
			endpointRejected: true,
			retryable: false,
		});
		expect(result.error).not.toContain("must-not-leak");
	});

	test.each([
		["file:///etc/passwd", "scheme"],
		["http://user:pass@evil.example/rpc", "embedded credentials"],
		["not a url", "valid absolute URL"],
	])("always refuses %p despite the opt-in", async (endpoint, detail) => {
		const result = await uploadSession(request, {
			endpoint,
			token: "must-not-leak",
			allowInsecureEndpoint: true,
		});

		expect(result.success).toBe(false);
		expect(result.endpointRejected).toBe(true);
		expect(result.error).toContain(detail);
		expect(result.error).not.toContain("must-not-leak");
		expect(result.error).not.toContain("--allow-insecure-endpoint");
	});
});
