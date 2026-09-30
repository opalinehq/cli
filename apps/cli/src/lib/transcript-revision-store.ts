import { createHash, randomUUID } from "node:crypto";
import {
	chmod,
	mkdir,
	readFile,
	rename,
	rm,
	stat,
	utimes,
	writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { getConfigDir } from "./local-state.js";
import type {
	TranscriptRevisionManifest,
	TranscriptRevisionScope,
} from "./transcript-revision.js";
import { isTranscriptRevisionManifest } from "./transcript-revision.js";
import { normalizeRepositoryEvidenceEndpoint } from "./upload-endpoint.js";

const STORE_VERSION = 2;
const LOCK_POLL_MS = 25;
const LOCK_STALE_MS = 30_000;
const LOCK_TIMEOUT_MS = 1_000;

export interface TranscriptRevisionDeliveryScope {
	readonly endpoint: string;
	readonly organizationId: string;
	readonly transcriptScope: TranscriptRevisionScope;
}

export async function readTranscriptRevision(
	deliveryScope: TranscriptRevisionDeliveryScope,
	configDir = getConfigDir(),
): Promise<TranscriptRevisionManifest | undefined> {
	const lockPath = `${getRevisionPath(deliveryScope, configDir)}.lock`;
	const releaseLock = await acquireRevisionLock(lockPath);
	try {
		return await readTranscriptRevisionUnlocked(deliveryScope, configDir);
	} finally {
		await releaseLock();
	}
}

async function readTranscriptRevisionUnlocked(
	deliveryScope: TranscriptRevisionDeliveryScope,
	configDir: string,
): Promise<TranscriptRevisionManifest | undefined> {
	const path = getRevisionPath(deliveryScope, configDir);
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if (isErrorCode(error, "ENOENT")) return undefined;
		throw error;
	}
	try {
		const value: unknown = JSON.parse(text);
		if (
			!isTranscriptRevisionManifest(value) ||
			!sameScope(value.scope, deliveryScope.transcriptScope)
		) {
			throw new Error(
				"Stored transcript revision is invalid for this session.",
			);
		}
		return value;
	} catch {
		await quarantineTranscriptRevision(path);
		return undefined;
	}
}

export async function writeTranscriptRevision(
	manifest: TranscriptRevisionManifest,
	deliveryScope: TranscriptRevisionDeliveryScope,
	configDir = getConfigDir(),
): Promise<void> {
	const lockPath = `${getRevisionPath(deliveryScope, configDir)}.lock`;
	const releaseLock = await acquireRevisionLock(lockPath);
	try {
		await writeTranscriptRevisionUnlocked(manifest, deliveryScope, configDir);
	} finally {
		await releaseLock();
	}
}

async function writeTranscriptRevisionUnlocked(
	manifest: TranscriptRevisionManifest,
	deliveryScope: TranscriptRevisionDeliveryScope,
	configDir: string,
): Promise<void> {
	if (!sameScope(manifest.scope, deliveryScope.transcriptScope)) {
		throw new Error(
			"Transcript revision delivery scope does not match the manifest.",
		);
	}
	const path = getRevisionPath(deliveryScope, configDir);
	const directory = dirname(path);
	await mkdir(directory, { mode: 0o700, recursive: true });
	if (process.platform !== "win32") await chmod(directory, 0o700);
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporary, `${JSON.stringify(manifest)}\n`, {
			encoding: "utf8",
			mode: 0o600,
			flag: "wx",
		});
		await rename(temporary, path);
		if (process.platform !== "win32") await chmod(path, 0o600);
	} finally {
		await rm(temporary, { force: true });
	}
}

export async function advanceTranscriptRevision(
	manifest: TranscriptRevisionManifest,
	deliveryScope: TranscriptRevisionDeliveryScope,
	configDir = getConfigDir(),
): Promise<boolean> {
	const lockPath = `${getRevisionPath(deliveryScope, configDir)}.lock`;
	const releaseLock = await acquireRevisionLock(lockPath);
	try {
		const current = await readTranscriptRevisionUnlocked(
			deliveryScope,
			configDir,
		);
		if (current && !isNewerRevision(manifest, current)) return false;
		await writeTranscriptRevisionUnlocked(manifest, deliveryScope, configDir);
		return true;
	} finally {
		await releaseLock();
	}
}

export function getTranscriptRevisionPathKey(
	deliveryScope: TranscriptRevisionDeliveryScope,
): string {
	return createHash("sha256")
		.update(
			JSON.stringify({
				endpoint: normalizeRepositoryEvidenceEndpoint(deliveryScope.endpoint),
				organizationId: deliveryScope.organizationId,
				transcriptScope: deliveryScope.transcriptScope,
			}),
		)
		.digest("hex");
}

function getRevisionPath(
	deliveryScope: TranscriptRevisionDeliveryScope,
	configDir: string,
) {
	return join(
		configDir,
		"transcript-revisions",
		`v${STORE_VERSION}`,
		`${getTranscriptRevisionPathKey(deliveryScope)}.json`,
	);
}

