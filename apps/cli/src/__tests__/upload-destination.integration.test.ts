import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	createCliFixture,
	HOOK_CASES,
	INGEST_STUB_TEST_TOKEN,
	runCli,
	startIngestStub,
} from "./helpers/ingest-stub.js";

const TEST_TOKEN = INGEST_STUB_TEST_TOKEN;

async function pointCredentialsAt(
	home: string,
	apiBaseUrl: string,
): Promise<void> {
	await writeFile(
		join(home, ".rudel", "credentials.json"),
		JSON.stringify({
			token: TEST_TOKEN,
			apiBaseUrl,
			authType: "api-key",
		}),
	);
}

test("upload defaults to the authenticated API base", async () => {
	const stub = startIngestStub();
	const fixture = await createCliFixture("claude_code");
	try {
		await pointCredentialsAt(fixture.home, stub.loopbackBase);

		const result = await runCli(["upload", fixture.transcriptPath], fixture);

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("Upload successful!");
		expect(stub.requests).toEqual([
			{
				apiKey: TEST_TOKEN,
				pathname: "/rpc/ingestSession",
			},
		]);
	} finally {
		await stub.server.stop(true);
		await rm(fixture.home, { recursive: true, force: true });
	}
}, 30_000);

test("retry defaults to the authenticated API base", async () => {
	const stub = startIngestStub();
	const fixture = await createCliFixture("claude_code");
	try {
		await pointCredentialsAt(fixture.home, stub.loopbackBase);
		await writeFile(
			join(fixture.home, ".rudel", "failed-uploads.json"),
			JSON.stringify({
				failures: [
					{
						sessionId: fixture.sessionId,
						transcriptPath: fixture.transcriptPath,
						projectPath: fixture.projectPath,
						source: "claude_code",
						error: "network failure",
						failedAt: "2026-08-12T10:00:00.000Z",
						status: "retryable",
					},
				],
			}),
		);

		const result = await runCli(["upload", "--retry", "--yes"], fixture);

		expect(result.exitCode).toBe(0);
		expect(stub.requests).toHaveLength(1);
		expect(stub.requests[0]).toEqual({
			apiKey: TEST_TOKEN,
			pathname: "/rpc/ingestSession",
		});
	} finally {
		await stub.server.stop(true);
		await rm(fixture.home, { recursive: true, force: true });
	}
}, 30_000);

test("retry dry-run performs no network or persistent-state writes", async () => {
	const stub = startIngestStub();
	const fixture = await createCliFixture("claude_code");
	const queuePath = join(fixture.home, ".rudel", "failed-uploads.json");
	const queue = JSON.stringify(
		{
			failures: [
				{
					sessionId: fixture.sessionId,
					transcriptPath: fixture.transcriptPath,
					projectPath: fixture.projectPath,
					source: "claude_code",
					error: "network failure",
					failedAt: "2026-08-12T10:00:00.000Z",
					status: "retryable",
				},
			],
		},
		null,
		2,
	);
	try {
		await pointCredentialsAt(fixture.home, stub.loopbackBase);
		await writeFile(queuePath, queue);

		const result = await runCli(["upload", "--retry", "--dry-run"], fixture);

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("Dry run complete");
		expect(result.stderr).not.toContain("failed");
		expect(stub.requests).toHaveLength(0);
		expect(await readFile(queuePath, "utf8")).toBe(queue);
	} finally {
		await stub.server.stop(true);
		await rm(fixture.home, { recursive: true, force: true });
	}
}, 30_000);

test("single-session dry-run does not launch the classifier", async () => {
	const fixture = await createCliFixture("claude_code");
	const fakeBin = join(fixture.home, "bin");
	const marker = join(fixture.home, "classifier-was-launched");
	try {
		await mkdir(fakeBin, { recursive: true });
		const fakeClaude = join(fakeBin, "claude");
		await writeFile(fakeClaude, `#!/bin/sh\ntouch "${marker}"\n`);
		await chmod(fakeClaude, 0o755);

		const result = await runCli(
			["upload", fixture.transcriptPath, "--dry-run", "--classify"],
			fixture,
			{ env: { PATH: `${fakeBin}:${process.env.PATH ?? ""}` } },
		);

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("Dry run - would upload:");
		expect(existsSync(marker)).toBe(false);
	} finally {
		await rm(fixture.home, { recursive: true, force: true });
	}
}, 30_000);

