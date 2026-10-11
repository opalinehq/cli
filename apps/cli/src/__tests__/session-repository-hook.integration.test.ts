import { afterAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { appendFile, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getGitInfo } from "../lib/git-info.js";
import { resolveUploadRepositoryIdentity } from "../lib/repository-discovery.js";
import {
	type CliFixture,
	createCliFixture,
	HOOK_CASES,
	INGEST_STUB_TEST_TOKEN,
	runCli,
	startIngestStub,
} from "./helpers/ingest-stub.js";

const fixtureHomes: string[] = [];

afterAll(async () => {
	await Promise.all(
		fixtureHomes.map((home) => rm(home, { force: true, recursive: true })),
	);
});

function git(cwd: string, ...args: string[]) {
	execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore" });
}

/**
 * The session starts in an empty repository without a remote (the fixture's
 * project) and edits a file in `work`, a repository with one. Automatic upload
 * is on for the starting folder; `work` is Off when `workEnabled` is false and
 * has no setting otherwise.
 */
async function startOutsideRepository(
	source: (typeof HOOK_CASES)[number]["source"],
	workEnabled: false | undefined,
	apiBaseUrl: string,
): Promise<CliFixture> {
	const fixture = await createCliFixture(source);
	fixtureHomes.push(fixture.home);
	const work = join(fixture.home, "work");
	await mkdir(join(work, "src"), { recursive: true });
	await writeFile(join(work, "src", "index.ts"), "export {};\n");
	git(work, "init", "-q", "-b", "main");
	git(work, "add", ".");
	git(
		work,
		"-c",
		"user.name=t",
		"-c",
		"user.email=t@t",
		"commit",
		"-qm",
		"init",
	);
	git(work, "remote", "add", "origin", "git@github.com:acme/work.git");
	git(fixture.projectPath, "init", "-q");

	const editedFile = join(work, "src", "index.ts");
	await appendFile(
		fixture.transcriptPath,
		`\n${JSON.stringify(
			source === "codex"
				? {
						timestamp: "2026-07-29T10:00:02.000Z",
						type: "response_item",
						payload: {
							type: "custom_tool_call",
							name: "apply_patch",
							input: `*** Begin Patch\n*** Update File: ${editedFile}\n*** End Patch`,
						},
					}
				: {
						timestamp: "2026-07-29T10:00:02.000Z",
						type: "assistant",
						message: {
							role: "assistant",
							content: [
								{
									type: "tool_use",
									name: "Edit",
									input: { file_path: editedFile },
								},
							],
						},
					},
		)}`,
	);

	const folder = resolveUploadRepositoryIdentity(
		fixture.projectPath,
		await getGitInfo(fixture.projectPath),
	);
	await writeFile(
		join(fixture.home, ".rudel", "auto-upload.json"),
		JSON.stringify({
			version: 1,
			repositories: {
				[folder.repoKey]: {
					label: "project",
					sources: ["claude_code", "codex"],
				},
				...(workEnabled === false
					? { "remote:github.com/acme/work": { label: "work", sources: [] } }
					: {}),
			},
		}),
	);
	await writeFile(
		join(fixture.home, ".rudel", "credentials.json"),
		JSON.stringify({
			token: INGEST_STUB_TEST_TOKEN,
			apiBaseUrl,
			authType: "api-key",
		}),
	);
	return fixture;
}

test.each(HOOK_CASES)(
	"$name attributes a session started outside a repository to the one it edited",
	async (hookCase) => {
		const stub = startIngestStub();
		try {
			const fixture = await startOutsideRepository(
				hookCase.source,
				undefined,
				stub.loopbackBase,
			);
			const invocation = hookCase.buildInvocation(fixture);
			const result = await runCli(invocation.command, fixture, {
				stdin: invocation.stdin,
			});

			expect(result.exitCode).toBe(0);
			const index = stub.requests.findIndex(
				(request) => request.pathname === "/rpc/ingestSession",
			);
			expect(index).toBeGreaterThanOrEqual(0);
			const body = JSON.parse(stub.bodies[index] ?? "{}").json;
			expect(body).toMatchObject({
				gitRemote: "github.com/acme/work",
				gitBranch: "main",
				projectPath: fixture.projectPath,
			});
		} finally {
			await stub.server.stop(true);
		}
	},
	30_000,
);

test.each(HOOK_CASES)(
	"$name skips a session that worked in a repository with automatic upload off",
	async (hookCase) => {
		const stub = startIngestStub();
		try {
			const fixture = await startOutsideRepository(
				hookCase.source,
				false,
				stub.loopbackBase,
			);
			const invocation = hookCase.buildInvocation(fixture);
			const result = await runCli(invocation.command, fixture, {
				stdin: invocation.stdin,
			});

			expect(result.exitCode).toBe(0);
			expect(
				stub.requests.filter(
					(request) => request.pathname === "/rpc/ingestSession",
				),
			).toEqual([]);
		} finally {
			await stub.server.stop(true);
		}
	},
	30_000,
);
