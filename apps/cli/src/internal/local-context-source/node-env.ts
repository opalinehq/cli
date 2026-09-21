import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, open, readdir, readlink, realpath } from "node:fs/promises";
import type {
	BoundedHashResult,
	BoundedReadResult,
	FileSystemEntry,
	FileSystemStat,
	GitCommandResult,
	LocalContextFileSystem,
	LocalContextGitRunner,
	LocalContextSourceEnv,
} from "./types.js";

const HASH_CHUNK_BYTES = 1024 * 1024;

export function createLocalContextSourceEnv(): LocalContextSourceEnv {
	return {
		fileSystem: createNodeFileSystem(),
		git: createNodeGitRunner(),
		now: () => new Date(),
		createCaptureId: randomUUID,
	};
}

export function createNodeFileSystem(): LocalContextFileSystem {
	return {
		realpath,
		lstat: getFileSystemStat,
		readDirectory: getDirectoryEntries,
		readFileBounded,
		hashFileBounded,
		readLink: readlink,
	};
}

export function createNodeGitRunner(): LocalContextGitRunner {
	return { run: runGitCommand };
}

async function getFileSystemStat(path: string): Promise<FileSystemStat> {
	const stat = await lstat(path);
	return {
		kind: stat.isFile()
			? "file"
			: stat.isDirectory()
				? "directory"
				: stat.isSymbolicLink()
					? "symlink"
					: "other",
		size: stat.size,
		mode: stat.mode,
		modifiedAtMs: Math.trunc(stat.mtimeMs),
	};
}

async function getDirectoryEntries(
	path: string,
): Promise<readonly FileSystemEntry[]> {
	const entries = await readdir(path, { withFileTypes: true });
	return entries.map((entry) => ({
		name: entry.name,
		kind: entry.isFile()
			? "file"
			: entry.isDirectory()
				? "directory"
				: entry.isSymbolicLink()
					? "symlink"
					: "other",
	}));
}

async function readFileBounded(
	path: string,
	maxBytes: number,
): Promise<BoundedReadResult> {
	const handle = await open(path, "r");
	try {
		const buffer = Buffer.alloc(maxBytes + 1);
		let offset = 0;
		while (offset < buffer.byteLength) {
			const result = await handle.read(
				buffer,
				offset,
				buffer.byteLength - offset,
				offset,
			);
			if (result.bytesRead === 0) break;
			offset += result.bytesRead;
		}
		const complete = offset <= maxBytes;
		return {
			bytes: Uint8Array.from(buffer.subarray(0, Math.min(offset, maxBytes))),
			complete,
		};
	} finally {
		await handle.close();
	}
}

async function hashFileBounded(
	path: string,
	maxBytes: number,
): Promise<BoundedHashResult> {
	const handle = await open(path, "r");
	const hash = createHash("sha256");
	const buffer = Buffer.alloc(Math.min(HASH_CHUNK_BYTES, maxBytes + 1));
	let bytesHashed = 0;
	let complete = true;
	try {
		while (bytesHashed <= maxBytes) {
			const allowed = Math.min(buffer.byteLength, maxBytes + 1 - bytesHashed);
			const result = await handle.read(buffer, 0, allowed, bytesHashed);
			if (result.bytesRead === 0) break;
			if (bytesHashed + result.bytesRead > maxBytes) {
				complete = false;
				break;
			}
			hash.update(buffer.subarray(0, result.bytesRead));
			bytesHashed += result.bytesRead;
		}
		return {
			algorithm: "sha256",
			value: hash.digest("hex"),
			bytesHashed,
			complete,
		};
	} finally {
		await handle.close();
	}
}

function runGitCommand(
	workingDirectory: string,
	args: readonly string[],
	maxOutputBytes: number,
	timeoutMs: number,
): Promise<GitCommandResult> {
	return new Promise((resolve) => {
		const child = spawn("git", [...args], {
			cwd: workingDirectory,
			env: {
				...process.env,
				GIT_OPTIONAL_LOCKS: "0",
				GIT_TERMINAL_PROMPT: "0",
				LC_ALL: "C",
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let stdoutBytes = 0;
		let stderrBytes = 0;
		let truncated = false;
		let timedOut = false;
		let settled = false;

		child.stdout.on("data", (chunk: Buffer) => {
			const remaining = Math.max(0, maxOutputBytes - stdoutBytes);
			if (chunk.byteLength > remaining) truncated = true;
			if (remaining > 0) {
				stdout.push(chunk.subarray(0, remaining));
				stdoutBytes += Math.min(chunk.byteLength, remaining);
			}
		});
		child.stderr.on("data", (chunk: Buffer) => {
			const remaining = Math.max(0, maxOutputBytes - stderrBytes);
			if (chunk.byteLength > remaining) truncated = true;
			if (remaining > 0) {
				stderr.push(chunk.subarray(0, remaining));
				stderrBytes += Math.min(chunk.byteLength, remaining);
			}
		});

		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, timeoutMs);

		child.on("error", (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({
				exitCode: -1,
				stdout: Uint8Array.from(Buffer.concat(stdout)),
				stderr: new TextEncoder().encode(error.message),
				truncated,
				timedOut,
			});
		});
		child.on("close", (code) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({
				exitCode: code ?? -1,
				stdout: Uint8Array.from(Buffer.concat(stdout)),
				stderr: Uint8Array.from(Buffer.concat(stderr)),
				truncated,
				timedOut,
			});
		});
	});
}