test("upload --endpoint refuses plaintext non-loopback without an opt-in", async () => {
	const stub = startIngestStub();
	const fixture = await createCliFixture("claude_code");
	try {
		const result = await runCli(
			[
				"upload",
				fixture.transcriptPath,
				"--endpoint",
				`${stub.nonLoopbackBase}/rpc`,
			],
			fixture,
			{ env: { RUDEL_ALLOW_INSECURE_ENDPOINT: "" } },
		);

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("Upload endpoint refused");
		expect(result.stderr).toContain("--allow-insecure-endpoint");
		expect(result.stderr).not.toContain(TEST_TOKEN);
		expect(stub.requests).toHaveLength(0);
	} finally {
		await stub.server.stop(true);
		await rm(fixture.home, { recursive: true, force: true });
	}
}, 30_000);

test("upload --allow-insecure-endpoint permits an opted-in plaintext destination", async () => {
	const stub = startIngestStub();
	const fixture = await createCliFixture("claude_code");
	try {
		const result = await runCli(
			[
				"upload",
				fixture.transcriptPath,
				"--endpoint",
				`${stub.nonLoopbackBase}/rpc`,
				"--allow-insecure-endpoint",
			],
			fixture,
			{ env: { RUDEL_ALLOW_INSECURE_ENDPOINT: "" } },
		);

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("Upload successful!");
		expect(stub.requests).toEqual([
			{
				apiKey: TEST_TOKEN,
				pathname: "/rpc/ingestSession",
			},
		]);
	} finally {
		await stub.server.stop(true);
		await rm(fixture.home, { recursive: true, force: true });
	}
}, 30_000);

test("upload --endpoint permits loopback plaintext without an opt-in", async () => {
	const stub = startIngestStub();
	const fixture = await createCliFixture("claude_code");
	try {
		const result = await runCli(
			[
				"upload",
				fixture.transcriptPath,
				"--endpoint",
				`${stub.loopbackBase}/rpc`,
			],
			fixture,
			{ env: { RUDEL_ALLOW_INSECURE_ENDPOINT: "" } },
		);

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("Upload successful!");
		expect(stub.requests).toHaveLength(1);
	} finally {
		await stub.server.stop(true);
		await rm(fixture.home, { recursive: true, force: true });
	}
}, 30_000);

test("upload --force-replace sends an explicit replacement instruction", async () => {
	const stub = startIngestStub();
	const fixture = await createCliFixture("claude_code");
	try {
		const result = await runCli(
			[
				"upload",
				fixture.transcriptPath,
				"--endpoint",
				`${stub.loopbackBase}/rpc`,
				"--force-replace",
			],
			fixture,
		);

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("Upload successful!");
		expect(stub.bodies[0]).toContain('"force_replace":true');
	} finally {
		await stub.server.stop(true);
		await rm(fixture.home, { recursive: true, force: true });
	}
}, 30_000);

test.each(
	HOOK_CASES,
)("$name refuses an unsafe RUDEL_API_BASE observably and queues the session", async (hookCase) => {
	const stub = startIngestStub();
	const fixture = await createCliFixture(hookCase.source);
	try {
		const invocation = hookCase.buildInvocation(fixture);
		const result = await runCli(invocation.command, fixture, {
			stdin: invocation.stdin,
			env: {
				RUDEL_API_BASE: stub.nonLoopbackBase,
				RUDEL_ALLOW_INSECURE_ENDPOINT: "",
			},
		});

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("Opaline hook upload refused");
		expect(result.stderr).toContain('plaintext http: to "0.0.0.0"');
		expect(result.stderr).not.toContain(TEST_TOKEN);
		expect(stub.requests).toHaveLength(0);

		const log = await readFile(
			join(fixture.home, ".rudel", "logs", "hook-upload.log"),
			"utf8",
		);
		expect(log).toContain('plaintext http: to "0.0.0.0"');
		expect(log).not.toContain(TEST_TOKEN);

		const failedUploads = await readFile(
			join(fixture.home, ".rudel", "failed-uploads.json"),
			"utf8",
		);
		expect(failedUploads).toContain(fixture.sessionId);
		expect(failedUploads).toContain(hookCase.source);
	} finally {
		await stub.server.stop(true);
		await rm(fixture.home, { recursive: true, force: true });
	}
}, 30_000);

