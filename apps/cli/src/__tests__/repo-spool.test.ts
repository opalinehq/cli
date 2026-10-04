import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	stat,
	utimes,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createRepositorySpoolBinding,
	createRepositorySpoolEnv,
	getAcceptedRepositorySpoolParent,
	listRepositorySpool,
	markRepositorySpoolCaptureAbandoned,
	markRepositorySpoolCaptureAccepted,
	planRepositoryBundle,
	type RepositoryBundleCandidate,
	type RepositorySpoolBlob,
	type RepositorySpoolEnv,
	writeRepositoryBundle,
} from "../lib/repo-spool.js";

const tempRoot = await mkdtemp(join(tmpdir(), "opaline-repo-spool-"));
const repositoryRoot = join(tempRoot, "repository");
await mkdir(repositoryRoot, { recursive: true });
await Bun.write(join(repositoryRoot, ".keep"), "repository");

afterAll(async () => {
	await rm(tempRoot, { recursive: true, force: true });
});

describe("repository spool", () => {
	test("stores private immutable captures and never includes content in summaries", async () => {
		const env = createRepositorySpoolEnv(join(tempRoot, "private"));
		const binding = await makeBinding(repositoryRoot, env, "account-a");
		const secret = "private-token-value";
		const candidate = makeCandidate({
			captureId: "capture-private",
			capturedAt: "2026-09-18T10:00:00.000Z",
			contents: [secret],
		});

		const result = await writeRepositoryBundle(
			candidate,
			binding,
			repositoryRoot,
			"manual",
			env,
		);
		const listing = await listRepositorySpool(binding, repositoryRoot, env);

		expect(result.created).toBe(true);
		expect(result.capture.captureLifecycle).toBe("manual");
		expect(result.capture.integrity).toBe("valid");
		expect(JSON.stringify({ result, listing })).not.toContain(secret);
		expect(listing.retention).toEqual({
			automaticCleanup: true,
			policy: "retire-accepted-on-quota-pressure",
			oldestCaptureAt: "2026-09-18T10:00:00.000Z",
			abandonedTemporaryFiles: 0,
		});

		const paths = await walk(join(env.configDir, "repo-context-spool"));
		for (const path of paths.directories) {
			if (process.platform !== "win32") {
				expect((await stat(path)).mode & 0o777).toBe(0o700);
			}
		}
		for (const path of paths.files) {
			if (process.platform !== "win32") {
				expect((await stat(path)).mode & 0o777).toBe(0o600);
			}
		}
	});

	test("deduplicates repeated captures and charges quotas only for new stored bytes", async () => {
		const env = createRepositorySpoolEnv(join(tempRoot, "dedupe"));
		const binding = await makeBinding(repositoryRoot, env, "account-a");
		const first = makeCandidate({
			captureId: "capture-one",
			capturedAt: "2026-09-18T10:01:00.000Z",
			contents: ["unchanged tracked body"],
		});
		await writeRepositoryBundle(first, binding, repositoryRoot, "manual", env);
		const second = makeCandidate({
			captureId: "capture-two",
			capturedAt: "2026-09-18T10:02:00.000Z",
			contents: ["unchanged tracked body"],
			parentCaptureId: first.captureId,
		});

		const plan = await planRepositoryBundle(
			second,
			binding,
			repositoryRoot,
			"checkpoint",
			env,
		);
		const result = await writeRepositoryBundle(
			second,
			binding,
			repositoryRoot,
			"checkpoint",
			env,
		);

		expect(plan.newlyMaterializedBytes).toBe(0);
		expect(plan.reusedBytes).toBe(Buffer.byteLength("unchanged tracked body"));
		expect(plan.storedNewBytes).toBe(plan.captureRecordBytes);
		expect(result.capture.parentCaptureId).toBe("capture-one");
		expect(result.quota.blobCount).toBe(1);
		expect(result.quota.captureCount).toBe(2);
	});

	test("recovers from an atomic capture-commit failure without publishing a partial capture", async () => {
		const baseEnv = createRepositorySpoolEnv(join(tempRoot, "atomic"));
		const binding = await makeBinding(repositoryRoot, baseEnv, "account-a");
		const candidate = makeCandidate({
			captureId: "capture-atomic",
			capturedAt: "2026-09-18T10:03:00.000Z",
			contents: ["recoverable blob"],
		});
		const failingEnv: RepositorySpoolEnv = {
			...baseEnv,
			commitImmutableFile: async (temporaryPath, finalPath) => {
				if (finalPath.endsWith(".capture.json")) {
					throw new Error("simulated capture commit failure");
				}
				await baseEnv.commitImmutableFile(temporaryPath, finalPath);
			},
		};

		await expect(
			writeRepositoryBundle(
				candidate,
				binding,
				repositoryRoot,
				"manual",
				failingEnv,
			),
		).rejects.toThrow("simulated capture commit failure");
		const failedListing = await listRepositorySpool(
			binding,
			repositoryRoot,
			baseEnv,
		);
		expect(failedListing.captures).toHaveLength(0);
		expect(failedListing.quota.orphanBlobCount).toBe(1);

		const recoveryPlan = await planRepositoryBundle(
			candidate,
			binding,
			repositoryRoot,
			"manual",
			baseEnv,
		);
		expect(recoveryPlan.newlyMaterializedBytes).toBe(0);
		const recovered = await writeRepositoryBundle(
			candidate,
			binding,
			repositoryRoot,
			"manual",
			baseEnv,
		);
		expect(recovered.capture.integrity).toBe("valid");
		const recoveredListing = await listRepositorySpool(
			binding,
			repositoryRoot,
			baseEnv,
		);
		expect(recoveredListing.quota.orphanBlobCount).toBe(0);
		expect(recovered.quota.usedBytes).toBe(recoveredListing.quota.usedBytes);
	});

	test("detects blob corruption without printing the blob body", async () => {
		const env = createRepositorySpoolEnv(join(tempRoot, "corruption"));
		const binding = await makeBinding(repositoryRoot, env, "account-a");
		const secret = "secret-corruption-canary";
		const candidate = makeCandidate({
			captureId: "capture-corrupt",
			capturedAt: "2026-09-18T10:04:00.000Z",
			contents: [secret],
		});
		await writeRepositoryBundle(
			candidate,
			binding,
			repositoryRoot,
			"manual",
			env,
		);
		const files = (await walk(join(env.configDir, "repo-context-spool"))).files;
		const blobPath = files.find((path) => path.endsWith(".blob"));
		expect(blobPath).toBeDefined();
		if (!blobPath) throw new Error("Expected a stored blob");
		await writeFile(blobPath, "corrupt", "utf8");

		const listing = await listRepositorySpool(binding, repositoryRoot, env);

		expect(listing.captures).toHaveLength(1);
		expect(listing.captures[0]?.integrity).toBe("corrupt");
		expect(listing.captures[0]?.integrityError).toContain("content hash");
		expect(JSON.stringify(listing)).not.toContain(secret);
	});

	test("supports concurrent collection and listing with one shared immutable blob", async () => {
		const env = createRepositorySpoolEnv(join(tempRoot, "concurrent"));
		const binding = await makeBinding(repositoryRoot, env, "account-a");
		const candidates = Array.from({ length: 12 }, (_, index) =>
			makeCandidate({
				captureId: `capture-concurrent-${index}`,
				capturedAt: `2026-09-18T10:${String(10 + index).padStart(2, "0")}:00.000Z`,
				contents: ["one shared body"],
			}),
		);

		await Promise.all([
			...candidates.map((candidate) =>
				writeRepositoryBundle(
					candidate,
					binding,
					repositoryRoot,
					"manual",
					env,
				),
			),
			...Array.from({ length: 6 }, () =>
				listRepositorySpool(binding, repositoryRoot, env),
			),
		]);
		const listing = await listRepositorySpool(binding, repositoryRoot, env);

		expect(listing.captures).toHaveLength(candidates.length);
		expect(
			listing.captures.every((capture) => capture.integrity === "valid"),
		).toBe(true);
		expect(listing.quota.blobCount).toBe(1);
	});

	test("serializes distinct writers so hard byte quotas cannot be overrun", async () => {
		const baseEnv = createRepositorySpoolEnv(
			join(tempRoot, "quota-concurrency"),
		);
		const binding = await makeBinding(repositoryRoot, baseEnv, "account-a");
		const first = makeCandidate({
			captureId: "capture-quota-a",
			capturedAt: "2026-09-18T10:30:00.000Z",
			contents: ["a".repeat(32_000)],
		});
		const second = makeCandidate({
			captureId: "capture-quota-b",
			capturedAt: "2026-09-18T10:31:00.000Z",
			contents: ["b".repeat(32_000)],
		});
		const [firstPlan, secondPlan] = await Promise.all([
			planRepositoryBundle(first, binding, repositoryRoot, "manual", baseEnv),
			planRepositoryBundle(second, binding, repositoryRoot, "manual", baseEnv),
		]);
		const limitedEnv: RepositorySpoolEnv = {
			...baseEnv,
			maxStoredBytes:
				Math.max(firstPlan.storedNewBytes, secondPlan.storedNewBytes) + 16,
		};

		const results = await Promise.allSettled([
			writeRepositoryBundle(
				first,
				binding,
				repositoryRoot,
				"manual",
				limitedEnv,
			),
			writeRepositoryBundle(
				second,
				binding,
				repositoryRoot,
				"manual",
				limitedEnv,
			),
		]);
		const listing = await listRepositorySpool(
			binding,
			repositoryRoot,
			limitedEnv,
		);

		expect(
			results.filter((result) => result.status === "fulfilled"),
		).toHaveLength(1);
		expect(
			results.filter((result) => result.status === "rejected"),
		).toHaveLength(1);
		expect(listing.captures).toHaveLength(1);
		expect(listing.quota.usedBytes).toBeLessThanOrEqual(
			limitedEnv.maxStoredBytes,
		);
	});

	test("recovers an abandoned stale writer lock", async () => {
		const env = createRepositorySpoolEnv(join(tempRoot, "stale-lock"));
		const binding = await makeBinding(repositoryRoot, env, "account-a");
		const lockPath = join(
			env.configDir,
			"repo-context-spool",
			"v2",
			".write-lock",
		);
		await mkdir(lockPath, { recursive: true, mode: 0o700 });
		await writeFile(join(lockPath, "owner"), "abandoned", { mode: 0o600 });
		const old = new Date(Date.now() - 120_000);
		await utimes(lockPath, old, old);
		const candidate = makeCandidate({
			captureId: "capture-after-stale-lock",
			capturedAt: "2026-09-18T10:32:00.000Z",
			contents: ["after stale lock"],
		});

		const result = await writeRepositoryBundle(
			candidate,
			binding,
			repositoryRoot,
			"manual",
			env,
		);

		expect(result.capture.integrity).toBe("valid");
		await expect(stat(lockPath)).rejects.toThrow();
	});

	test("keeps a live writer lease beyond the stale threshold", async () => {
		const baseEnv = createRepositorySpoolEnv(join(tempRoot, "live-lock"));
		let activeCommits = 0;
		let maximumConcurrentCommits = 0;
		let notifyFirstCommit = () => undefined;
		const firstCommitEntered = new Promise<void>((resolve) => {
			notifyFirstCommit = resolve;
		});
		const env: RepositorySpoolEnv = {
			...baseEnv,
			writeLockStaleMs: 40,
			writeLockTimeoutMs: 2_000,
			writeLockPollMs: 5,
			commitImmutableFile: async (temporaryPath, finalPath) => {
				if (finalPath.endsWith(".capture.json")) {
					activeCommits += 1;
					maximumConcurrentCommits = Math.max(
						maximumConcurrentCommits,
						activeCommits,
					);
					notifyFirstCommit();
					await Bun.sleep(120);
					await baseEnv.commitImmutableFile(temporaryPath, finalPath);
					activeCommits -= 1;
					return;
				}
				await baseEnv.commitImmutableFile(temporaryPath, finalPath);
			},
		};
		const binding = await makeBinding(repositoryRoot, env, "account-a");
		const first = makeCandidate({
			captureId: "capture-live-lock-a",
			capturedAt: "2026-09-18T10:33:00.000Z",
			contents: ["live lock a"],
		});
		const second = makeCandidate({
			captureId: "capture-live-lock-b",
			capturedAt: "2026-09-18T10:34:00.000Z",
			contents: ["live lock b"],
		});

		const firstWrite = writeRepositoryBundle(
			first,
			binding,
			repositoryRoot,
			"manual",
			env,
		);
		await firstCommitEntered;
		await Bun.sleep(70);
		const secondWrite = writeRepositoryBundle(
			second,
			binding,
			repositoryRoot,
			"manual",
			env,
		);
		await Promise.all([firstWrite, secondWrite]);

		expect(maximumConcurrentCommits).toBe(1);
	});

	test("acceptance and abandonment take only their repository's lock", async () => {
		const env: RepositorySpoolEnv = {
			...createRepositorySpoolEnv(join(tempRoot, "per-binding")),
			writeLockTimeoutMs: 300,
			writeLockPollMs: 10,
		};
		const busyRoot = join(tempRoot, "busy-repository");
		const idleRoot = join(tempRoot, "idle-repository");
		const busy = await makeBinding(busyRoot, env, "account-a");
		const idle = await makeBinding(idleRoot, env, "account-a");
		for (const [binding, root, id] of [
			[busy, busyRoot, "capture-busy"],
			[idle, idleRoot, "capture-idle"],
		] as const) {
			await writeRepositoryBundle(
				makeCandidate({
					captureId: id,
					capturedAt: "2026-09-18T11:00:00.000Z",
					contents: [id],
				}),
				binding,
				root,
				"checkpoint",
				env,
			);
		}
		const spoolRoot = join(env.configDir, "repo-context-spool", "v2");
		const holdLock = async (path: string) => {
			await mkdir(path, { mode: 0o700 });
			await writeFile(join(path, "owner"), `${process.pid}:held-by-test`);
		};
		// Another process is busy in one repository: only that repository waits.
		const busyLock = join(spoolRoot, hash(JSON.stringify(busy)), ".write-lock");
		await holdLock(busyLock);
		await expect(
			markRepositorySpoolCaptureAccepted(
				busy,
				"capture-busy",
				"local-context",
				env,
			),
		).rejects.toThrow("Timed out waiting for another repository spool writer");
		expect(
			await markRepositorySpoolCaptureAccepted(
				idle,
				"capture-idle",
				"local-context",
				env,
			),
		).toBe(true);
		await rm(busyLock, { force: true, recursive: true });
		// A long global section (accounting, retirement) never blocks markers.
		const globalLock = join(spoolRoot, ".write-lock");
		await holdLock(globalLock);
		expect(
			await markRepositorySpoolCaptureAccepted(
				busy,
				"capture-busy",
				"local-context",
				env,
			),
		).toBe(true);
		expect(
			await markRepositorySpoolCaptureAbandoned(
				idle,
				"capture-idle",
				"local-context",
				env,
			),
		).toBe(true);
		await expect(
			writeRepositoryBundle(
				makeCandidate({
					captureId: "capture-needs-global",
					capturedAt: "2026-09-18T11:01:00.000Z",
					contents: ["needs global"],
				}),
				idle,
				idleRoot,
				"checkpoint",
				env,
			),
		).rejects.toThrow("Timed out waiting for another repository spool writer");
		await rm(globalLock, { force: true, recursive: true });
	});

	test("keeps the global quota exact when repositories write concurrently", async () => {
		const baseEnv = createRepositorySpoolEnv(
			join(tempRoot, "per-binding-quota"),
		);
		const roots = ["quota-a", "quota-b", "quota-c"].map((name) =>
			join(tempRoot, name),
		);
		const bindings = await Promise.all(
			roots.map((root) => makeBinding(root, baseEnv, "account-a")),
		);
		const candidates = roots.map((_, index) =>
			makeCandidate({
				captureId: `capture-quota-${index}`,
				capturedAt: `2026-09-18T11:1${index}:00.000Z`,
				contents: [String(index).repeat(32_000)],
			}),
		);
		const plans = await Promise.all(
			candidates.map((candidate, index) =>
				planRepositoryBundle(
					candidate,
					bindings[index] ?? bindings[0],
					roots[index] ?? "",
					"manual",
					baseEnv,
				),
			),
		);
		const limitedEnv: RepositorySpoolEnv = {
			...baseEnv,
			maxStoredBytes:
				Math.max(...plans.map((plan) => plan.storedNewBytes)) * 2 + 16,
		};
		const results = await Promise.allSettled(
			candidates.map((candidate, index) =>
				writeRepositoryBundle(
					candidate,
					bindings[index] ?? bindings[0],
					roots[index] ?? "",
					"manual",
					limitedEnv,
				),
			),
		);
		expect(
			results.filter((result) => result.status === "fulfilled"),
		).toHaveLength(2);
		const listings = await Promise.all(
			bindings.map((binding, index) =>
				listRepositorySpool(binding, roots[index] ?? "", limitedEnv),
			),
		);
		expect(
			listings.reduce((total, listing) => total + listing.captures.length, 0),
		).toBe(2);
		expect(listings[0]?.quota.usedBytes).toBeLessThanOrEqual(
			limitedEnv.maxStoredBytes,
		);
	});

	test("detects tampering with immutable indexes and metrics", async () => {
		const env = createRepositorySpoolEnv(join(tempRoot, "record-tamper"));
		const binding = await makeBinding(repositoryRoot, env, "account-a");
		const candidate = makeCandidate({
			captureId: "capture-record-tamper",
			capturedAt: "2026-09-18T10:35:00.000Z",
			contents: ["tamper body"],
		});
		await writeRepositoryBundle(
			candidate,
			binding,
			repositoryRoot,
			"manual",
			env,
		);
		const files = (await walk(join(env.configDir, "repo-context-spool"))).files;
		const capturePath = files.find((path) => path.endsWith(".capture.json"));
		if (!capturePath) throw new Error("Expected a capture record");
		const record = JSON.parse(await readFile(capturePath, "utf8"));
		record.metrics.reusedBytes += 1;
		record.referencedBlobIds.push(`sha256:${"0".repeat(64)}`);
		await writeFile(capturePath, JSON.stringify(record), "utf8");

		const listing = await listRepositorySpool(binding, repositoryRoot, env);

		expect(listing.captures[0]?.integrity).toBe("corrupt");
		expect(listing.captures[0]?.integrityError).toContain("record hash");
	});

	test("separates endpoint, account, workspace, and repository namespaces", async () => {
		const otherRepository = join(tempRoot, "other-repository");
		await mkdir(otherRepository, { recursive: true });
		await Bun.write(join(otherRepository, ".keep"), "repository");
		const base = {
			apiBaseUrl: "https://opaline.so",
			accountId: "account-a",
			workspaceId: "workspace-a",
			localIdentity: makeLocalIdentity(repositoryRoot),
		};
		const bindings = await Promise.all([
			createRepositorySpoolBinding(base),
			createRepositorySpoolBinding({
				...base,
				apiBaseUrl: "https://self.test",
			}),
			createRepositorySpoolBinding({ ...base, accountId: "account-b" }),
			createRepositorySpoolBinding({ ...base, workspaceId: "workspace-b" }),
			createRepositorySpoolBinding({
				...base,
				localIdentity: makeLocalIdentity(otherRepository),
			}),
		]);

		expect(
			new Set(bindings.map((binding) => JSON.stringify(binding))).size,
		).toBe(bindings.length);
		expect(JSON.stringify(bindings)).not.toContain("opaline.so");
		expect(JSON.stringify(bindings)).not.toContain("account-a");
		expect(JSON.stringify(bindings)).not.toContain("workspace-a");
	});

	test("uses only the newest remotely accepted capture as an incremental parent", async () => {
		const env = createRepositorySpoolEnv(join(tempRoot, "accepted-parent"));
		const binding = await makeBinding(repositoryRoot, env, "account-a");
		const first = makeCandidate({
			captureId: "capture-accepted-first",
			capturedAt: "2026-09-18T10:00:00.000Z",
			contents: ["accepted parent body"],
		});
		const second = makeCandidate({
			captureId: "capture-accepted-second",
			capturedAt: "2026-09-18T10:01:00.000Z",
			contents: ["newer accepted parent body"],
		});
		await writeRepositoryBundle(
			first,
			binding,
			repositoryRoot,
			"checkpoint",
			env,
		);

		expect(
			await getAcceptedRepositorySpoolParent(binding, "local-context", env),
		).toBeNull();
		expect(
			await markRepositorySpoolCaptureAccepted(
				binding,
				first.captureId,
				"local-context",
				env,
			),
		).toBe(true);
		expect(
			await getAcceptedRepositorySpoolParent(binding, "local-context", env),
		).toEqual({
			id: first.captureId,
			blobIds: first.referencedBlobIds,
		});
		const otherEndpoint = await createRepositorySpoolBinding({
			accountId: "account-a",
			apiBaseUrl: "https://other.opaline.so/rpc",
			localIdentity: makeLocalIdentity(repositoryRoot),
			workspaceId: "workspace-a",
		});
		const otherWorkspace = await createRepositorySpoolBinding({
			accountId: "account-a",
			apiBaseUrl: "https://opaline.so",
			localIdentity: makeLocalIdentity(repositoryRoot),
			workspaceId: "workspace-b",
		});
		expect(
			await getAcceptedRepositorySpoolParent(
				otherEndpoint,
				"local-context",
				env,
			),
		).toBeNull();
		expect(
			await getAcceptedRepositorySpoolParent(
				otherWorkspace,
				"local-context",
				env,
			),
		).toBeNull();

		await writeRepositoryBundle(
			second,
			binding,
			repositoryRoot,
			"checkpoint",
			env,
		);
		expect(
			await getAcceptedRepositorySpoolParent(binding, "local-context", env),
		).toEqual({
			id: first.captureId,
			blobIds: first.referencedBlobIds,
		});
		expect(
			await markRepositorySpoolCaptureAccepted(
				binding,
				second.captureId,
				"local-context",
				env,
			),
		).toBe(true);
		expect(
			await markRepositorySpoolCaptureAccepted(
				binding,
				first.captureId,
				"local-context",
				env,
			),
		).toBe(false);
		expect(
			await getAcceptedRepositorySpoolParent(binding, "local-context", env),
		).toEqual({
			id: second.captureId,
			blobIds: second.referencedBlobIds,
		});
	});
});

