import { beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IngestSessionInput } from "../contracts/index.js";
import { FILTER_VERSION } from "../internal/secret-filter/index.js";
import { uploadSession } from "../lib/uploader.js";
import {
	buildCliArtifact,
	containsAnyCanary,
	createClaudeFixtureSecrets,
	EXPECTED_CLAUDE_REDACTION_SUMMARY,
	getNodeMajorVersion,
	readRedactionTemplates,
	renderFixture,
	runBuiltCli,
	writeCliCredentials,
} from "./helpers/cli-e2e.js";
import {
	INGEST_STUB_TEST_TOKEN,
	type IngestStub,
	type IngestStubRespondInfo,
	startIngestStub,
} from "./helpers/ingest-stub.js";

/**
 * Axis A2 — the NEW CLI (client-side filtering) against an OLD-API stub whose
 * responses predate the redaction fields, plus degraded proxy/gateway answers.
 * Fully self-contained: loopback stubs only, no infrastructure.
 *
 * The stub's default success envelope ({success, sessionId} without
 * redacted/redactedBytes) is exactly what a pre-filtering API deployment
 * returns, so "default stub" here means "old API".
 */

const CLAUDE_SECRETS = createClaudeFixtureSecrets();
const TEMPLATES = await readRedactionTemplates();

const EXPECTED_CLAUDE_REDACTIONS = {
	"aws-access-key-id": 1,
	"github-pat": 1,
	"openai-api-key": 1,
	"slack-webhook-url": 1,
};
const EXPECTED_CLAUDE_REDACTED_BYTES = 187;

function createDirtyClaudeRequest(sessionId: string): IngestSessionInput {
	return {
		source: "claude_code",
		sessionId,
		projectPath: "/test/old-api-compat",
		content: renderFixture(
			TEMPLATES.claudeSession,
			sessionId,
			CLAUDE_SECRETS,
			false,
		),
		subagents: [
			{
				agentId: "nested-agent-001",
				content: renderFixture(
					TEMPLATES.claudeSubagent,
					sessionId,
					CLAUDE_SECRETS,
					false,
				),
			},
		],
	};
}

function stubUploadConfig(stub: IngestStub) {
	return {
		endpoint: `${stub.loopbackBase}/rpc`,
		token: INGEST_STUB_TEST_TOKEN,
		allowInsecureEndpoint: false,
		authType: "api-key" as const,
	};
}

