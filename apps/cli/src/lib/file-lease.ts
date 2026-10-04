import { randomUUID } from "node:crypto";
import {
	mkdir,
	readFile,
	rename,
	rm,
	stat,
	utimes,
	writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Non-blocking, cross-process lease backed by an exclusive directory. The
 * owner renews the directory's mtime while it holds the lease. A lease is
 * recovered when its owner process is gone, or when its heartbeat stopped
 * for longer than the hard stale limit (covers a hung owner or a reused PID).
 */
export interface FileLeaseOptions {
	readonly heartbeatMs: number;
	readonly hardStaleMs: number;
	/** Grace period for a lease directory whose owner file is not written yet. */
	readonly ownerlessGraceMs: number;
}

export interface FileLease {
	readonly release: () => Promise<void>;
}

export const DEFAULT_FILE_LEASE_OPTIONS: FileLeaseOptions = {
	heartbeatMs: 10_000,
	hardStaleMs: 5 * 60_000,
	ownerlessGraceMs: 30_000,
};

export async function tryAcquireFileLease(
	lockPath: string,
	options: FileLeaseOptions = DEFAULT_FILE_LEASE_OPTIONS,
): Promise<FileLease | null> {
	await mkdir(dirname(lockPath), { mode: 0o700, recursive: true });
	for (let attempt = 0; attempt < 2; attempt += 1) {
		const ownerToken = `${process.pid}:${randomUUID()}`;
		try {
			await mkdir(lockPath, { mode: 0o700 });
		} catch (error) {
			if (!isErrorCode(error, "EEXIST")) throw error;
			if (!(await recoverStaleLease(lockPath, options))) return null;
			continue;
		}
		const ownerPath = join(lockPath, "owner");
		try {
			await writeFile(ownerPath, ownerToken, {
				encoding: "utf8",
				flag: "wx",
				mode: 0o600,
			});
		} catch (error) {
			await rm(lockPath, { force: true, recursive: true });
			throw error;
		}
		const heartbeat = setInterval(() => {
			void renewLease(lockPath, ownerPath, ownerToken).catch(() => undefined);
		}, options.heartbeatMs);
		heartbeat.unref();
		return {
			release: async () => {
				clearInterval(heartbeat);
				if ((await readIfPresent(ownerPath)) === ownerToken)
					await rm(lockPath, { force: true, recursive: true });
			},
		};
	}
	return null;
}

export async function isFileLeaseHeld(
	lockPath: string,
	options: FileLeaseOptions = DEFAULT_FILE_LEASE_OPTIONS,
): Promise<boolean> {
	const state = await inspectLease(lockPath, options);
	return state === "held";
}

async function recoverStaleLease(
	lockPath: string,
	options: FileLeaseOptions,
): Promise<boolean> {
	const state = await inspectLease(lockPath, options);
	if (state === "absent") return true;
	if (state === "held") return false;
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

async function inspectLease(
	lockPath: string,
	options: FileLeaseOptions,
): Promise<"absent" | "held" | "stale"> {
	let ageMs: number;
	try {
		// Wall time from the performance clock, not Date.now(), which tests may
		// freeze.
		ageMs =
			performance.timeOrigin +
			performance.now() -
			(await stat(lockPath)).mtimeMs;
	} catch (error) {
		if (isErrorCode(error, "ENOENT")) return "absent";
		throw error;
	}
	if (ageMs >= options.hardStaleMs) return "stale";
	const owner = await readIfPresent(join(lockPath, "owner"));
	if (owner === undefined)
		return ageMs >= options.ownerlessGraceMs ? "stale" : "held";
	const processIdText = owner.split(":", 1)[0];
	if (!processIdText || !/^\d+$/u.test(processIdText)) return "stale";
	return isProcessAlive(Number(processIdText)) ? "held" : "stale";
}

async function renewLease(
	lockPath: string,
	ownerPath: string,
	ownerToken: string,
): Promise<void> {
	if ((await readIfPresent(ownerPath)) !== ownerToken) return;
	const now = new Date();
	await utimes(lockPath, now, now);
}

function isProcessAlive(processId: number): boolean {
	try {
		process.kill(processId, 0);
		return true;
	} catch (error) {
		return !isErrorCode(error, "ESRCH");
	}
}

async function readIfPresent(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if (isErrorCode(error, "ENOENT")) return undefined;
		throw error;
	}
}

function isErrorCode(error: unknown, code: string): boolean {
	return (
		error instanceof Error &&
		"code" in error &&
		(error as { readonly code?: unknown }).code === code
	);
}