describe("repository spool hot path", () => {
	test("does not re-verify or rescan historical captures when writing another capture", async () => {
		const observed: Array<{
			readonly history: number;
			readonly scans: number;
			readonly verifications: number;
		}> = [];
		for (const history of [3, 30]) {
			let verifications = 0;
			let scans = 0;
			const env: RepositorySpoolEnv = {
				...createRepositorySpoolEnv(join(tempRoot, `hot-path-${history}`)),
				onCaptureRead: (kind) => {
					if (kind === "verify") verifications += 1;
					else scans += 1;
				},
			};
			const binding = await makeBinding(repositoryRoot, env, "account-a");
			for (let index = 0; index < history; index += 1) {
				await writeRepositoryBundle(
					makeHistoricalCandidate(index),
					binding,
					repositoryRoot,
					"checkpoint",
					env,
				);
			}
			verifications = 0;
			scans = 0;

			const result = await writeRepositoryBundle(
				makeHistoricalCandidate(history),
				binding,
				repositoryRoot,
				"checkpoint",
				env,
			);

			observed.push({ history, scans, verifications });
			expect(result.quota.captureCount).toBe(history + 1);
			expect(result.quota.blobCount).toBe(history + 1);
		}

		expect(observed).toEqual([
			{ history: 3, scans: 0, verifications: 1 },
			{ history: 30, scans: 0, verifications: 1 },
		]);
	});

	test("keeps incremental accounting equal to a full audit and rebuilds it after loss", async () => {
		const env = createRepositorySpoolEnv(join(tempRoot, "accounting"));
		const binding = await makeBinding(repositoryRoot, env, "account-a");
		for (let index = 0; index < 4; index += 1) {
			await writeRepositoryBundle(
				makeHistoricalCandidate(index),
				binding,
				repositoryRoot,
				"checkpoint",
				env,
			);
		}
		const audit = await listRepositorySpool(binding, repositoryRoot, env);
		await rm(join(env.configDir, "repo-context-spool", "accounting.v2.json"));

		const rebuilt = await writeRepositoryBundle(
			makeHistoricalCandidate(4),
			binding,
			repositoryRoot,
			"checkpoint",
			env,
		);
		const auditAfter = await listRepositorySpool(binding, repositoryRoot, env);

		expect(audit.quota.captureCount).toBe(4);
		expect(rebuilt.quota.captureCount).toBe(5);
		expect(rebuilt.quota.usedBytes).toBe(auditAfter.quota.usedBytes);
		expect(rebuilt.quota.blobCount).toBe(auditAfter.quota.blobCount);
	});
});

