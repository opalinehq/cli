import { describe, expect, test } from "bun:test";
import { ok as assert } from "node:assert";
import {
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
import {
	REPOSITORY_EVIDENCE_MAX_AGGREGATE_BYTES,
	REPOSITORY_EVIDENCE_MAX_OBJECT_BYTES,
	RepositoryEvidenceCommitInputSchema,
	RepositoryEvidenceInitInputSchema,
} from "../contracts/index.js";
import {
	assessContextSkillUse,
	type GitDiff,
	type GitRepositorySnapshot,
	type LocalContextBundle,
} from "../internal/local-context-source/index.js";
import { FILTER_VERSION } from "../internal/secret-filter/index.js";
import { createRepositoryBundleCandidate } from "../lib/repo-context.js";
import {
	createRepositorySpoolBinding,
	createRepositorySpoolEnv,
	getAcceptedRepositorySpoolParent,
	listRepositorySpool,
	retireAcceptedRepositoryCaptures,
	writeRepositoryBundle,
} from "../lib/repo-spool.js";
import {
	deferPendingRepositoryEvidence,
	readPendingRepositoryEvidence,
	removePendingRepositoryEvidence,
	writePendingRepositoryEvidence,
} from "../lib/repository-evidence-pending.js";
import {
	buildRepositoryEvidenceUpload,
	getTranscriptDeliveryBudget,
	uploadRepositoryEvidence,
} from "../lib/repository-evidence-upload.js";
import {
	continueAcceptedTranscript,
	persistTranscriptSource,
	transcriptSourcePath,
} from "../lib/transcript-continuation.js";
import {
	planTranscriptRevision,
	planTranscriptRevisionFile,
	type TranscriptRevisionScope,
} from "../lib/transcript-revision.js";
import { createCliFixture, runCli } from "./helpers/ingest-stub.js";

const scope: TranscriptRevisionScope = {
	actorId: "user-1",
	provider: "codex",
	providerInstanceId: "local-codex",
	sessionId: "session-1",
};

describe("repository evidence upload building", () => {
	test.each([undefined, "bearer"] as const)(
		"refuses unsupported evidence auth %s before contacting the API",
		async (authType) => {
			const content = '{"ordinal":0}\n';
			const plan = await planTranscriptRevision({
				content: new TextEncoder().encode(content),
				previous: undefined,
				scope,
				terminal: true,
			});
			let requests = 0;
			await expect(
				uploadRepositoryEvidence(buildUploadFor(makeBundle(), plan, content), {
					allowInsecureEndpoint: false,
					authType,
					endpoint: "http://127.0.0.1:1/rpc",
					fetch: async () => {
						requests++;
						throw new Error("Unexpected transport");
					},
					token: "legacy-token",
				}),
			).rejects.toThrow("requires an ingest API key");
			expect(requests).toBe(0);
		},
	);
	test.each([
		{ source: "codex", fixture: "codex-skills.jsonl", subagent: false },
		{ source: "claude_code", fixture: "claude-skills.jsonl", subagent: false },
		{ source: "codex", fixture: "codex-skills.jsonl", subagent: true },
		{ source: "claude_code", fixture: "claude-skills.jsonl", subagent: true },
	] as const)(
		"matches whole-content skill extraction for $source (subagent: $subagent)",
		async ({ source, fixture, subagent }) => {
			const fixtureContent = await readFile(
				join(import.meta.dir, "fixtures", "repository-evidence", fixture),
				"utf8",
			);
			const content = subagent
				? `${fixtureContent.split("\n")[0]}\n`
				: fixtureContent;
			const subagents = subagent
				? [{ agentId: "agent-1", content: fixtureContent }]
				: undefined;
			const observed = new Set<string>(["code-review", "testing-bun"]);
			expect([...observed].sort()).toEqual(["code-review", "testing-bun"]);
			const baseBundle = makeBundle();
			const bundle: LocalContextBundle = {
				...baseBundle,
				manifest: {
					...baseBundle.manifest,
					contextIndex: {
						...baseBundle.manifest.contextIndex,
						skills: [
							...baseBundle.manifest.contextIndex.skills,
							{
								definitions: [],
								discovery: "present",
								name: "code-review",
								nameSource: "definition-directory",
							},
						],
					},
				},
			};
			const plan = await planTranscriptRevision({
				content: new TextEncoder().encode(content),
				previous: undefined,
				scope: { ...scope, provider: source },
				terminal: true,
			});
			const upload = buildRepositoryEvidenceUpload({
				bundle,
				captureLifecycle: "end",
				context: EVIDENCE_CONTEXT,
				firstActionAt: null,
				firstActionBasis: "unavailable",
				firstActionRelationship: "unknown",
				organizationId: "organization-1",
				session: { content, sessionId: scope.sessionId, source, subagents },
				terminalTranscript: true,
				transcriptLastEventAt: null,
				transcriptRevision: plan,
			});
			const manifest = upload.objects.get(upload.input.manifestObjectId);
			assert(manifest);
			expect(
				JSON.parse(new TextDecoder().decode(manifest.bytes)).contextIndex
					.skills,
			).toEqual(
				assessContextSkillUse(bundle.manifest.contextIndex.skills, {
					coverage: "partial",
					observedSkillNames: [...observed],
					scope: { kind: "session", id: scope.sessionId },
				}),
			);
		},
	);

	test.each([FILTER_VERSION - 1, FILTER_VERSION + 1])(
		"quarantines incompatible filter version %s as a warning, not a failure",
		async (filterVersion) => {
			const configDir = await mkdtemp(
				join(tmpdir(), "opaline-filter-upgrade-"),
			);
			const content = '{"ordinal":0}\n';
			const plan = await planTranscriptRevision({
				content: new TextEncoder().encode(content),
				previous: undefined,
				scope,
				terminal: true,
			});
			const oldBundle = makeBundle();
			const bundle = {
				...oldBundle,
				manifest: {
					...oldBundle.manifest,
					transport: {
						...oldBundle.manifest.transport,
						secretFilterVersion: filterVersion,
					},
				},
			};
			await writePendingRepositoryEvidence(
				{
					endpoint: "https://opaline.so/rpc",
					transcriptRevision: plan.manifest,
					upload: buildUploadFor(bundle, plan, content),
				},
				configDir,
			);
			const failures: unknown[] = [];
			const warnings: Error[] = [];
			expect(
				await readPendingRepositoryEvidence(configDir, {
					onError: (error) => failures.push(error),
					onWarning: (warning) => warnings.push(warning),
				}),
			).toEqual([]);
			expect(failures).toEqual([]);
			expect(warnings).toHaveLength(1);
			expect(warnings[0]?.message).toContain("quarantined");
			expect(warnings[0]?.message).toContain("secret filter");
			expect(
				await readdir(
					join(configDir, "repository-evidence-pending", "v4", "quarantine"),
				),
			).toHaveLength(1);
			await rm(configDir, { recursive: true, force: true });
		},
	);

	test("retry reports quarantined evidence distinctly and releases its spool capacity", async () => {
		const fixture = await createCliFixture("codex");
		const configDir = join(fixture.home, ".rudel");
		const endpoint = "https://stored.example/rpc";
		const env = { ...createRepositorySpoolEnv(configDir), maxCaptures: 1 };
		const binding = await createRepositorySpoolBinding({
			accountId: scope.actorId,
			apiBaseUrl: endpoint,
			localIdentity: EVIDENCE_CONTEXT.localIdentity,
			workspaceId: "organization-1",
		});
		const fixtureBundle = makeBundle();
		const baseBundle = {
			manifest: fixtureBundle.manifest,
			blobs: fixtureBundle.blobs,
		};
		const bundle: LocalContextBundle = {
			...baseBundle,
			manifest: {
				...baseBundle.manifest,
				transport: {
					...baseBundle.manifest.transport,
					secretFilterVersion: FILTER_VERSION - 1,
				},
			},
		};
		await writeRepositoryBundle(
			createRepositoryBundleCandidate(bundle),
			binding,
			fixture.projectPath,
			"checkpoint",
			env,
		);
		const content = '{"ordinal":0}\n';
		const plan = await planTranscriptRevision({
			content: new TextEncoder().encode(content),
			previous: undefined,
			scope,
			terminal: true,
		});
		await writePendingRepositoryEvidence(
			{
				endpoint,
				transcriptRevision: plan.manifest,
				upload: buildUploadFor(bundle, plan, content),
			},
			configDir,
		);
		await writeFile(
			join(configDir, "credentials.json"),
			JSON.stringify({
				token: "quarantine-test-token",
				apiBaseUrl: "https://stored.example",
				authType: "api-key",
				user: { id: scope.actorId, email: "user@example.com", name: "User" },
			}),
		);
		const result = await runCli(["upload", "--retry", "--yes"], fixture);
		const output = result.stdout + result.stderr;
		expect(output).toContain("quarantined");
		expect(output).toContain("secret filter");
		expect(output).not.toContain("Repository evidence retry failed");
		expect(output).not.toContain("capture(s) remain");
		expect(result.exitCode).toBe(0);
		expect(await readPendingRepositoryEvidence(configDir)).toEqual([]);
		expect(
			await getAcceptedRepositorySpoolParent(binding, "local-context", env),
		).toBeNull();
		const retirement = await retireAcceptedRepositoryCaptures(binding, env);
		expect(retirement.unsentCaptures).toBe(0);
		expect(retirement.retiredCaptures).toBe(1);
		expect(retirement.freedBytes).toBeGreaterThan(0);
		const replacement = {
			...baseBundle,
			manifest: {
				...baseBundle.manifest,
				captureId: "00000000-0000-4000-8000-000000000003",
			},
		};
		expect(
			(
				await writeRepositoryBundle(
					createRepositoryBundleCandidate(replacement),
					binding,
					fixture.projectPath,
					"checkpoint",
					env,
				)
			).created,
		).toBe(true);
		expect(
			(await listRepositorySpool(binding, fixture.projectPath, env)).quota
				.captureCount,
		).toBe(1);
		await rm(fixture.home, { recursive: true, force: true });
	}, 30_000);

	test("persists a terminal continuation across interruption and bounded retry deliveries", async () => {
		const configDir = await mkdtemp(
			join(tmpdir(), "opaline-terminal-continuation-"),
		);
		const content = Array.from(
			{ length: 7 },
			(_, ordinal) => `${JSON.stringify({ ordinal, text: "café" })}\n`,
		).join("");
		const sourceId = await persistTranscriptSource(content, configDir);
		const plan = await planTranscriptRevisionFile({
			path: transcriptSourcePath(configDir, sourceId),
			previous: undefined,
			limits: { maxDeliveryBytes: 65 },
			scope,
			terminal: true,
		});
		expect(plan.delivery.status).toBe("deferred");
		for (const chunk of plan.newChunks)
			expect(chunk.bytes.buffer.byteLength).toBe(chunk.bytes.byteLength);
		const initial = {
			endpoint: "https://opaline.so/rpc",
			transcriptRevision: plan.manifest,
			upload: buildUploadFor(makeBundle(), plan, content),
			continuation: { sourceId, terminal: true },
		};
		await writePendingRepositoryEvidence(initial, configDir);
		await continueAcceptedTranscript(initial, configDir, 65);
		const bytes = [...plan.newChunks.map((chunk) => chunk.bytes)];
		let deliveries = 1;
		let terminal = false;
		for (let attempts = 0; attempts < 10; attempts++) {
			const [pending] = await readPendingRepositoryEvidence(configDir);
			if (!pending) break;
			deliveries++;
			terminal = pending.transcriptRevision.terminal;
			bytes.push(
				...[...pending.upload.objects.values()]
					.filter((object) => object.descriptor.kind === "transcript-chunk")
					.map((object) => object.bytes),
			);
			await continueAcceptedTranscript(pending, configDir, 65);
		}
		expect(deliveries).toBeGreaterThan(2);
		expect(terminal).toBe(true);
		expect(Buffer.concat(bytes).toString("utf8")).toBe(content);
		expect(await readPendingRepositoryEvidence(configDir)).toEqual([]);
		expect(
			await readdir(join(configDir, "repository-evidence-sources")),
		).toEqual([]);
		await rm(configDir, { recursive: true, force: true });
	});
	test("upload --retry finishes a persisted terminal tail without another hook", async () => {
		const fixture = await createCliFixture("codex");
		const configDir = join(fixture.home, ".rudel");
		const content = Array.from(
			{ length: 7 },
			(_, ordinal) => `${JSON.stringify({ ordinal, text: "café" })}\n`,
		).join("");
		const sourceId = await persistTranscriptSource(content, configDir);
		const plan = await planTranscriptRevisionFile({
			path: transcriptSourcePath(configDir, sourceId),
			previous: undefined,
			limits: { maxDeliveryBytes: 65 },
			scope,
			terminal: true,
		});
		const initial = buildUploadFor(makeBundle(), plan, content);
		const deliveries: ReturnType<
			typeof RepositoryEvidenceInitInputSchema.parse
		>[] = [];
		const received = new Map<string, Buffer>();
		const uploadReceiptId = "00000000-0000-4000-8000-000000000010";
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				const url = new URL(request.url);
				if (request.method === "PUT") {
					received.set(
						decodeURIComponent(url.pathname.slice("/objects/".length)),
						Buffer.from(await request.arrayBuffer()),
					);
					return new Response(null, { headers: { etag: '"accepted"' } });
				}
				const { json } = (await request.json()) as { json: unknown };
				if (url.pathname.endsWith("/init")) {
					const input = RepositoryEvidenceInitInputSchema.parse(json);
					deliveries.push(input);
					return Response.json({
						json: {
							expiresAt: "2027-01-01T00:00:00.000Z",
							missingObjects: input.objects.map((object) => ({
								byteLength: object.byteLength,
								objectId: object.objectId,
								objectKey: object.objectId,
								uploadId: "upload",
								parts: [
									{
										partNumber: 1,
										byteLength: object.byteLength,
										uploadUrl: `${url.origin}/objects/${encodeURIComponent(object.objectId)}`,
										headers: { "Content-Length": String(object.byteLength) },
									},
								],
							})),
							partSizeBytes: 8 * 1024 * 1024,
							protocol: input.protocol,
							reusedObjectIds: [],
							uploadReceiptId,
						},
					});
				}
				RepositoryEvidenceCommitInputSchema.parse(json);
				const input = deliveries.at(-1);
				assert(input);
				return Response.json({
					json: {
						acceptedAt: "2026-09-30T00:00:00.000Z",
						contextId: input.capture.contextId,
						manifestObjectId: input.manifestObjectId,
						protocol: input.protocol,
						receiptId: "00000000-0000-4000-8000-000000000011",
						status: "accepted",
						storedObjectIds: input.objects.map((object) => object.objectId),
						uploadReceiptId,
					},
				});
			},
		});
		try {
			const apiBaseUrl = `http://127.0.0.1:${server.port}`;
			await writePendingRepositoryEvidence(
				{
					endpoint: `${apiBaseUrl}/rpc`,
					transcriptRevision: plan.manifest,
					upload: initial,
					continuation: { sourceId, terminal: true },
				},
				configDir,
			);
			await writeFile(
				join(configDir, "credentials.json"),
				JSON.stringify({
					apiBaseUrl,
					authType: "api-key",
					token: "test",
					user: {
						id: scope.actorId,
						email: "test@example.invalid",
						name: "Test",
					},
				}),
			);
			const result = await runCli(["upload", "--retry", "--yes"], fixture, {
				env: {
					OPALINE_ALLOW_INSECURE_ENDPOINT: "1",
					RUDEL_ALLOW_INSECURE_ENDPOINT: "1",
				},
			});
			expect(result.exitCode).toBe(0);
			expect(deliveries).toHaveLength(2);
			const chunks = deliveries.flatMap((delivery) =>
				delivery.objects
					.filter((object) => object.kind === "transcript-chunk")
					.map((object) => received.get(object.objectId)),
			);
			assert(chunks.every((chunk) => chunk !== undefined));
			expect(Buffer.concat(chunks).toString("utf8")).toBe(content);
			const last = deliveries.at(-1);
			assert(last);
			const manifestBytes = received.get(last.manifestObjectId);
			assert(manifestBytes);
			expect(
				JSON.parse(manifestBytes.toString("utf8")).transcriptRevision.terminal,
			).toBe(true);
			expect(await readPendingRepositoryEvidence(configDir)).toEqual([]);
			expect(
				await readdir(join(configDir, "repository-evidence-sources")),
			).toEqual([]);
		} finally {
			await server.stop(true);
			await rm(fixture.home, { recursive: true, force: true });
		}
	}, 30_000);

	test("includes every transcript chunk referenced by a new delivery namespace", async () => {
		const content =
			'{"ordinal":0,"type":"turn","text":"first"}\n' +
			'{"ordinal":1,"type":"turn","text":"second"}\n';
		const firstInNamespace = await planTranscriptRevision({
			content: new TextEncoder().encode(content),
			previous: undefined,
			scope,
			terminal: false,
		});
		const upload = buildRepositoryEvidenceUpload({
			bundle: makeBundle(),
			captureLifecycle: "checkpoint",
			context: {
				localIdentity: {
					installationId: "00000000-0000-4000-8000-000000000001",
					repositoryId: `local-repository:${"a".repeat(64)}`,
					worktreeId: `local-worktree:${"b".repeat(64)}`,
				},
				remoteHint: null,
			},
			firstActionAt: null,
			firstActionBasis: "unavailable",
			firstActionRelationship: "unknown",
			organizationId: "new-organization",
			session: {
				content,
				sessionId: scope.sessionId,
				source: scope.provider,
				subagents: undefined,
			},
			terminalTranscript: false,
			transcriptLastEventAt: null,
			transcriptRevision: firstInNamespace,
		});
		const transcriptObjectIds = upload.input.objects
			.filter((object) => object.kind === "transcript-chunk")
			.map((object) => object.objectId);
		const referencedObjectIds = firstInNamespace.manifest.chunks.map(
			(chunk) => `sha256:${chunk.sha256}`,
		);

		expect(firstInNamespace.manifest.parentRevisionId).toBeUndefined();
		expect(firstInNamespace.newChunks).toHaveLength(
			firstInNamespace.manifest.chunks.length,
		);
		expect(transcriptObjectIds).toEqual(referencedObjectIds);
		expect(
			transcriptObjectIds.every((objectId) => upload.objects.has(objectId)),
		).toBe(true);
		expect(
			new TextDecoder().decode(
				upload.objects.get(transcriptObjectIds[0] ?? "")?.bytes,
			),
		).toBe(content);
	});

	test("uploads only the incremental transcript chunk and preserves the context index", async () => {
		const firstRecord = '{"ordinal":0,"type":"turn","text":"first"}\n';
		const secondRecord = '{"ordinal":1,"type":"turn","text":"second"}\n';
		const first = await planTranscriptRevision({
			content: new TextEncoder().encode(firstRecord),
			previous: undefined,
			scope,
			terminal: false,
		});
		const second = await planTranscriptRevision({
			content: new TextEncoder().encode(firstRecord + secondRecord),
			previous: first.manifest,
			scope,
			terminal: false,
		});

		const upload = buildRepositoryEvidenceUpload({
			bundle: makeBundle(),
			captureLifecycle: "checkpoint",
			context: {
				localIdentity: {
					installationId: "00000000-0000-4000-8000-000000000001",
					repositoryId: `local-repository:${"a".repeat(64)}`,
					worktreeId: `local-worktree:${"b".repeat(64)}`,
				},
				remoteHint: {
					host: "github.com",
					name: "athena",
					owner: "opalinehq",
					provider: "github",
				},
			},
			firstActionAt: null,
			firstActionBasis: "unavailable",
			firstActionRelationship: "unknown",
			organizationId: "organization-1",
			session: {
				content: firstRecord + secondRecord,
				sessionId: scope.sessionId,
				source: "codex",
				subagents: undefined,
			},
			terminalTranscript: false,
			transcriptLastEventAt: null,
			transcriptRevision: second,
		});

		expect(() =>
			RepositoryEvidenceInitInputSchema.parse(upload.input),
		).not.toThrow();
		const transcriptObjects = [...upload.objects.values()].filter(
			(object) => object.descriptor.kind === "transcript-chunk",
		);
		expect(transcriptObjects).toHaveLength(1);
		expect(new TextDecoder().decode(transcriptObjects[0]?.bytes)).toBe(
			secondRecord,
		);
		expect(upload.input.capture.transcriptWatermark).toEqual({
			byteOffset: new TextEncoder().encode(firstRecord + secondRecord)
				.byteLength,
			eventOrdinal: 1,
			lastEventAt: null,
		});
		expect(upload.input.repository).toMatchObject({
			provider: null,
			remoteHint: {
				host: "github.com",
				name: "athena",
				owner: "opalinehq",
				provider: "github",
			},
		});

		const manifestObject = upload.objects.get(upload.input.manifestObjectId);
		expect(manifestObject).toBeDefined();
		if (!manifestObject) throw new Error("Expected a context manifest object");
		const manifestValue: unknown = JSON.parse(
			new TextDecoder().decode(manifestObject.bytes),
		);
		expect(manifestValue).toMatchObject({
			contextIndex: {
				facets: [
					{
						coverage: "complete",
						kind: "agents-instructions",
						presence: "present",
						resources: [
							{
								access: { status: "readable" },
								path: "AGENTS.md",
								rootId: "repository",
							},
						],
						rootId: "repository",
					},
				],
				skills: [
					{
						definitions: [
							{
								access: { status: "readable" },
								path: ".claude/skills/testing-bun/SKILL.md",
								rootId: "repository",
							},
						],
						discovery: "present",
						name: "testing-bun",
						nameSource: "definition-directory",
						use: {
							evidenceScope: { id: scope.sessionId, kind: "session" },
							reason: "partial-evidence",
							status: "unknown",
						},
					},
				],
			},
			transcriptRevision: {
				chunks: [first.manifest.chunks[0], second.manifest.chunks[1]],
				parentRevisionId: first.manifest.revisionId,
				revisionId: second.manifest.revisionId,
			},
		});
		const configDir = await mkdtemp(
			join(tmpdir(), "opaline-evidence-pending-"),
		);
		const pendingPath = await writePendingRepositoryEvidence(
			{
				endpoint: "https://opaline.so/rpc",
				transcriptRevision: second.manifest,
				upload,
			},
			configDir,
		);
		const [restored] = await readPendingRepositoryEvidence(configDir);
		expect(restored?.upload.input).toEqual(upload.input);
		expect(restored?.endpoint).toBe("https://opaline.so/rpc");
		expect(
			await readPendingRepositoryEvidence(configDir, {
				actorId: "another-user",
				endpoint: "https://opaline.so/rpc",
			}),
		).toEqual([]);
		expect(restored?.transcriptRevision).toEqual(second.manifest);
		expect(
			[...(restored?.upload.objects.values() ?? [])].map((object) => ({
				bytes: [...object.bytes],
				descriptor: object.descriptor,
			})),
		).toEqual(
			[...upload.objects.values()].map((object) => ({
				bytes: [...object.bytes],
				descriptor: object.descriptor,
			})),
		);
		if (process.platform !== "win32") {
			expect((await stat(pendingPath)).mode & 0o777).toBe(0o600);
		}
		const secondPending = {
			endpoint: "https://opaline.so/rpc",
			transcriptRevision: second.manifest,
			upload: {
				input: {
					...upload.input,
					operationId: "00000000-0000-4000-8000-000000000099",
				},
				objects: upload.objects,
			},
		};
		await writePendingRepositoryEvidence(secondPending, configDir);
		if (!restored) throw new Error("Expected restored pending evidence");
		await deferPendingRepositoryEvidence(restored, configDir);
		const [nextAfterDeferred] = await readPendingRepositoryEvidence(configDir, {
			actorId: scope.actorId,
			endpoint: "https://opaline.so/rpc",
			maxItems: 1,
		});
		expect(nextAfterDeferred?.upload.input.operationId).toBe(
			secondPending.upload.input.operationId,
		);
		const stored = await readFile(pendingPath, "utf8");
		const pendingValue = JSON.parse(stored) as {
			objects: Array<{ bytes: string }>;
		};
		const firstPendingObject = pendingValue.objects[0];
		if (!firstPendingObject) throw new Error("Expected a pending object");
		firstPendingObject.bytes = Buffer.from("tampered").toString("base64");
		await writeFile(pendingPath, JSON.stringify(pendingValue), "utf8");
		let corruptCount = 0;
		const validAfterCorrupt = await readPendingRepositoryEvidence(configDir, {
			actorId: scope.actorId,
			endpoint: "https://opaline.so/rpc",
			onError: () => corruptCount++,
		});
		expect(corruptCount).toBe(1);
		expect(
			validAfterCorrupt.map((item) => item.upload.input.operationId),
		).toEqual([secondPending.upload.input.operationId]);
		expect(
			await readdir(
				join(configDir, "repository-evidence-pending", "v4", "quarantine"),
			),
		).toHaveLength(1);
		await deferPendingRepositoryEvidence(restored, configDir);
		await removePendingRepositoryEvidence(secondPending, configDir);
		expect(await readPendingRepositoryEvidence(configDir)).toEqual([]);
		const legacyDirectory = join(
			configDir,
			"repository-evidence-pending",
			"v3",
		);
		await mkdir(legacyDirectory, { recursive: true });
		await writeFile(
			join(legacyDirectory, "legacy.json"),
			"legacy pending bytes",
		);
		const warnings: Error[] = [];
		expect(
			await readPendingRepositoryEvidence(configDir, {
				onWarning: (warning) => warnings.push(warning),
			}),
		).toEqual([]);
		expect(warnings.map((warning) => warning.message)).toEqual([
			expect.stringContaining("Run a new session capture"),
		]);
		expect(await readdir(legacyDirectory)).toEqual([]);
		expect(
			await readdir(
				join(configDir, "repository-evidence-pending", "v4", "quarantine"),
			),
		).toHaveLength(2);
		await rm(configDir, { force: true, recursive: true });
	});
});

