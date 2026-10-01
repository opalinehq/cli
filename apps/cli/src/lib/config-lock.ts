import { randomUUID } from "node:crypto";
import {
	mkdirSync,
	renameSync,
	rmdirSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import {
	mkdir,
	readdir,
	rename,
	rm,
	rmdir,
	unlink,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const LOCK_POLL_MS = 25;
const BUSY_MESSAGE = "Another upload manager is saving. Try again in a moment.";

export async function withConfigLock<TResult>(
	configDir: string,
	operation: () => Promise<TResult>,
	options: { readonly waitMs?: number } = {},
): Promise<TResult> {
	const deadline = Date.now() + (options.waitMs ?? 0);
	await mkdir(configDir, { recursive: true, mode: 0o700 });
	const directory = join(configDir, ".auto-upload-lock");
	const owner = `${process.pid}-${randomUUID()}`;
	const prepared = join(configDir, `.auto-upload-lock-${owner}`);
	await mkdir(prepared, { mode: 0o700 });
	try {
		await writeFile(join(prepared, owner), "", { mode: 0o600, flag: "wx" });
		// Publish the owner and lock together. An existing nonempty directory
		// cannot be replaced, even when two processes reclaim a dead owner.
		for (let reclaims = 0; ; ) {
			try {
				await rename(prepared, directory);
				break;
			} catch (error) {
				if (!hasCode(error, "EEXIST", "ENOTEMPTY", "EACCES", "EPERM"))
					throw error;
				if (reclaims < 2 && (await removeDeadOwner(directory))) {
					reclaims++;
					continue;
				}
				if (Date.now() >= deadline) throw new Error(BUSY_MESSAGE);
				await delay(LOCK_POLL_MS);
			}
		}
		try {
			return await operation();
		} finally {
			await unlink(join(directory, owner));
			await removeEmptyDirectory(directory);
		}
	} finally {
		await rm(prepared, { recursive: true, force: true });
	}
}

// Runs the operation only when the lock is free now. Returns false and skips
// the operation when another process holds the lock.
export function tryWithConfigLockSync(
	configDir: string,
	operation: () => void,
): boolean {
	const directory = join(configDir, ".auto-upload-lock");
	const owner = `${process.pid}-${randomUUID()}`;
	const prepared = join(configDir, `.auto-upload-lock-${owner}`);
	mkdirSync(prepared, { mode: 0o700 });
	try {
		writeFileSync(join(prepared, owner), "", { mode: 0o600, flag: "wx" });
		try {
			renameSync(prepared, directory);
		} catch (error) {
			if (hasCode(error, "EEXIST", "ENOTEMPTY", "EACCES", "EPERM"))
				return false;
			throw error;
		}
		try {
			operation();
			return true;
		} finally {
			unlinkSync(join(directory, owner));
			removeEmptyDirectorySync(directory);
		}
	} finally {
		rmSync(prepared, { recursive: true, force: true });
	}
}

// Returns false when a live process still owns the lock.
async function removeDeadOwner(directory: string): Promise<boolean> {
	const owners = await readdir(directory).catch((error: unknown) => {
		if (hasCode(error, "ENOENT")) return [];
		throw error;
	});
	for (const owner of owners) {
		const match = /^(\d+)-[0-9a-f-]+$/u.exec(owner);
		const pid = Number(match?.[1]);
		if (!Number.isSafeInteger(pid) || pid <= 0 || isRunning(pid)) return false;
		// Delete only this dead owner's uniquely named file. A competing
		// reclaimer may already have acquired the directory with a new owner.
		await unlink(join(directory, owner)).catch((error: unknown) => {
			if (!hasCode(error, "ENOENT")) throw error;
		});
	}
	await removeEmptyDirectory(directory);
	return true;
}

async function removeEmptyDirectory(directory: string): Promise<void> {
	await rmdir(directory).catch((error: unknown) => {
		if (!hasCode(error, "ENOENT", "ENOTEMPTY", "EEXIST")) throw error;
	});
}

function removeEmptyDirectorySync(directory: string): void {
	try {
		rmdirSync(directory);
	} catch (error) {
		if (!hasCode(error, "ENOENT", "ENOTEMPTY", "EEXIST")) throw error;
	}
}

function isRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if (hasCode(error, "ESRCH")) return false;
		throw error;
	}
}

function hasCode(error: unknown, ...codes: string[]): boolean {
	return (
		error instanceof Error &&
		"code" in error &&
		typeof error.code === "string" &&
		codes.includes(error.code)
	);
}