describe("repository spool retirement", () => {
	test("reclaims abandoned captures under quota pressure without accepting them as parents", async () => {
		const env = {
			...createRepositorySpoolEnv(join(tempRoot, "retire-abandoned")),
			maxCaptures: 2,
		};
		const binding = await makeBinding(repositoryRoot, env, "account-a");
		const head = makeHistoricalCandidate(0);
		const abandoned = makeHistoricalCandidate(1);
		for (const candidate of [head, abandoned]) {
			await writeRepositoryBundle(
				candidate,
				binding,
				repositoryRoot,
				"checkpoint",
				env,
			);
		}
		await markRepositorySpoolCaptureAccepted(
			binding,
			head.captureId,
			"local-context",
			env,
		);
		expect(
			await markRepositorySpoolCaptureAbandoned(
				binding,
				abandoned.captureId,
				"github",
				env,
			),
		).toBe(false);
		expect(
			await markRepositorySpoolCaptureAbandoned(
				binding,
				abandoned.captureId,
				"local-context",
				env,
			),
		).toBe(true);
		expect(
			await getAcceptedRepositorySpoolParent(binding, "local-context", env),
		).toMatchObject({ id: head.captureId });
		const next = makeHistoricalCandidate(2);
		await writeRepositoryBundle(
			next,
			binding,
			repositoryRoot,
			"checkpoint",
			env,
		);
		const listing = await listRepositorySpool(binding, repositoryRoot, env);
		expect(listing.captures.map((capture) => capture.captureId).sort()).toEqual(
			[head.captureId, next.captureId].sort(),
		);
		expect(listing.quota.blobCount).toBe(2);
		expect(listing.quota.orphanBlobCount).toBe(0);
		expect(
			listing.captures.every((capture) => capture.integrity === "valid"),
		).toBe(true);
		expect(
			(await walk(join(env.configDir, "repo-context-spool"))).files.some(
				(path) => path.endsWith(".abandoned.json"),
			),
		).toBe(false);
	});

	test("keeps an abandoned parent and its blobs while a child still awaits delivery", async () => {
		const env = {
			...createRepositorySpoolEnv(join(tempRoot, "abandoned-parent")),
			maxCaptures: 2,
		};
		const binding = await makeBinding(repositoryRoot, env, "account-a");
		const parent = makeHistoricalCandidate(0);
		const child = makeCandidate({
			captureId: "unsent-child",
			capturedAt: "2026-09-20T00:01:00.000Z",
			parentCaptureId: parent.captureId,
			referencedBlobIds: parent.referencedBlobIds,
			reusedBytes: parent.materializedBytes,
		});
		for (const candidate of [parent, child]) {
			await writeRepositoryBundle(
				candidate,
				binding,
				repositoryRoot,
				"checkpoint",
				env,
			);
		}
		await markRepositorySpoolCaptureAbandoned(
			binding,
			parent.captureId,
			"local-context",
			env,
		);
		await expect(
			writeRepositoryBundle(
				makeHistoricalCandidate(2),
				binding,
				repositoryRoot,
				"checkpoint",
				env,
			),
		).rejects.toThrow(/opaline upload --retry/u);
		const listing = await listRepositorySpool(binding, repositoryRoot, env);
		expect(listing.captures).toHaveLength(2);
		expect(
			listing.captures.every((capture) => capture.integrity === "valid"),
		).toBe(true);
		expect(listing.quota.blobCount).toBe(1);
	});

	test("retires accepted captures that nothing references when capacity runs out", async () => {
		const env: RepositorySpoolEnv = {
			...createRepositorySpoolEnv(join(tempRoot, "retire-accepted")),
			maxCaptures: 4,
		};
		const binding = await makeBinding(repositoryRoot, env, "account-a");
		const accepted = [0, 1, 2].map(makeHistoricalCandidate);
		for (const candidate of accepted) {
			await writeRepositoryBundle(
				candidate,
				binding,
				repositoryRoot,
				"checkpoint",
				env,
			);
			await markRepositorySpoolCaptureAccepted(
				binding,
				candidate.captureId,
				"local-context",
				env,
			);
		}
		const unsent = makeHistoricalCandidate(3);
		await writeRepositoryBundle(
			unsent,
			binding,
			repositoryRoot,
			"checkpoint",
			env,
		);
		const full = await listRepositorySpool(binding, repositoryRoot, env);
		expect(full.quota.captureCount).toBe(env.maxCaptures);

		const next = makeHistoricalCandidate(4);
		const result = await writeRepositoryBundle(
			next,
			binding,
			repositoryRoot,
			"checkpoint",
			env,
		);
		const listing = await listRepositorySpool(binding, repositoryRoot, env);

		expect(result.created).toBe(true);
		expect(listing.captures.map((capture) => capture.captureId).sort()).toEqual(
			[accepted[2], unsent, next].map((c) => c?.captureId).sort(),
		);
		expect(listing.captures.every((c) => c.integrity === "valid")).toBe(true);
		expect(listing.quota.blobCount).toBe(3);
		expect(listing.quota.orphanBlobCount).toBe(0);
		expect(result.quota.usedBytes).toBe(listing.quota.usedBytes);
		expect(
			await getAcceptedRepositorySpoolParent(binding, "local-context", env),
		).toEqual({
			blobIds: accepted[2]?.referencedBlobIds,
			id: accepted[2]?.captureId,
		});
	});

	test("never retires captures awaiting delivery and reports how to recover", async () => {
		const env: RepositorySpoolEnv = {
			...createRepositorySpoolEnv(join(tempRoot, "retire-unsent")),
			maxCaptures: 3,
		};
		const binding = await makeBinding(repositoryRoot, env, "account-a");
		const stored = [0, 1, 2].map(makeHistoricalCandidate);
		for (const candidate of stored) {
			await writeRepositoryBundle(
				candidate,
				binding,
				repositoryRoot,
				"checkpoint",
				env,
			);
		}
		await markRepositorySpoolCaptureAccepted(
			binding,
			stored[0]?.captureId ?? "",
			"local-context",
			env,
		);

		await expect(
			writeRepositoryBundle(
				makeHistoricalCandidate(3),
				binding,
				repositoryRoot,
				"checkpoint",
				env,
			),
		).rejects.toThrow(/opaline upload --retry/u);
		const listing = await listRepositorySpool(binding, repositoryRoot, env);

		expect(listing.captures.map((capture) => capture.captureId).sort()).toEqual(
			stored.map((candidate) => candidate.captureId).sort(),
		);
		expect(listing.captures.every((c) => c.integrity === "valid")).toBe(true);
	});

	test("keeps the accepted parent of an unsent capture", async () => {
		const env: RepositorySpoolEnv = {
			...createRepositorySpoolEnv(join(tempRoot, "retire-parent")),
			maxCaptures: 3,
		};
		const binding = await makeBinding(repositoryRoot, env, "account-a");
		const parent = makeHistoricalCandidate(0);
		const child = {
			...makeHistoricalCandidate(1),
			parentCaptureId: parent.captureId,
		};
		const head = makeHistoricalCandidate(2);
		for (const candidate of [parent, child, head]) {
			await writeRepositoryBundle(
				candidate,
				binding,
				repositoryRoot,
				"checkpoint",
				env,
			);
		}
		for (const candidate of [parent, head]) {
			await markRepositorySpoolCaptureAccepted(
				binding,
				candidate.captureId,
				"local-context",
				env,
			);
		}

		await expect(
			writeRepositoryBundle(
				makeHistoricalCandidate(3),
				binding,
				repositoryRoot,
				"checkpoint",
				env,
			),
		).rejects.toThrow(/awaiting delivery/u);
		const listing = await listRepositorySpool(binding, repositoryRoot, env);

		expect(listing.captures.map((capture) => capture.captureId).sort()).toEqual(
			[parent, child, head].map((candidate) => candidate.captureId).sort(),
		);
	});

	test("keeps blobs that a retained capture still references", async () => {
		const env: RepositorySpoolEnv = {
			...createRepositorySpoolEnv(join(tempRoot, "retire-shared-blob")),
			maxCaptures: 2,
		};
		const binding = await makeBinding(repositoryRoot, env, "account-a");
		const shared = makeBlob("shared blob body");
		const first = makeCandidate({
			captureId: "capture-shared-first",
			capturedAt: "2026-09-19T10:00:00.000Z",
			blobs: [shared],
		});
		const head = makeCandidate({
			blobs: [makeBlob("head blob body")],
			captureId: "capture-shared-head",
			capturedAt: "2026-09-19T10:01:00.000Z",
			parentCaptureId: first.captureId,
			referencedBlobIds: [shared.id, makeBlob("head blob body").id],
		});
		for (const candidate of [first, head]) {
			await writeRepositoryBundle(
				candidate,
				binding,
				repositoryRoot,
				"checkpoint",
				env,
			);
			await markRepositorySpoolCaptureAccepted(
				binding,
				candidate.captureId,
				"local-context",
				env,
			);
		}
		const next = makeCandidate({
			captureId: "capture-shared-next",
			capturedAt: "2026-09-19T10:02:00.000Z",
			contents: ["next blob body"],
			parentCaptureId: head.captureId,
		});

		await writeRepositoryBundle(
			next,
			binding,
			repositoryRoot,
			"checkpoint",
			env,
		);
		const listing = await listRepositorySpool(binding, repositoryRoot, env);

		expect(listing.captures.map((capture) => capture.captureId).sort()).toEqual(
			[head.captureId, next.captureId].sort(),
		);
		expect(listing.quota.blobCount).toBe(3);
		expect(listing.quota.orphanBlobCount).toBe(0);
		expect(
			(await walk(join(env.configDir, "repo-context-spool"))).files.some(
				(path) => path.endsWith(`${shared.id.slice("sha256:".length)}.blob`),
			),
		).toBe(true);
		expect(
			await getAcceptedRepositorySpoolParent(binding, "local-context", env),
		).toMatchObject({ id: head.captureId });
	});

	test("reclaims accepted captures from another binding when the global quota is full", async () => {
		const env: RepositorySpoolEnv = {
			...createRepositorySpoolEnv(join(tempRoot, "retire-cross-binding")),
			maxCaptures: 4,
		};
		const bindingA = await makeBinding(repositoryRoot, env, "account-a");
		const bindingB = await makeBinding(repositoryRoot, env, "account-b");
		const acceptedA = [0, 1, 2].map(makeHistoricalCandidate);
		for (const candidate of acceptedA) {
			await writeRepositoryBundle(
				candidate,
				bindingA,
				repositoryRoot,
				"checkpoint",
				env,
			);
			await markRepositorySpoolCaptureAccepted(
				bindingA,
				candidate.captureId,
				"local-context",
				env,
			);
		}
		const unsentA = makeHistoricalCandidate(3);
		await writeRepositoryBundle(
			unsentA,
			bindingA,
			repositoryRoot,
			"checkpoint",
			env,
		);
		expect(
			(await listRepositorySpool(bindingA, repositoryRoot, env)).quota
				.captureCount,
		).toBe(env.maxCaptures);

		const firstInB = makeHistoricalCandidate(4);
		const result = await writeRepositoryBundle(
			firstInB,
			bindingB,
			repositoryRoot,
			"checkpoint",
			env,
		);
		const listingA = await listRepositorySpool(bindingA, repositoryRoot, env);
		const listingB = await listRepositorySpool(bindingB, repositoryRoot, env);

		expect(result.created).toBe(true);
		expect(listingB.captures.map((capture) => capture.captureId)).toEqual([
			firstInB.captureId,
		]);
		expect(
			listingA.captures.map((capture) => capture.captureId).sort(),
		).toEqual([acceptedA[2], unsentA].map((c) => c?.captureId).sort());
		expect(listingA.captures.every((c) => c.integrity === "valid")).toBe(true);
		expect(listingA.quota.captureCount).toBe(3);
		expect(listingA.quota.blobCount).toBe(3);
		expect(listingA.quota.orphanBlobCount).toBe(0);
		expect(result.quota.captureCount).toBe(listingA.quota.captureCount);
		expect(result.quota.usedBytes).toBe(listingA.quota.usedBytes);
		expect(
			await getAcceptedRepositorySpoolParent(bindingA, "local-context", env),
		).toEqual({
			blobIds: acceptedA[2]?.referencedBlobIds,
			id: acceptedA[2]?.captureId,
		});
	});

	test("does not delete a blob that the capture being written reuses", async () => {
		const env: RepositorySpoolEnv = {
			...createRepositorySpoolEnv(join(tempRoot, "retire-reused-blob")),
			maxCaptures: 2,
		};
		const binding = await makeBinding(repositoryRoot, env, "account-a");
		const reused = makeBlob("reused by the next capture");
		const old = makeCandidate({
			blobs: [reused],
			captureId: "capture-reuse-old",
			capturedAt: "2026-09-19T11:00:00.000Z",
		});
		const head = makeCandidate({
			captureId: "capture-reuse-head",
			capturedAt: "2026-09-19T11:01:00.000Z",
			contents: ["reuse head body"],
		});
		for (const candidate of [old, head]) {
			await writeRepositoryBundle(
				candidate,
				binding,
				repositoryRoot,
				"checkpoint",
				env,
			);
			await markRepositorySpoolCaptureAccepted(
				binding,
				candidate.captureId,
				"local-context",
				env,
			);
		}
		const next = makeCandidate({
			blobs: [reused],
			captureId: "capture-reuse-next",
			capturedAt: "2026-09-19T11:02:00.000Z",
		});

		const result = await writeRepositoryBundle(
			next,
			binding,
			repositoryRoot,
			"checkpoint",
			env,
		);

		expect(result.capture.integrity).toBe("valid");
		const listing = await listRepositorySpool(binding, repositoryRoot, env);
		expect(listing.captures.every((c) => c.integrity === "valid")).toBe(true);
		expect(listing.quota.orphanBlobCount).toBe(0);
	});
});