describe("repository evidence coverage derived from collector outcomes", () => {
	test("reports complete git-state and task-delta only when every command and diff succeeded", async () => {
		const coverage = await buildCoverageFor(
			makeAvailableGitBundle({
				diffs: [emptyDiff("working-tree"), blobDiff("staged")],
			}),
		);

		expect(coverage.get("git-state")).toEqual({
			area: "git-state",
			reason: null,
			status: "complete",
		});
		expect(coverage.get("task-delta")).toEqual({
			area: "task-delta",
			reason: null,
			status: "complete",
		});
	});

	test("does not report a truncated working-tree diff as complete", async () => {
		const bundle = makeAvailableGitBundle({
			diffs: [truncatedDiff("working-tree"), blobDiff("staged")],
			truncatedSections: ["working-diff"],
		});

		const coverage = await buildCoverageFor(bundle);

		expect(coverage.get("task-delta")).toMatchObject({
			reason: expect.stringContaining("Working-tree diff exceeded"),
			status: "partial",
		});
		expect(coverage.get("git-state")?.status).toBe("complete");
	});

	test("reports task-delta unavailable when no patch was captured", async () => {
		const bundle = makeAvailableGitBundle({
			diffs: [truncatedDiff("working-tree"), truncatedDiff("staged")],
			truncatedSections: ["staged-diff", "working-diff"],
		});

		const coverage = await buildCoverageFor(bundle);

		expect(coverage.get("task-delta")?.status).toBe("unavailable");
	});

	test("propagates failed Git subcommands into the matching coverage areas", async () => {
		const failedDiff = makeAvailableGitBundle({
			diffs: [omittedFailureDiff("working-tree"), blobDiff("staged")],
			errors: ["working-diff: fatal: bad revision"],
		});
		const failedStatus = makeAvailableGitBundle({
			diffs: [emptyDiff("working-tree"), emptyDiff("staged")],
			errors: ["status: fatal: index file corrupt"],
		});
		const failedBothDiffs = makeAvailableGitBundle({
			diffs: [omittedFailureDiff("working-tree"), omittedFailureDiff("staged")],
			errors: [
				"staged-diff: command timed out",
				"working-diff: command failed",
			],
		});

		const diffCoverage = await buildCoverageFor(failedDiff);
		const statusCoverage = await buildCoverageFor(failedStatus);
		const bothCoverage = await buildCoverageFor(failedBothDiffs);

		expect(diffCoverage.get("task-delta")).toMatchObject({
			reason: expect.stringContaining("fatal: bad revision"),
			status: "partial",
		});
		expect(diffCoverage.get("git-state")?.status).toBe("complete");
		expect(statusCoverage.get("git-state")).toMatchObject({
			reason: expect.stringContaining("status"),
			status: "partial",
		});
		expect(statusCoverage.get("task-delta")?.status).toBe("complete");
		expect(bothCoverage.get("task-delta")?.status).toBe("unavailable");
	});

	test("marks git-state and task-delta partial after a concurrent change", async () => {
		const bundle = makeAvailableGitBundle({
			consistency: "concurrent-change",
			diffs: [emptyDiff("working-tree"), blobDiff("staged")],
		});

		const coverage = await buildCoverageFor(bundle);

		for (const area of ["git-state", "task-delta"] as const) {
			expect(coverage.get(area)).toMatchObject({
				reason: expect.stringContaining("changed while"),
				status: "partial",
			});
		}
		expect(coverage.get("effective-instructions")?.status).toBe("complete");
	});

	test("marks patches with uncaptured binary content partial", async () => {
		const bundle = makeAvailableGitBundle({
			diffs: [
				{ ...blobDiff("working-tree"), containsBinaryChanges: true },
				emptyDiff("staged"),
			],
		});

		const coverage = await buildCoverageFor(bundle);

		expect(coverage.get("task-delta")).toMatchObject({
			reason: expect.stringContaining("binary"),
			status: "partial",
		});
	});

	test("reports deferred and blocked transcript delivery instead of a complete watermark", async () => {
		const content = '{"ordinal":0,"text":"one"}\n{"ordinal":1,"text":"two"}\n';
		const recordBytes = content.length / 2;
		const deferred = await buildCoverageFor(makeBundle(), {
			content,
			limits: { maxDeliveryBytes: recordBytes },
		});
		const blocked = await buildCoverageFor(makeBundle(), {
			content,
			limits: { maxDeliveryBytes: recordBytes - 1 },
		});
		const complete = await buildCoverageFor(makeBundle(), { content });

		expect(deferred.get("transcript-watermark")?.status).toBe("partial");
		expect(blocked.get("transcript-watermark")?.status).toBe("unavailable");
		expect(complete.get("transcript-watermark")?.status).toBe("complete");
	});
});

