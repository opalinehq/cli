import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, join } from "node:path";
import { getConfigDir } from "../lib/local-state.js";
import { readPendingRepositoryEvidence } from "../lib/repository-evidence-pending.js";
import { captureAndUploadSessionEvidence } from "../lib/session-evidence.js";
import { startEvidenceProtocolStub } from "./helpers/evidence-protocol-stub.js";

/**
 * Opt-in capture of real checkouts, read-only. Run with
 *
 *   OPALINE_REAL_REPO_PATHS=/path/one:/path/two bun run test:real-repos
 *
 * The capture runs the production code path (context collection, spool,
 * pending item, delivery) with the configuration directory, spool and pending
 * items in a temporary directory, and delivers to the loopback protocol stub.
 * Skill roots are read from the real home directory, as the hook does. It
 * asserts that every coverage area and facet is complete and that every
 * AGENTS.md and CLAUDE.md is stored byte for byte as it is on disk, or, when
 * the capture policy keeps it hash-only (skill resources, personal files),
 * that its source hash matches the file on disk.
 */

setDefaultTimeout(180_000);

const repositoryPaths = (process.env.OPALINE_REAL_REPO_PATHS ?? "")
	.split(delimiter)
	.filter((path) => path.length > 0);
const temporaryDirectories: string[] = [];

afterAll(async () => {
	await Promise.all(
		temporaryDirectories.map((directory) =>
			rm(directory, { force: true, recursive: true }),
		),
	);
});