describe("uploadSession against an old-API ingest stub", () => {
	test("success response without redacted fields reports exact client-side counts", async () => {
		const stub = startIngestStub();
		try {
			const result = await uploadSession(
				createDirtyClaudeRequest("old-api-client-counts"),
				stubUploadConfig(stub),
			);

			// Merged counts must be the client filter's exact output — no
			// undefined/NaN arithmetic from the missing server fields.
			expect(result).toEqual({
				success: true,
				status: 200,
				attempts: 1,
				redacted: EXPECTED_CLAUDE_REDACTIONS,
				redactedBytes: EXPECTED_CLAUDE_REDACTED_BYTES,
			});
			expect(stub.requests).toEqual([
				{ apiKey: INGEST_STUB_TEST_TOKEN, pathname: "/rpc/ingestSession" },
			]);
		} finally {
			await stub.server.stop(true);
		}
	});

	test("wire request body stamps the current filter_version", async () => {
		const stub = startIngestStub();
		try {
			const result = await uploadSession(
				createDirtyClaudeRequest("old-api-filter-version"),
				stubUploadConfig(stub),
			);

			expect(result.success).toBe(true);
			const wireBody = stub.bodies[0] ?? "";
			expect(wireBody.length).toBeGreaterThan(0);
			expect(wireBody).toContain(`"filter_version":${FILTER_VERSION}`);
			const parsed = JSON.parse(wireBody) as {
				json?: { filter_version?: unknown };
			};
			expect(parsed.json?.filter_version).toBe(FILTER_VERSION);
		} finally {
			await stub.server.stop(true);
		}
	});

	interface DegradedResponseCase {
		readonly name: string;
		readonly respond: (info: IngestStubRespondInfo) => Response;
		readonly expectedErrorSubstring: string;
		readonly expectedRetryable: boolean;
	}

	const DEGRADED_RESPONSE_CASES: readonly DegradedResponseCase[] = [
		{
			name: "200 with an HTML body",
			respond: () =>
				new Response("<html><body>SSO gateway sign-in</body></html>", {
					status: 200,
					headers: { "content-type": "text/html" },
				}),
			expectedErrorSubstring:
				"unrecognized response instead of an ingest confirmation",
			expectedRetryable: false,
		},
		{
			name: "200 with non-oRPC JSON",
			respond: () => Response.json({ ok: true }),
			expectedErrorSubstring:
				"unrecognized response instead of an ingest confirmation",
			expectedRetryable: false,
		},
		{
			name: "401 with a plain-text body",
			respond: () => new Response("unauthorized", { status: 401 }),
			expectedErrorSubstring: "401 Unauthorized",
			expectedRetryable: false,
		},
		{
			name: "403 with a plain-text body",
			respond: () => new Response("forbidden", { status: 403 }),
			expectedErrorSubstring: "403 Forbidden",
			expectedRetryable: false,
		},
		{
			name: "404 with a plain-text body",
			respond: () => new Response("not found", { status: 404 }),
			expectedErrorSubstring: "404 Not Found",
			expectedRetryable: false,
		},
		{
			name: "413 with a plain-text body",
			respond: () => new Response("too large", { status: 413 }),
			expectedErrorSubstring: "413 Payload Too Large",
			expectedRetryable: false,
		},
		{
			name: "422 with an unknown JSON shape",
			respond: () => Response.json({ weird: true }, { status: 422 }),
			expectedErrorSubstring: "422 Unprocessable Content",
			expectedRetryable: false,
		},
		{
			name: "500 with an HTML body",
			respond: () =>
				new Response("<html>Internal Server Error</html>", {
					status: 500,
					headers: { "content-type": "text/html" },
				}),
			expectedErrorSubstring: "500 Internal Server Error",
			expectedRetryable: true,
		},
	];

	test.each(DEGRADED_RESPONSE_CASES)(
		"degraded response $name fails cleanly after exactly one attempt",
		async (degradedCase) => {
			const stub = startIngestStub({ respond: degradedCase.respond });
			try {
				const result = await uploadSession(
					createDirtyClaudeRequest("old-api-degraded-response"),
					stubUploadConfig(stub),
				);

				// Deterministic responses remain permanent. A generic 500 is retained
				// for a later retry even though only 502/503/504 retry inline.
				expect(result).toMatchObject({
					success: false,
					attempts: 1,
					retryable: degradedCase.expectedRetryable,
				});
				expect(result.error).toContain(degradedCase.expectedErrorSubstring);
				expect(stub.requests).toHaveLength(1);
			} finally {
				await stub.server.stop(true);
			}
		},
	);

	test("recovers from a transient 502 with both wire bodies redacted", async () => {
		// Empirically pinned: oRPC raises ORPCError(status 502) for the stub's
		// plain-text 502 body, so the client's retry policy engages as designed.
		const stub = startIngestStub({ failFirstN: { n: 1, status: 502 } });
		try {
			const result = await uploadSession(
				createDirtyClaudeRequest("old-api-502-retry"),
				stubUploadConfig(stub),
			);

			expect(result).toEqual({
				success: true,
				status: 200,
				attempts: 2,
				redacted: EXPECTED_CLAUDE_REDACTIONS,
				redactedBytes: EXPECTED_CLAUDE_REDACTED_BYTES,
			});
			expect(stub.bodies).toHaveLength(2);
			for (const wireBody of stub.bodies) {
				expect(containsAnyCanary(wireBody, CLAUDE_SECRETS)).toBe(false);
				for (const secret of CLAUDE_SECRETS) {
					expect(wireBody).toContain(`[REDACTED:${secret.ruleId}]`);
				}
			}
		} finally {
			await stub.server.stop(true);
		}
	}, 15_000);
});