describe("repository evidence delivery limits", () => {
	const kibibyte = 1024;
	const limits = {
		maxAggregateBytes: 128 * kibibyte,
		manifestHeadroomBytes: 8 * kibibyte,
	};
	const maxChunkBytes = 64 * kibibyte;

	test("bounds a transcript delivery so the built upload fits the aggregate limit", async () => {
		const bundle = makeBundle();
		const budget = getTranscriptDeliveryBudget(bundle, limits);
		const plan = await planTranscriptRevision({
			content: buildRecordsOfExactSize(129, kibibyte),
			limits: { maxChunkBytes, maxDeliveryBytes: budget },
			previous: undefined,
			scope,
			terminal: false,
		});

		const upload = buildUploadFor(bundle, plan, "", limits);
		const aggregate = upload.input.objects.reduce(
			(total, object) => total + object.byteLength,
			0,
		);

		expect(plan.delivery.status).toBe("deferred");
		expect(plan.manifest.watermark.byteOffset).toBeLessThanOrEqual(budget);
		expect(aggregate).toBeLessThanOrEqual(limits.maxAggregateBytes);
		expect(aggregate).toBeLessThanOrEqual(
			REPOSITORY_EVIDENCE_MAX_AGGREGATE_BYTES,
		);
		for (const object of upload.input.objects) {
			expect(object.byteLength).toBeLessThanOrEqual(
				REPOSITORY_EVIDENCE_MAX_OBJECT_BYTES,
			);
		}
		for (const chunk of plan.newChunks) {
			expect(chunk.bytes.byteLength).toBeLessThanOrEqual(maxChunkBytes);
		}
	});

	test("rejects an over-limit delivery before anything can be spooled", async () => {
		const unbounded = await planTranscriptRevision({
			content: buildRecordsOfExactSize(128, kibibyte),
			limits: { maxChunkBytes, maxDeliveryBytes: limits.maxAggregateBytes },
			previous: undefined,
			scope,
			terminal: false,
		});

		expect(unbounded.delivery.status).toBe("complete");
		expect(unbounded.manifest.watermark.byteOffset).toBe(
			limits.maxAggregateBytes,
		);
		expect(() => buildUploadFor(makeBundle(), unbounded, "", limits)).toThrow(
			/Aggregate evidence exceeds/u,
		);
		const upload = buildUploadFor(makeBundle(), unbounded, "");
		const aggregate = upload.input.objects.reduce(
			(total, object) => total + object.byteLength,
			0,
		);
		expect(() =>
			buildUploadFor(makeBundle(), unbounded, "", {
				maxAggregateBytes: aggregate,
			}),
		).not.toThrow();
		expect(() =>
			buildUploadFor(makeBundle(), unbounded, "", {
				maxAggregateBytes: aggregate - 1,
			}),
		).toThrow(/Aggregate evidence exceeds/u);
	});

	test("rejects pending evidence that exceeds the spool quota before writing any bytes", async () => {
		const configDir = await mkdtemp(join(tmpdir(), "opaline-evidence-quota-"));
		const content = '{"ordinal":0,"text":"quota"}\n';
		const plan = await planTranscriptRevision({
			content: new TextEncoder().encode(content),
			previous: undefined,
			scope,
			terminal: false,
		});
		const upload = buildUploadFor(makeBundle(), plan, content);
		const pending = {
			endpoint: "https://opaline.so/rpc",
			transcriptRevision: plan.manifest,
			upload,
		};
		const pendingDirectory = join(
			configDir,
			"repository-evidence-pending",
			"v4",
		);

		await expect(
			writePendingRepositoryEvidence(pending, configDir, {
				maxFiles: 10,
				maxTotalBytes: 1024,
			}),
		).rejects.toThrow(/quota exceeded/u);
		expect(await readdir(pendingDirectory)).toEqual([]);

		await writePendingRepositoryEvidence(pending, configDir, {
			maxFiles: 1,
			maxTotalBytes: 1024 * 1024,
		});
		const second = {
			...pending,
			upload: {
				...upload,
				input: {
					...upload.input,
					operationId: "00000000-0000-4000-8000-0000000000aa",
				},
			},
		};
		await expect(
			writePendingRepositoryEvidence(second, configDir, {
				maxFiles: 1,
				maxTotalBytes: 1024 * 1024,
			}),
		).rejects.toThrow(/quota exceeded/u);
		expect(await readdir(pendingDirectory)).toHaveLength(1);
		await rm(configDir, { force: true, recursive: true });
	});
});