async function quarantineTranscriptRevision(path: string): Promise<void> {
	const quarantine = join(dirname(path), "quarantine");
	await mkdir(quarantine, { mode: 0o700, recursive: true });
	if (process.platform !== "win32") await chmod(quarantine, 0o700);
	try {
		await rename(
			path,
			join(quarantine, `${basename(path, ".json")}.${randomUUID()}.json`),
		);
	} catch (error) {
		if (!isErrorCode(error, "ENOENT")) throw error;
	}
}

async function acquireRevisionLock(
	lockPath: string,
): Promise<() => Promise<void>> {
	await mkdir(dirname(lockPath), { mode: 0o700, recursive: true });
	const ownerPath = join(lockPath, "owner");
	const ownerToken = `${process.pid}:${randomUUID()}`;
	const startedAt = Date.now();
	while (true) {
		let createdLock = false;
		try {
			await mkdir(lockPath, { mode: 0o700 });
			createdLock = true;
			await writeFile(ownerPath, ownerToken, {
				encoding: "utf8",
				flag: "wx",
				mode: 0o600,
			});
			const heartbeat = setInterval(
				() => {
					void renewOwnedRevisionLock(lockPath, ownerPath, ownerToken).catch(
						() => undefined,
					);
				},
				Math.max(10, Math.floor(LOCK_STALE_MS / 3)),
			);
			return async () => {
				clearInterval(heartbeat);
				const owner = await readFileIfPresent(ownerPath);
				if (owner === ownerToken) {
					await rm(lockPath, { force: true, recursive: true });
				}
			};
		} catch (error) {
			if (createdLock) {
				await rm(lockPath, { force: true, recursive: true });
				throw error;
			}
			if (!isErrorCode(error, "EEXIST")) throw error;
			if (await recoverStaleRevisionLock(lockPath)) continue;
			if (Date.now() - startedAt >= LOCK_TIMEOUT_MS) break;
			await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
		}
	}
	throw new Error("Timed out waiting to advance the transcript revision.");
}

async function recoverStaleRevisionLock(lockPath: string): Promise<boolean> {
	const recoveryPath = `${lockPath}.recovery`;
	try {
		await mkdir(recoveryPath, { mode: 0o700 });
	} catch (error) {
		if (isErrorCode(error, "EEXIST")) return false;
		throw error;
	}
	try {
		return await recoverStaleRevisionLockExclusively(lockPath);
	} finally {
		await rm(recoveryPath, { force: true, recursive: true });
	}
}

async function recoverStaleRevisionLockExclusively(
	lockPath: string,
): Promise<boolean> {
	let ageMs: number;
	try {
		ageMs = Date.now() - (await stat(lockPath)).mtimeMs;
	} catch (error) {
		if (isErrorCode(error, "ENOENT")) return true;
		throw error;
	}
	if (ageMs < LOCK_STALE_MS || (await isRevisionLockOwnerAlive(lockPath))) {
		return false;
	}
	const stalePath = `${lockPath}.stale.${randomUUID()}`;
	try {
		await rename(lockPath, stalePath);
	} catch (error) {
		if (isErrorCode(error, "ENOENT")) return true;
		throw error;
	}
	await rm(stalePath, { force: true, recursive: true });
	return true;
}

async function renewOwnedRevisionLock(
	lockPath: string,
	ownerPath: string,
	ownerToken: string,
): Promise<void> {
	if ((await readFileIfPresent(ownerPath)) !== ownerToken) return;
	const now = new Date();
	try {
		await utimes(lockPath, now, now);
	} catch (error) {
		if (!isErrorCode(error, "ENOENT")) throw error;
	}
}

async function isRevisionLockOwnerAlive(lockPath: string): Promise<boolean> {
	const owner = await readFileIfPresent(join(lockPath, "owner"));
	const processIdText = owner?.split(":", 1)[0];
	if (!processIdText || !/^\d+$/u.test(processIdText)) return false;
	try {
		process.kill(Number(processIdText), 0);
		return true;
	} catch (error) {
		return !isErrorCode(error, "ESRCH");
	}
}

async function readFileIfPresent(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if (isErrorCode(error, "ENOENT")) return undefined;
		throw error;
	}
}

function isNewerRevision(
	candidate: TranscriptRevisionManifest,
	current: TranscriptRevisionManifest,
): boolean {
	return (
		candidate.generation > current.generation ||
		(candidate.generation === current.generation &&
			(candidate.watermark.byteOffset > current.watermark.byteOffset ||
				(candidate.watermark.byteOffset === current.watermark.byteOffset &&
					candidate.terminal &&
					!current.terminal &&
					candidate.parentRevisionId === current.revisionId)))
	);
}

function sameScope(
	left: TranscriptRevisionScope,
	right: TranscriptRevisionScope,
): boolean {
	return (
		left.actorId === right.actorId &&
		left.provider === right.provider &&
		left.providerInstanceId === right.providerInstanceId &&
		left.sessionId === right.sessionId
	);
}

function isErrorCode(error: unknown, code: string): boolean {
	return (
		error instanceof Error &&
		"code" in error &&
		(error as { readonly code?: unknown }).code === code
	);
}