function makeHistoricalCandidate(index: number): RepositoryBundleCandidate {
	return makeCandidate({
		captureId: `capture-history-${index}`,
		capturedAt: new Date(
			Date.UTC(2026, 8, 20, 0, 0, 0) + index * 60_000,
		).toISOString(),
		contents: [`historical blob body ${index}`],
	});
}

interface CandidateOptions {
	readonly captureId: string;
	readonly capturedAt: string;
	readonly artifactKind?: "local-context" | "github";
	readonly contents?: readonly string[];
	readonly blobs?: readonly RepositorySpoolBlob[];
	readonly referencedBlobIds?: readonly string[];
	readonly parentCaptureId?: string | null;
	readonly reusedBytes?: number;
	readonly gitObjectBytes?: number;
	readonly omittedBytes?: number;
	readonly inventoryBytes?: number;
	readonly externalObjectIds?: readonly string[];
	readonly sourceObjects?: readonly {
		readonly id: string;
		readonly blobId: string | null;
	}[];
}

function makeCandidate(options: CandidateOptions): RepositoryBundleCandidate {
	const blobs = [
		...(options.blobs ?? options.contents?.map(makeBlob) ?? []),
	].sort((left, right) => left.id.localeCompare(right.id));
	const referencedBlobIds =
		options.referencedBlobIds ?? blobs.map((blob) => blob.id);
	const materializedBytes = blobs.reduce(
		(total, blob) => total + blob.byteLength,
		0,
	);
	const manifest = {
		schemaVersion: "test",
		captureId: options.captureId,
		parentCaptureId: options.parentCaptureId ?? null,
		baseGitCommit: "0123456789abcdef",
		collectedAt: options.capturedAt,
	};
	const serializedBlobs = blobs.map((blob) => ({
		id: blob.id,
		algorithm: "sha256",
		byteLength: blob.byteLength,
		encoding: "utf-8",
		content: blob.content,
	}));
	return {
		artifactKind: options.artifactKind ?? "local-context",
		captureId: options.captureId,
		capturedAt: options.capturedAt,
		parentCaptureId: options.parentCaptureId ?? null,
		baseGitCommit: "0123456789abcdef",
		manifest,
		blobs,
		referencedBlobIds,
		externalObjectIds: options.externalObjectIds ?? [],
		sourceObjects: options.sourceObjects ?? [],
		serializedBundle: JSON.stringify({ manifest, blobs: serializedBlobs }),
		inventoryBytes:
			options.inventoryBytes ??
			materializedBytes +
				(options.reusedBytes ?? 0) +
				(options.gitObjectBytes ?? 0),
		materializedBytes,
		uploadCandidateBytes: Buffer.byteLength(
			JSON.stringify({ manifest, blobs: serializedBlobs }),
		),
		reusedBytes: options.reusedBytes ?? 0,
		gitObjectBytes: options.gitObjectBytes ?? 0,
		omittedBytes: options.omittedBytes ?? 0,
		dependencyExclusions: 1,
	};
}