describe("built CLI against an old-API ingest stub", () => {
	beforeAll(async () => {
		await buildCliArtifact();
	});

	test("single-file upload prints the client-side redaction summary", async () => {
		const stub = startIngestStub();
		const home = await mkdtemp(join(tmpdir(), "rudel-old-api-compat-"));
		try {
			const sessionId = "old-api-compat-cli-session";
			const configDir = join(home, ".rudel");
			const projectDir = join(home, "claude-project");
			const sessionFile = join(projectDir, `${sessionId}.jsonl`);
			const subagentDir = join(projectDir, sessionId, "subagents");
			await mkdir(configDir, { recursive: true });
			await mkdir(subagentDir, { recursive: true });
			await writeCliCredentials(
				configDir,
				INGEST_STUB_TEST_TOKEN,
				stub.loopbackBase,
				"api-key",
			);
			await writeFile(
				sessionFile,
				renderFixture(
					TEMPLATES.claudeSession,
					sessionId,
					CLAUDE_SECRETS,
					false,
				),
			);
			await writeFile(
				join(subagentDir, "agent-nested-agent-001.jsonl"),
				renderFixture(
					TEMPLATES.claudeSubagent,
					sessionId,
					CLAUDE_SECRETS,
					false,
				),
			);
			expect(await getNodeMajorVersion()).toBeGreaterThanOrEqual(20);

			const result = await runBuiltCli(
				["upload", sessionFile, "--endpoint", `${stub.loopbackBase}/rpc`],
				{ home, configDir, env: { RUDEL_ALLOW_INSECURE_ENDPOINT: "" } },
			);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Upload successful!");
			expect(result.stdout).toContain(EXPECTED_CLAUDE_REDACTION_SUMMARY);
			expect(containsAnyCanary(result.stdout, CLAUDE_SECRETS)).toBe(false);
			expect(containsAnyCanary(result.stderr, CLAUDE_SECRETS)).toBe(false);
			expect(stub.requests).toEqual([
				{ apiKey: INGEST_STUB_TEST_TOKEN, pathname: "/rpc/ingestSession" },
			]);
			const wireBody = stub.bodies[0] ?? "";
			expect(containsAnyCanary(wireBody, CLAUDE_SECRETS)).toBe(false);
			expect(wireBody).toContain(`"filter_version":${FILTER_VERSION}`);
		} finally {
			await stub.server.stop(true);
			await rm(home, { recursive: true, force: true });
		}
	}, 60_000);

	test("retries a refused connection under Node before failing", async () => {
		// Bun's connection-refused error is not a TypeError, but the shipped
		// artifact runs under Node, where fetch rejects with TypeError and the
		// uploader's retry path must engage: 3 attempts with 1s + 2s backoff.
		// Reserve a loopback port with a throwaway server, then free it so the
		// endpoint below is a closed port.
		const placeholder = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => new Response(""),
		});
		const closedPort = placeholder.port;
		await placeholder.stop(true);

		const home = await mkdtemp(join(tmpdir(), "rudel-old-api-refused-"));
		try {
			const sessionId = "old-api-refused-session";
			const configDir = join(home, ".rudel");
			const projectDir = join(home, "claude-project");
			const sessionFile = join(projectDir, `${sessionId}.jsonl`);
			await mkdir(configDir, { recursive: true });
			await mkdir(projectDir, { recursive: true });
			await writeCliCredentials(
				configDir,
				INGEST_STUB_TEST_TOKEN,
				`http://127.0.0.1:${closedPort}`,
				"api-key",
			);
			await writeFile(
				sessionFile,
				renderFixture(
					TEMPLATES.claudeSession,
					sessionId,
					CLAUDE_SECRETS,
					false,
				),
			);

			const startedAt = Date.now();
			const result = await runBuiltCli(
				[
					"upload",
					sessionFile,
					"--endpoint",
					`http://127.0.0.1:${closedPort}/rpc`,
				],
				{ home, configDir, env: { RUDEL_ALLOW_INSECURE_ENDPOINT: "" } },
			);
			const elapsedMs = Date.now() - startedAt;

			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("Upload failed:");
			expect(result.stderr).toContain(
				"Network error while contacting Opaline API",
			);
			expect(result.stderr).toContain("opaline upload");
			expect(containsAnyCanary(result.stderr, CLAUDE_SECRETS)).toBe(false);
			// The 1s + 2s backoff between the three attempts puts a hard floor on
			// the wall clock; a non-retrying run fails in well under a second.
			expect(elapsedMs).toBeGreaterThanOrEqual(3_000);
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	}, 60_000);
});