function buildRecordsOfExactSize(count: number, recordBytes: number): Buffer {
	const records: Buffer[] = [];
	for (let index = 0; index < count; index += 1) {
		const prefix = `{"ordinal":${String(index).padStart(6, "0")},"text":"`;
		const suffix = '"}\n';
		records.push(
			Buffer.from(
				`${prefix}${"x".repeat(recordBytes - prefix.length - suffix.length)}${suffix}`,
			),
		);
	}
	return Buffer.concat(records);
}

const EVIDENCE_CONTEXT = {
	localIdentity: {
		installationId: "00000000-0000-4000-8000-000000000001",
		repositoryId: `local-repository:${"a".repeat(64)}`,
		worktreeId: `local-worktree:${"b".repeat(64)}`,
	},
	remoteHint: null,
} as const;

function buildUploadFor(
	bundle: LocalContextBundle,
	transcriptRevision: Awaited<ReturnType<typeof planTranscriptRevision>>,
	content: string,
	limits?: Parameters<typeof getTranscriptDeliveryBudget>[1],
) {
	return buildRepositoryEvidenceUpload(
		{
			bundle,
			captureLifecycle: "checkpoint",
			context: EVIDENCE_CONTEXT,
			firstActionAt: null,
			firstActionBasis: "unavailable",
			firstActionRelationship: "unknown",
			organizationId: "organization-1",
			session: {
				content,
				sessionId: scope.sessionId,
				source: scope.provider,
				subagents: undefined,
			},
			terminalTranscript: false,
			transcriptLastEventAt: null,
			transcriptRevision,
		},
		limits,
	);
}

