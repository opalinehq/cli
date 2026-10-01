import { afterAll, beforeAll, describe, expect, test } from "bun:test";
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
	planTranscriptRevision,
	type TranscriptRevisionManifest,
	type TranscriptRevisionScope,
} from "../lib/transcript-revision.js";
import {
	advanceTranscriptRevision,
	getTranscriptRevisionPathKey,
	readTranscriptRevision,
	type TranscriptRevisionDeliveryScope,
	writeTranscriptRevision,
} from "../lib/transcript-revision-store.js";

const scope: TranscriptRevisionScope = {
	actorId: "user-1",
	provider: "codex",
	providerInstanceId: "local-codex",
	sessionId: "session-1",
};

const deliveryScope: TranscriptRevisionDeliveryScope = {
	endpoint: "https://api.opaline.so/rpc",
	organizationId: "organization-1",
	transcriptScope: scope,
};

let configDir = "";

beforeAll(async () => {
	configDir = await mkdtemp(join(tmpdir(), "opaline-transcript-revisions-"));
});

afterAll(async () => {
	await rm(configDir, { force: true, recursive: true });
});

describe("transcript revision persistence", () => {
	test("returns undefined when the session has no stored revision", async () => {
		const missing = await readTranscriptRevision(
			withTranscriptScope({ ...scope, sessionId: "missing-session" }),
			configDir,
		);

		expect(missing).toBeUndefined();
	});

	test("writes and reads a revision for the same scope", async () => {
		const manifest = await createManifest(scope);

		await writeTranscriptRevision(manifest, deliveryScope, configDir);

		expect(await readTranscriptRevision(deliveryScope, configDir)).toEqual(
			manifest,
		);
	});

	test("quarantines a revision stored under a different session key", async () => {
		const manifest = await createManifest(scope);
		const requestedScope = { ...scope, sessionId: "other-session" };
		const requestedDelivery = withTranscriptScope(requestedScope);
		const path = revisionPath(requestedDelivery);
		await mkdir(join(configDir, "transcript-revisions", "v2"), {
			recursive: true,
		});
		await writeFile(path, JSON.stringify(manifest), "utf8");

		expect(
			await readTranscriptRevision(requestedDelivery, configDir),
		).toBeUndefined();
		expect(
			await readdir(
				join(configDir, "transcript-revisions", "v2", "quarantine"),
			),
		).toHaveLength(1);
	});

	test("scopes acknowledgments to canonical destination and organization", async () => {
		const namespaceScope = { ...scope, sessionId: "namespace-session" };
		const namespaceDelivery = withTranscriptScope(namespaceScope);
		const canonical = {
			...namespaceDelivery,
			endpoint: "HTTPS://API.OPALINE.SO:443//rpc/?ignored=true#fragment",
		};
		const otherOrganization = {
			...namespaceDelivery,
			organizationId: "organization-2",
		};
		const otherDestination = {
			...namespaceDelivery,
			endpoint: "https://other.opaline.so/rpc",
		};
		const manifest = await createManifest(namespaceScope);
		await writeTranscriptRevision(manifest, namespaceDelivery, configDir);

		expect(getTranscriptRevisionPathKey(canonical)).toBe(
			getTranscriptRevisionPathKey(namespaceDelivery),
		);
		expect(getTranscriptRevisionPathKey(otherOrganization)).not.toBe(
			getTranscriptRevisionPathKey(namespaceDelivery),
		);
		expect(getTranscriptRevisionPathKey(otherDestination)).not.toBe(
			getTranscriptRevisionPathKey(namespaceDelivery),
		);
		expect(await readTranscriptRevision(canonical, configDir)).toEqual(
			manifest,
		);
		expect(
			await readTranscriptRevision(otherOrganization, configDir),
		).toBeUndefined();
		expect(
			await readTranscriptRevision(otherDestination, configDir),
		).toBeUndefined();
	});

	test("quarantines corrupt state and persists a safe full snapshot", async () => {
		const tamperScope = { ...scope, sessionId: "tampered-session" };
		const tamperDelivery = withTranscriptScope(tamperScope);
		const manifest = await createManifest(tamperScope);
		await writeTranscriptRevision(manifest, tamperDelivery, configDir);
		const path = revisionPath(tamperDelivery);
		const stored = await readFile(path, "utf8");
		const tampered = stored.replace(
			`"byteOffset":${manifest.watermark.byteOffset}`,
			`"byteOffset":${manifest.watermark.byteOffset + 1}`,
		);
		expect(tampered).not.toBe(stored);
		await writeFile(path, tampered, "utf8");

		const previous = await readTranscriptRevision(tamperDelivery, configDir);
		expect(previous).toBeUndefined();
		const current = await planTranscriptRevision({
			content: new TextEncoder().encode(
				'{"ordinal":0,"text":"first"}\n{"ordinal":1,"text":"current"}\n',
			),
			previous,
			scope: tamperScope,
			terminal: false,
		});
		expect(current.manifest.generation).toBe(0);
		expect(current.manifest.parentRevisionId).toBeUndefined();
		expect(current.newChunks[0]?.startByte).toBe(0);
		expect(
			await advanceTranscriptRevision(
				current.manifest,
				tamperDelivery,
				configDir,
			),
		).toBe(true);
		expect(await readTranscriptRevision(tamperDelivery, configDir)).toEqual(
			current.manifest,
		);
	});

	test("keeps the store directory and manifest private", async () => {
		const privateScope = { ...scope, sessionId: "private-session" };
		await writeTranscriptRevision(
			await createManifest(privateScope),
			withTranscriptScope(privateScope),
			configDir,
		);

		if (process.platform !== "win32") {
			const directory = await stat(
				join(configDir, "transcript-revisions", "v2"),
			);
			const file = await stat(revisionPath(withTranscriptScope(privateScope)));
			expect(directory.mode & 0o777).toBe(0o700);
			expect(file.mode & 0o777).toBe(0o600);
		}
	});

	test("recovers an abandoned lock without deleting a live owner's lease", async () => {
		const abandonedScope = withTranscriptScope({
			...scope,
			sessionId: "abandoned-lock-session",
		});
		const abandonedLock = `${revisionPath(abandonedScope)}.lock`;
		await mkdir(abandonedLock, { recursive: true, mode: 0o700 });
		await writeFile(join(abandonedLock, "owner"), "abandoned", {
			mode: 0o600,
		});
		const staleAt = new Date(Date.now() - 60_000);
		await utimes(abandonedLock, staleAt, staleAt);

		expect(
			await readTranscriptRevision(abandonedScope, configDir),
		).toBeUndefined();
		await expect(stat(abandonedLock)).rejects.toThrow();

		const liveScope = withTranscriptScope({
			...scope,
			sessionId: "live-lock-session",
		});
		const liveLock = `${revisionPath(liveScope)}.lock`;
		await mkdir(liveLock, { recursive: true, mode: 0o700 });
		await writeFile(join(liveLock, "owner"), `${process.pid}:live-owner`, {
			mode: 0o600,
		});
		await utimes(liveLock, staleAt, staleAt);

		await expect(readTranscriptRevision(liveScope, configDir)).rejects.toThrow(
			"Timed out waiting",
		);
		expect(await readFile(join(liveLock, "owner"), "utf8")).toBe(
			`${process.pid}:live-owner`,
		);
		await rm(liveLock, { force: true, recursive: true });
	});

	test("serializes competing stale-lock reclaimers across processes", async () => {
		const competingScope = withTranscriptScope({
			...scope,
			sessionId: "competing-reclaimers-session",
		});
		const lockPath = `${revisionPath(competingScope)}.lock`;
		await mkdir(lockPath, { recursive: true, mode: 0o700 });
		await writeFile(join(lockPath, "owner"), "abandoned", { mode: 0o600 });
		const staleAt = new Date(Date.now() - 60_000);
		await utimes(lockPath, staleAt, staleAt);
		const workerPath = join(
			import.meta.dir,
			"helpers",
			"transcript-revision-lock-worker.ts",
		);
		const workers = Array.from({ length: 4 }, () =>
			Bun.spawn(
				[
					process.execPath,
					workerPath,
					configDir,
					competingScope.endpoint,
					competingScope.organizationId,
					competingScope.transcriptScope.actorId,
					competingScope.transcriptScope.provider,
					competingScope.transcriptScope.providerInstanceId,
					competingScope.transcriptScope.sessionId,
				],
				{ stderr: "pipe", stdout: "pipe" },
			),
		);
		const results = await Promise.all(
			workers.map(async (worker) => ({
				exitCode: await worker.exited,
				stderr: await new Response(worker.stderr).text(),
			})),
		);

		expect(results).toEqual(
			Array.from({ length: workers.length }, () => ({
				exitCode: 0,
				stderr: "",
			})),
		);
		await expect(stat(lockPath)).rejects.toThrow();
		await expect(stat(`${lockPath}.recovery`)).rejects.toThrow();
	});

	test("does not replace a newer watermark with an older acknowledgment", async () => {
		const monotonicScope = { ...scope, sessionId: "monotonic-session" };
		const monotonicDelivery = withTranscriptScope(monotonicScope);
		const first = await createManifest(monotonicScope);
		const second = await planTranscriptRevision({
			content: new TextEncoder().encode(
				'{"ordinal":0,"text":"first"}\n{"ordinal":1,"text":"second"}\n',
			),
			previous: first,
			scope: monotonicScope,
			terminal: false,
		});

		expect(
			await advanceTranscriptRevision(
				second.manifest,
				monotonicDelivery,
				configDir,
			),
		).toBe(true);
		expect(
			await advanceTranscriptRevision(first, monotonicDelivery, configDir),
		).toBe(false);
		expect(await readTranscriptRevision(monotonicDelivery, configDir)).toEqual(
			second.manifest,
		);
	});

	test("advances a terminal child at the same watermark without replay regression", async () => {
		const terminalScope = { ...scope, sessionId: "terminal-session" };
		const terminalDelivery = withTranscriptScope(terminalScope);
		const content = new TextEncoder().encode(
			'{"ordinal":0,"text":"complete"}\n',
		);
		const checkpoint = await planTranscriptRevision({
			content,
			previous: undefined,
			scope: terminalScope,
			terminal: false,
		});
		await advanceTranscriptRevision(
			checkpoint.manifest,
			terminalDelivery,
			configDir,
		);
		const terminal = await planTranscriptRevision({
			content,
			previous: checkpoint.manifest,
			scope: terminalScope,
			terminal: true,
		});
		const unrelatedTerminal = await planTranscriptRevision({
			content,
			previous: undefined,
			scope: terminalScope,
			terminal: true,
		});

		expect(
			await advanceTranscriptRevision(
				unrelatedTerminal.manifest,
				terminalDelivery,
				configDir,
			),
		).toBe(false);
		expect(
			await advanceTranscriptRevision(
				terminal.manifest,
				terminalDelivery,
				configDir,
			),
		).toBe(true);
		expect(
			await advanceTranscriptRevision(
				checkpoint.manifest,
				terminalDelivery,
				configDir,
			),
		).toBe(false);
		expect(
			await advanceTranscriptRevision(
				terminal.manifest,
				terminalDelivery,
				configDir,
			),
		).toBe(false);
		expect(await readTranscriptRevision(terminalDelivery, configDir)).toEqual(
			terminal.manifest,
		);
	});
});

async function createManifest(
	manifestScope: TranscriptRevisionScope,
): Promise<TranscriptRevisionManifest> {
	const plan = await planTranscriptRevision({
		content: new TextEncoder().encode('{"ordinal":0,"text":"first"}\n'),
		previous: undefined,
		scope: manifestScope,
		terminal: false,
	});
	return plan.manifest;
}

function withTranscriptScope(
	transcriptScope: TranscriptRevisionScope,
): TranscriptRevisionDeliveryScope {
	return { ...deliveryScope, transcriptScope };
}

function revisionPath(revisionScope: TranscriptRevisionDeliveryScope): string {
	return join(
		configDir,
		"transcript-revisions",
		"v2",
		`${getTranscriptRevisionPathKey(revisionScope)}.json`,
	);
}