function makeBlob(content: string): RepositorySpoolBlob {
	return {
		id: `sha256:${hash(content)}`,
		byteLength: Buffer.byteLength(content),
		content,
	};
}

async function makeBinding(
	root: string,
	_env: RepositorySpoolEnv,
	accountId: string,
) {
	return createRepositorySpoolBinding({
		apiBaseUrl: "https://opaline.so",
		accountId,
		workspaceId: "workspace-a",
		localIdentity: makeLocalIdentity(root),
	});
}

function makeLocalIdentity(root: string) {
	return {
		installationId: "00000000-0000-4000-8000-000000000001",
		repositoryId: `local-repository:${hash(`repository\u0000${root}`)}`,
		worktreeId: `local-worktree:${hash(`worktree\u0000${root}`)}`,
	};
}

async function walk(root: string): Promise<{
	readonly directories: readonly string[];
	readonly files: readonly string[];
}> {
	const directories: string[] = [];
	const files: string[] = [];
	const pending = [root];
	while (pending.length > 0) {
		const current = pending.pop();
		if (!current) throw new Error("Directory walk state is invalid");
		directories.push(current);
		const entries = await readdir(current, { withFileTypes: true });
		for (const entry of entries) {
			const path = join(current, entry.name);
			if (entry.isDirectory()) pending.push(path);
			if (entry.isFile()) files.push(path);
		}
	}
	return { directories, files };
}

function hash(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}