async function buildCoverageFor(
	bundle: LocalContextBundle,
	transcript: {
		readonly content: string;
		readonly limits?: { readonly maxDeliveryBytes: number };
	} = { content: '{"ordinal":0,"text":"coverage"}\n' },
) {
	const plan = await planTranscriptRevision({
		content: new TextEncoder().encode(transcript.content),
		limits: transcript.limits,
		previous: undefined,
		scope,
		terminal: false,
	});
	const upload = buildUploadFor(bundle, plan, transcript.content);
	return new Map(upload.input.coverage.map((item) => [item.area, item]));
}

interface AvailableGitOptions {
	readonly consistency?: "stable" | "concurrent-change" | "unavailable";
	readonly diffs: readonly GitDiff[];
	readonly errors?: readonly string[];
	readonly truncatedSections?: readonly string[];
}

function makeAvailableGitBundle(
	options: AvailableGitOptions,
): LocalContextBundle {
	const base = makeBundle();
	const git: GitRepositorySnapshot = {
		bare: false,
		commits: [],
		commonDirectory: "/repo/.git",
		diffs: options.diffs,
		errors: options.errors ?? [],
		gitDirectory: "/repo/.git",
		head: { branch: "main", commit: "a".repeat(40), detached: false },
		remotes: [],
		root: "/repo",
		status: "available",
		statusEntries: [],
		truncatedSections: options.truncatedSections ?? [],
		worktrees: [],
	};
	return {
		...base,
		manifest: {
			...base.manifest,
			consistency: {
				...base.manifest.consistency,
				status: options.consistency ?? "stable",
			},
			git,
		},
	};
}