test.each(
	HOOK_CASES,
)("$name honors RUDEL_ALLOW_INSECURE_ENDPOINT=1", async (hookCase) => {
	const stub = startIngestStub();
	const fixture = await createCliFixture(hookCase.source);
	try {
		const invocation = hookCase.buildInvocation(fixture);
		const result = await runCli(invocation.command, fixture, {
			stdin: invocation.stdin,
			env: {
				RUDEL_API_BASE: stub.nonLoopbackBase,
				RUDEL_ALLOW_INSECURE_ENDPOINT: "1",
			},
		});

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe("");
		expect(stub.requests).toEqual([
			{
				apiKey: TEST_TOKEN,
				pathname: "/rpc/ingestSession",
			},
		]);
	} finally {
		await stub.server.stop(true);
		await rm(fixture.home, { recursive: true, force: true });
	}
}, 30_000);

test.each(
	HOOK_CASES,
)("$name exposes and retains permanent API failures", async (hookCase) => {
	const message =
		hookCase.source === "codex"
			? "Codex transcript contains no valid timestamp"
			: "Claude Code transcript contains no valid timestamp";
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
	const fixture = await createCliFixture(hookCase.source);
	try {
		const invocation = hookCase.buildInvocation(fixture);
		const result = await runCli(invocation.command, fixture, {
			stdin: invocation.stdin,
			env: { RUDEL_API_BASE: stub.loopbackBase },
		});

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toContain("Opaline hook upload failed");
		expect(result.stderr).toContain("[permanent]");
		expect(result.stderr).toContain(message);

		const failedUploads = JSON.parse(
			await readFile(
				join(fixture.home, ".rudel", "failed-uploads.json"),
				"utf8",
			),
		) as { failures: Array<{ sessionId: string; status: string }> };
		expect(failedUploads.failures).toContainEqual(
			expect.objectContaining({
				sessionId: fixture.sessionId,
				status: "permanent",
			}),
		);
	} finally {
		await stub.server.stop(true);
		await rm(fixture.home, { recursive: true, force: true });
	}
}, 30_000);

test("whoami surfaces local retryable and permanent upload status", async () => {
	const fixture = await createCliFixture("claude_code");
	try {
		await rm(join(fixture.home, ".rudel", "credentials.json"));
		await writeFile(
			join(fixture.home, ".rudel", "failed-uploads.json"),
			JSON.stringify({
				failures: [
					{
						error: "network",
						failedAt: "2026-08-02T10:00:00.000Z",
						projectPath: fixture.projectPath,
						sessionId: "retryable",
						status: "retryable",
						transcriptPath: fixture.transcriptPath,
					},
					{
						error: "invalid",
						failedAt: "2026-08-02T10:00:00.000Z",
						projectPath: fixture.projectPath,
						sessionId: "permanent",
						status: "permanent",
						transcriptPath: fixture.transcriptPath,
					},
				],
			}),
		);

		const result = await runCli(["whoami"], fixture);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain(
			"Local upload status: 1 retryable failure(s), 1 permanent failure(s)",
		);
		expect(result.stdout).toContain("Not logged in");
	} finally {
		await rm(fixture.home, { recursive: true, force: true });
	}
}, 30_000);

test("whoami leaves out failures whose transcript is gone, and upload --retry still lists them", async () => {
	const fixture = await createCliFixture("claude_code");
	try {
		await rm(join(fixture.home, ".rudel", "credentials.json"));
		const gone = join(fixture.home, "deleted-worktree", "gone.jsonl");
		await writeFile(
			join(fixture.home, ".rudel", "failed-uploads.json"),
			JSON.stringify({
				failures: [
					{
						error: "network",
						failedAt: "2026-08-02T10:00:00.000Z",
						projectPath: fixture.projectPath,
						sessionId: "present",
						status: "retryable",
						transcriptPath: fixture.transcriptPath,
					},
					{
						error: `ENOENT: no such file or directory, open '${gone}'`,
						failedAt: "2026-08-02T10:00:00.000Z",
						projectPath: fixture.projectPath,
						sessionId: "gone",
						status: "retryable",
						transcriptPath: gone,
					},
				],
			}),
		);

		const whoami = await runCli(["whoami"], fixture);
		expect(whoami.exitCode).toBe(0);
		expect(whoami.stdout).toContain(
			"Local upload status: 1 retryable failure(s), 0 permanent failure(s)",
		);

		const retry = await runCli(["upload", "--retry", "--dry-run"], fixture);
		expect(retry.stdout).toContain(
			"Found 2 failed upload(s): 1 retryable, 1 permanent",
		);
		expect(retry.stdout).toContain(
			`gone: Not retried: the transcript is no longer at ${gone}`,
		);
	} finally {
		await rm(fixture.home, { recursive: true, force: true });
	}
}, 30_000);