describe("real repository sidecar capture", () => {
	test("OPALINE_REAL_REPO_PATHS names at least one repository", () => {
		expect(repositoryPaths.length).toBeGreaterThan(0);
	});

	test.each(repositoryPaths)(
		"captures %s completely",
		async (repositoryPath) => {
			const configDir = await realpath(
				await mkdtemp(join(tmpdir(), "opaline-real-repo-")),
			);
			temporaryDirectories.push(configDir);
			process.env.OPALINE_CONFIG_DIR = configDir;
			process.env.RUDEL_CONFIG_DIR = configDir;
			process.env.POSTHOG_ENABLED = "false";
			process.env.OPALINE_ALLOW_INSECURE_ENDPOINT = "1";
			expect(getConfigDir()).toBe(configDir);
			const stub = startEvidenceProtocolStub();
			try {
				const credentials = {
					apiBaseUrl: stub.base,
					authType: "api-key" as const,
					token: "test",
					user: {
						id: "real-repo-user",
						email: "test@example.invalid",
						name: "Test",
					},
				};
				await writeFile(
					join(configDir, "credentials.json"),
					JSON.stringify(credentials),
				);
				const sessionId = randomUUID();
				const content = `${[
					{
						type: "session_meta",
						timestamp: new Date().toISOString(),
						payload: { id: sessionId, cwd: repositoryPath },
					},
					{
						timestamp: new Date().toISOString(),
						type: "response_item",
						payload: {
							content: [
								{ text: "Real repository capture", type: "input_text" },
							],
							role: "user",
							type: "message",
						},
					},
				]
					.map((line) => JSON.stringify(line))
					.join("\n")}\n`;
				const warnings: string[] = [];
				const startedAt = performance.now();
				const receipt = await captureAndUploadSessionEvidence({
					credentials,
					hookReceivedAt: new Date().toISOString(),
					lifecycle: "checkpoint",
					onWarning: (warning) => warnings.push(warning),
					organizationId: "real-repo-org",
					request: {
						content,
						projectPath: repositoryPath,
						sessionId,
						source: "codex",
						upload_mode: "hook",
					},
					terminalTranscript: false,
				});
				const elapsedMs = Math.round(performance.now() - startedAt);
				assert(receipt);
				const capture = stub.committed.get(receipt.contextId);
				assert(capture);
				expect(await readPendingRepositoryEvidence(configDir)).toEqual([]);
				expect(
					await readdir(join(configDir, "repo-context-spool", "v2")),
				).not.toEqual([]);

				const localContext = capture.manifest.localContext;
				const repositoryRoot = localContext.roots.find(
					(root) => root.id === "repository",
				);
				assert(repositoryRoot);
				const instructionFiles = localContext.entries.filter(
					(entry) =>
						entry.rootId === "repository" &&
						entry.kind === "file" &&
						/^(?:agents|claude)\.md$/iu.test(basename(entry.path)),
				);
				const instructionResults = [];
				for (const entry of instructionFiles) {
					const onDisk = await readFile(
						join(repositoryRoot.absolutePath, entry.path),
					);
					const diskHash = sha256(onDisk);
					if (entry.content?.status === "available") {
						assert(entry.content?.blobId);
						const stored = capture.objects.get(entry.content.blobId);
						assert(stored, `${entry.path} blob was not delivered`);
						expect(entry.content?.secretFilter?.redactedBytes ?? 0).toBe(0);
						expect(sha256(stored)).toBe(diskHash);
						instructionResults.push({
							path: entry.path,
							bytes: onDisk.byteLength,
							stored: "content",
							match: sha256(stored) === diskHash,
						});
					} else {
						// Hash-only by capture policy (skill resources, personal files).
						expect(entry.content?.status).toBe("omitted");
						expect(entry.content?.reason).toBe("metadata-only");
						expect(entry.hash).toMatchObject({
							status: "available",
							scope: "source",
						});
						expect(entry.hash?.value).toBe(diskHash);
						instructionResults.push({
							path: entry.path,
							bytes: onDisk.byteLength,
							stored: "source-hash",
							match: entry.hash?.value === diskHash,
						});
					}
				}
				expect(
					instructionResults.some(
						(result) =>
							result.stored === "content" && result.path === "AGENTS.md",
					) ||
						instructionResults.some(
							(result) =>
								result.stored === "content" && result.path === "CLAUDE.md",
						),
				).toBe(true);
				const gitWorktrees = execFileSync(
					"git",
					["-C", repositoryPath, "worktree", "list", "--porcelain"],
					{ encoding: "utf8" },
				)
					.split("\n")
					.filter((line) => line.startsWith("worktree ")).length;
				const summary = {
					repository: repositoryPath,
					elapsedMs,
					coverage: Object.fromEntries(
						capture.input.coverage.map((item) => [
							item.area,
							item.reason ? `${item.status}: ${item.reason}` : item.status,
						]),
					),
					facets: capture.manifest.contextIndex.facets.map(
						(facet) =>
							`${facet.rootId}/${facet.kind}: ${facet.presence}/${facet.coverage}`,
					),
					roots: localContext.roots.map((root) => `${root.id}: ${root.status}`),
					gitTruncatedSections: localContext.git.truncatedSections ?? [],
					gitWorktrees: {
						onDisk: gitWorktrees,
						captured: localContext.git.worktrees?.length ?? 0,
					},
					limitsReached: localContext.coverage.limitsReached,
					truncated: localContext.coverage.truncated ?? null,
					objects: capture.input.objects.length,
					entries: localContext.entries.length,
					instructions: instructionResults,
					warnings,
				};
				console.log(`REAL_REPO_CAPTURE ${JSON.stringify(summary)}`);
				if (process.env.OPALINE_REAL_REPO_REPORT)
					await writeFile(
						join(
							process.env.OPALINE_REAL_REPO_REPORT,
							`${basename(repositoryPath)}.json`,
						),
						JSON.stringify(summary, null, 2),
					);
				expect(
					capture.input.coverage.filter((item) => item.status !== "complete"),
				).toEqual([]);
				expect(
					capture.manifest.contextIndex.facets.filter(
						(facet) => facet.coverage !== "complete",
					),
				).toEqual([]);
				expect(localContext.git.truncatedSections ?? []).toEqual([]);
				expect(
					localContext.roots.filter(
						(root) => root.status !== "collected" && root.status !== "missing",
					),
				).toEqual([]);
			} finally {
				stub.stop();
			}
		},
	);
});

function sha256(value: Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}