function emptyDiff(kind: GitDiff["kind"]): GitDiff {
	return {
		blobId: null,
		containsBinaryChanges: false,
		highRiskPathsExcluded: true,
		kind,
		omissionReason: "empty",
		reconstructable: true,
		secretFilter: null,
		sourceByteLength: 0,
		storedByteLength: 0,
		truncated: false,
	};
}

function truncatedDiff(kind: GitDiff["kind"]): GitDiff {
	return {
		...emptyDiff(kind),
		omissionReason: "truncated",
		reconstructable: false,
		truncated: true,
	};
}

function omittedFailureDiff(kind: GitDiff["kind"]): GitDiff {
	return {
		...emptyDiff(kind),
		omissionReason: "secret-filter-failure",
		reconstructable: false,
	};
}

function blobDiff(kind: GitDiff["kind"]): GitDiff {
	return {
		...emptyDiff(kind),
		blobId: `sha256:${"c".repeat(64)}`,
		omissionReason: null,
		sourceByteLength: 10,
		storedByteLength: 10,
	};
}

function makeBundle(): LocalContextBundle {
	return {
		blobs: [],
		manifest: {
			baseGitCommit: null,
			captureId: "00000000-0000-4000-8000-000000000002",
			capturePolicy: "session-evidence",
			collectedAt: "2026-09-19T10:00:01.000Z",
			collectorVersion: 2,
			completedAt: "2026-09-19T10:00:01.000Z",
			consistency: {
				atomic: false,
				finalHead: null,
				finalStatusFingerprint: null,
				initialHead: null,
				initialStatusFingerprint: null,
				status: "unavailable",
			},
			contextIndex: {
				facets: [
					{
						coverage: "complete",
						kind: "agents-instructions",
						presence: "present",
						resources: [
							{
								access: { status: "readable" },
								path: "AGENTS.md",
								rootId: "repository",
							},
						],
						rootId: "repository",
					},
				],
				skills: [
					{
						definitions: [
							{
								access: { status: "readable" },
								path: ".claude/skills/testing-bun/SKILL.md",
								rootId: "repository",
							},
						],
						discovery: "present",
						name: "testing-bun",
						nameSource: "definition-directory",
					},
				],
			},
			coverage: {
				blobCount: 0,
				contentBytes: 0,
				contentFiles: 0,
				discoveredEntries: 0,
				errors: [],
				excludedPaths: [],
				gitObjectBytes: 0,
				hashedBytes: 0,
				hashedFiles: 0,
				inventoryBytes: 0,
				limitsReached: [],
				materializedBytes: 0,
				omittedBytes: 0,
				omittedContentFiles: 0,
				partial: false,
				partialReasons: [],
				redactedBytes: 0,
				redactionCounts: {},
				reusedBytes: 0,
				uploadCandidateBytes: 0,
			},
			documents: {
				agentConfigs: [],
				hookConfigs: [],
				instructions: [{ path: "AGENTS.md", rootId: "repository" }],
				markdown: [{ path: "AGENTS.md", rootId: "repository" }],
				mcpConfigs: [],
				packageContexts: [],
				planCandidates: [],
				skillDefinitions: [
					{
						path: ".claude/skills/testing-bun/SKILL.md",
						rootId: "repository",
					},
				],
				skillResources: [],
			},
			entries: [],
			git: {
				detail: "fixture has no Git subprocess",
				reason: "not-a-repository",
				status: "unavailable",
			},
			lifecycle: "sanitized-local-spool",
			parentCaptureId: null,
			repositoryRootId: "repository",
			roots: [
				{
					absolutePath: "/repo",
					coverage: {
						contentBytes: 0,
						contentFiles: 0,
						directoryCount: 0,
						discoveredEntries: 0,
						excludedPaths: 0,
						fileCount: 0,
						hashedBytes: 0,
						hashedFiles: 0,
						limitsReached: [],
						omittedContentFiles: 0,
						otherCount: 0,
						rootId: "repository",
						submoduleCount: 0,
						symlinkCount: 0,
					},
					id: "repository",
					label: "Repository",
					origin: "repository",
					scope: "repository",
					status: "collected",
				},
			],
			schemaVersion: "1.1.0",
			startedAt: "2026-09-19T10:00:00.000Z",
			transport: {
				rawContentIncluded: false,
				requiresAdditionalReview: true,
				secretFilterApplied: true,
				secretFilterVersion: FILTER_VERSION,
			},
		},
	};
}
