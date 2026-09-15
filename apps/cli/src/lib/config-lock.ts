import { randomUUID } from "node:crypto";
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

export async function withConfigLock<TResult>(
	configDir: string,
	operation: () => Promise<TResult>,
): Promise<TResult> {
	await mkdir(configDir, { recursive: true, mode: 0o700 });
	const directory = join(configDir, ".auto-upload-lock");
	const owner = `${process.pid}-${randomUUID()}`;
	const prepared = join(configDir, `.auto-upload-lock-${owner}`);
	await mkdir(prepared, { mode: 0o700 });
	try {
		await writeFile(join(prepared, owner), "", { mode: 0o600, flag: "wx" });
		// Publish the owner and lock together. An existing nonempty directory
		// cannot be replaced, even when two processes reclaim a dead owner.
		for (let attempt = 0; ; attempt++) {
			try {
				await rename(prepared, directory);
				break;
			} catch (error) {
				if (!hasCode(error, "EEXIST", "ENOTEMPTY", "EACCES", "EPERM"))
					throw error;
				if (attempt >= 2)
					throw new Error(
						"Another upload manager is saving. Try again in a moment.",
					);
				await removeDeadOwner(directory);
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

async function removeDeadOwner(directory: string): Promise<void> {
	const owners = await readdir(directory).catch((error: unknown) => {
		if (hasCode(error, "ENOENT")) return [];
		throw error;
	});
	for (const owner of owners) {
		const match = /^(\d+)-[0-9a-f-]+$/u.exec(owner);
		const pid = Number(match?.[1]);
		if (!Number.isSafeInteger(pid) || pid <= 0 || isRunning(pid))
			throw new Error(
				"Another upload manager is saving. Try again in a moment.",
			);
		// Delete only this dead owner's uniquely named file. A competing
		// reclaimer may already have acquired the directory with a new owner.
		await unlink(join(directory, owner)).catch((error: unknown) => {
			if (!hasCode(error, "ENOENT")) throw error;
		});
	}
	await removeEmptyDirectory(directory);
}

async function removeEmptyDirectory(directory: string): Promise<void> {
	await rmdir(directory).catch((error: unknown) => {
		if (!hasCode(error, "ENOENT", "ENOTEMPTY", "EEXIST")) throw error;
	});
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
