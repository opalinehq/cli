import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	chmod,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ORPCError } from "@orpc/client";
import { RepositoryEvidenceInitInputSchema } from "../contracts/index.js";
import {
	pauseRepositoryEvidenceCapture,
	readRepositoryEvidencePauseUntil,
} from "../lib/repository-evidence-pause.js";
import {
	type CliFixture,
	createCliFixture,
	HOOK_CASES,
	runCli,
	startIngestStub,
} from "./helpers/ingest-stub.js";

test.each([
	[undefined, 86_400],
	[0, 3_600],
	[-10, 3_600],
	[99999999, 604_800],
	[3600.5, 3_600],
	[Number.NaN, 86_400],
])(
	"pause duration %s is clamped to %s and expires",
	async (pauseSeconds, seconds) => {
		const directory = await mkdtemp(join(tmpdir(), "opaline-pause-"));
		try {
			pauseRepositoryEvidenceCapture(
				new ORPCError("EVIDENCE_CAPTURE_DISABLED", {
					status: 403,
					data: { pauseSeconds },
				}),
				directory,
				1_000,
			);
			expect(readRepositoryEvidencePauseUntil(directory, 1_000)).toBe(
				1_000 + seconds * 1_000,
			);
			expect(
				readRepositoryEvidencePauseUntil(directory, 1_000 + seconds * 1_000),
			).toBeUndefined();
			expect(
				(await stat(join(directory, "repository-evidence-pause.json"))).mode &
					0o777,
			).toBe(0o600);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	},
);

test.each(["init", "commit"])(
	"disabled %s removes the pending capture, source and spool without interrupting transcript upload",
	async (stage) => {
		const fixture = await createCliFixture("claude_code");
		const stub = startEvidenceStub("EVIDENCE_CAPTURE_DISABLED", stage);
		try {
			await prepareEvidenceFixture(fixture, stub.loopbackBase);
			const before = Date.now();
			const result = await runHook(fixture);
			expect(result.exitCode).toBe(0);
			expect(
				stub.requests.filter((request) =>
					request.pathname.endsWith(`repositoryEvidence/${stage}`),
				),
			).toHaveLength(1);
			expect(
				stub.requests.some(
					(request) => request.pathname === "/rpc/ingestSession",
				),
			).toBe(true);
			const config = join(fixture.home, ".rudel");
			expect(
				await readdir(join(config, "repository-evidence-pending", "v4")),
			).toEqual([]);
			expect(
				await readdir(join(config, "repository-evidence-sources")),
			).toEqual([]);
			const spoolFiles = await readdir(join(config, "repo-context-spool"), {
				recursive: true,
			});
			expect(
				spoolFiles.filter(
					(name) => name.endsWith(".capture.json") || name.endsWith(".blob"),
				),
			).toEqual([]);
			expect(
				JSON.parse(
					await readFile(
						join(config, "repo-context-spool", "accounting.v2.json"),
						"utf8",
					),
				),
			).toMatchObject({ captureCount: 0, blobCount: 0, state: "clean" });
			const until = readRepositoryEvidencePauseUntil(config);
			expect(until).toBeGreaterThanOrEqual(before + 86_400_000);
			expect(until).toBeLessThanOrEqual(Date.now() + 86_400_000);
		} finally {
			stub.server.stop(true);
			await rm(fixture.home, { recursive: true, force: true });
		}
	},
);

test.each(HOOK_CASES)(
	"$name uploads transcripts while paused with zero git commands or evidence writes",
	async (hook) => {
		const fixture = await createCliFixture(hook.source);
		const stub = startEvidenceStub("EVIDENCE_CAPTURE_DISABLED");
		try {
			await prepareEvidenceFixture(fixture, stub.loopbackBase);
			const config = join(fixture.home, ".rudel");
			pauseRepositoryEvidenceCapture(
				new ORPCError("EVIDENCE_CAPTURE_DISABLED", { status: 403 }),
				config,
			);
			const bin = join(fixture.home, "bin");
			const calls = join(fixture.home, "git-calls");
			await mkdir(bin);
			await writeFile(calls, "");
			await writeFile(
				join(bin, "git"),
				`#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\nexit 99\n`,
			);
			await chmod(join(bin, "git"), 0o700);
			const invocation = hook.buildInvocation(fixture);
			const result = await runCli(invocation.command, fixture, {
				stdin: invocation.stdin,
				env: { PATH: `${bin}:${process.env.PATH}` },
			});
			expect(result.exitCode).toBe(0);
			expect(await readFile(calls, "utf8")).toBe("");
			expect(
				stub.requests.some(
					(request) => request.pathname === "/rpc/ingestSession",
				),
			).toBe(true);
			expect(
				stub.requests.some((request) =>
					request.pathname.includes("repositoryEvidence"),
				),
			).toBe(false);
			expect(await readdir(config)).not.toContain("repo-context-spool");
			expect(await readdir(config)).not.toContain(
				"repository-evidence-sources",
			);
			if (hook.source === "claude_code") {
				const start = await runCli(
					["hooks", "claude", "session-start"],
					fixture,
					{
						stdin: JSON.stringify({
							cwd: fixture.projectPath,
							session_id: fixture.sessionId,
							transcript_path: fixture.transcriptPath,
						}),
						env: { PATH: `${bin}:${process.env.PATH}` },
					},
				);
				expect(start.exitCode).toBe(0);
				expect(await readFile(calls, "utf8")).toBe("");
			}
		} finally {
			stub.server.stop(true);
			await rm(fixture.home, { recursive: true, force: true });
		}
	},
);

test("an unknown code defers as before; paused pending captures are unchanged, then resume on expiry", async () => {
	const fixture = await createCliFixture("claude_code");
	let code = "FUTURE_UNKNOWN_ERROR";
	const stub = startEvidenceStub(() => code);
	try {
		await prepareEvidenceFixture(fixture, stub.loopbackBase);
		expect((await runHook(fixture)).exitCode).toBe(0);
		expect((await runHook(fixture)).exitCode).toBe(0);
		const config = join(fixture.home, ".rudel");
		const pendingDir = join(config, "repository-evidence-pending", "v4");
		const pendingNames = await readdir(pendingDir);
		expect(pendingNames).toHaveLength(2);
		const pendingPath = join(pendingDir, pendingNames[0] ?? "missing");
		const stored = await readFile(pendingPath, "utf8");
		expect(
			await readdir(join(config, "repository-evidence-sources")),
		).toHaveLength(2);
		expect(readRepositoryEvidencePauseUntil(config)).toBeUndefined();
		pauseRepositoryEvidenceCapture(
			new ORPCError("EVIDENCE_CAPTURE_DISABLED", { status: 403 }),
			config,
		);
		const count = stub.requests.length;
		expect((await runCli(["upload", "--retry"], fixture)).exitCode).toBe(0);
		expect(stub.requests).toHaveLength(count);
		expect((await runHook(fixture)).exitCode).toBe(0);
		expect(await readFile(pendingPath, "utf8")).toBe(stored);
		await writeFile(
			join(config, "repository-evidence-pause.json"),
			JSON.stringify({ until: Date.now() - 1 }),
		);
		code = "EVIDENCE_CAPTURE_DISABLED";
		const result = await runCli(["upload", "--retry"], fixture);
		expect(result.exitCode).toBe(0);
		expect(await readdir(pendingDir)).toHaveLength(1);
		expect(
			await readdir(join(config, "repository-evidence-sources")),
		).toHaveLength(1);
		expect(readRepositoryEvidencePauseUntil(config)).toBeDefined();
		const retainedRequests = stub.requests.length;
		expect((await runCli(["upload", "--retry"], fixture)).exitCode).toBe(0);
		expect(stub.requests).toHaveLength(retainedRequests);
		await writeFile(
			join(config, "repository-evidence-pause.json"),
			JSON.stringify({ until: Date.now() - 1 }),
		);
		code = "";
		expect((await runCli(["upload", "--retry"], fixture)).exitCode).toBe(0);
		expect(await readdir(pendingDir)).toEqual([]);
		expect(await readdir(join(config, "repository-evidence-sources"))).toEqual(
			[],
		);
		const evidenceBefore = stub.requests.filter((request) =>
			request.pathname.includes("repositoryEvidence"),
		).length;
		expect((await runHook(fixture)).exitCode).toBe(0);
		expect(
			stub.requests.filter((request) =>
				request.pathname.includes("repositoryEvidence"),
			),
		).toHaveLength(evidenceBefore + 2);
	} finally {
		stub.server.stop(true);
		await rm(fixture.home, { recursive: true, force: true });
	}
});

async function prepareEvidenceFixture(
	fixture: CliFixture,
	apiBaseUrl: string,
): Promise<void> {
	execFileSync("git", ["init", "--quiet", fixture.projectPath]);
	execFileSync("git", [
		"-C",
		fixture.projectPath,
		"remote",
		"add",
		"origin",
		"https://github.com/opaline-test/pause.git",
	]);
	const config = join(fixture.home, ".rudel");
	await writeFile(
		join(config, "credentials.json"),
		JSON.stringify({
			authType: "api-key",
			token: "test",
			apiBaseUrl,
			user: { id: "user", email: "test@example.test", name: "Test" },
		}),
	);
	await writeFile(
		join(config, "projects.json"),
		JSON.stringify({
			projects: { "github.com/opaline-test/pause": { organizationId: "org" } },
		}),
	);
	await writeFile(
		join(config, "auto-upload.json"),
		JSON.stringify({
			version: 1,
			repositories: {
				"remote:github.com/opaline-test/pause": {
					label: "pause",
					sources: [
						fixture.sessionId.startsWith("codex") ? "codex" : "claude_code",
					],
				},
			},
		}),
	);
}

function runHook(fixture: CliFixture) {
	return runCli(["hooks", "claude", "session-end"], fixture, {
		stdin: JSON.stringify({
			cwd: fixture.projectPath,
			session_id: fixture.sessionId,
			transcript_path: fixture.transcriptPath,
		}),
	});
}

function startEvidenceStub(code: string | (() => string), stage = "init") {
	let latest:
		| ReturnType<typeof RepositoryEvidenceInitInputSchema.parse>
		| undefined;
	return startIngestStub({
		respond({ pathname, body }) {
			const errorCode = typeof code === "string" ? code : code();
			if (errorCode && pathname.endsWith(`repositoryEvidence/${stage}`))
				return Response.json(
					{
						json: {
							defined: true,
							code: errorCode,
							status: 403,
							message: "capture paused",
							data: {},
						},
					},
					{ status: 403 },
				);
			if (pathname.endsWith("repositoryEvidence/init")) {
				const input = RepositoryEvidenceInitInputSchema.parse(
					JSON.parse(body).json,
				);
				latest = input;
				return Response.json({
					json: {
						expiresAt: "2027-01-01T00:00:00.000Z",
						missingObjects: [],
						partSizeBytes: 8 * 1024 * 1024,
						protocol: input.protocol,
						reusedObjectIds: input.objects.map((object) => object.objectId),
						uploadReceiptId: "00000000-0000-4000-8000-000000000010",
					},
				});
			}
			if (pathname.endsWith("repositoryEvidence/commit")) {
				assert(latest);
				return Response.json({
					json: {
						acceptedAt: new Date().toISOString(),
						contextId: latest.capture.contextId,
						manifestObjectId: latest.manifestObjectId,
						protocol: latest.protocol,
						receiptId: "00000000-0000-4000-8000-000000000011",
						status: "accepted",
						storedObjectIds: latest.objects.map((object) => object.objectId),
						uploadReceiptId: "00000000-0000-4000-8000-000000000010",
					},
				});
			}
			if (pathname === "/rpc/ingest/init")
				return Response.json(
					{
						json: {
							defined: true,
							code: "NOT_FOUND",
							status: 404,
							message: "older ingest",
						},
					},
					{ status: 404 },
				);
			return Response.json({
				json: { success: true, sessionId: "stub-session" },
			});
		},
	});
}
