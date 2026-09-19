import { open, readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export async function readFileWithRetry(
	filePath: string,
	maxRetries = 5,
): Promise<string> {
	const delayMs = 500;

	for (let attempt = 1; attempt <= maxRetries; attempt++) {
		try {
			return await readFile(filePath, "utf-8");
		} catch (error) {
			if (attempt < maxRetries) {
				await new Promise((resolve) => setTimeout(resolve, delayMs));
				continue;
			}
			throw error;
		}
	}

	throw new Error(`Failed to read file: ${filePath}`);
}

export async function readJsonlFirstLine(
	filePath: string,
): Promise<unknown | null> {
	try {
		const file = await open(filePath, "r");
		try {
			const chunks: Buffer[] = [];
			for (let offset = 0; offset < 1024 * 1024; offset += 64 * 1024) {
				const buffer = Buffer.alloc(64 * 1024);
				const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
				const data = buffer.subarray(0, bytesRead);
				const newline = data.indexOf(10);
				chunks.push(newline < 0 ? data : data.subarray(0, newline));
				if (newline >= 0 || bytesRead < buffer.length) {
					return JSON.parse(Buffer.concat(chunks).toString("utf8"));
				}
			}
			return null;
		} finally {
			await file.close();
		}
	} catch {
		return null;
	}
}

/** Read just the edges of a transcript; discovery must not load whole conversations. */
export async function readSessionDiscoveryMetadata(filePath: string): Promise<{
	cwd: string | undefined;
	lastActivityAt: number | undefined;
	sessionDate: number | undefined;
}> {
	try {
		const file = await open(filePath, "r");
		try {
			const { size, mtimeMs } = await file.stat();
			const buffer = Buffer.alloc(Math.min(size, 64 * 1024));
			const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
			const head = parseDiscoveryLines(
				buffer.subarray(0, bytesRead).toString("utf8"),
			);
			let lastActivityAt = head.lastActivityAt;
			if (size > buffer.length) {
				const tailRead = await file.read(
					buffer,
					0,
					buffer.length,
					size - buffer.length,
				);
				const tail = buffer.subarray(0, tailRead.bytesRead).toString("utf8");
				const metadata = parseDiscoveryLines(
					tail.slice(tail.indexOf("\n") + 1),
				);
				if (metadata.lastActivityAt !== undefined)
					lastActivityAt = Math.max(
						lastActivityAt ?? 0,
						metadata.lastActivityAt,
					);
			}
			return {
				cwd: head.cwd,
				sessionDate: head.sessionDate,
				lastActivityAt: lastActivityAt ?? mtimeMs,
			};
		} finally {
			await file.close();
		}
	} catch {
		return {
			cwd: undefined,
			sessionDate: undefined,
			lastActivityAt: undefined,
		};
	}
}

function parseDiscoveryLines(content: string) {
	let cwd: string | undefined;
	let lastActivityAt: number | undefined;
	let sessionDate: number | undefined;
	for (const line of content.split("\n")) {
		let entry: unknown;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (typeof entry !== "object" || entry === null) continue;
		if (!cwd && "cwd" in entry && typeof entry.cwd === "string")
			cwd = entry.cwd;
		if ("timestamp" in entry && typeof entry.timestamp === "string") {
			const timestamp = Date.parse(entry.timestamp);
			if (Number.isFinite(timestamp)) {
				sessionDate = Math.min(sessionDate ?? timestamp, timestamp);
				lastActivityAt = Math.max(lastActivityAt ?? 0, timestamp);
			}
		}
	}
	return { cwd, sessionDate, lastActivityAt };
}

export async function walkJsonlFiles(dir: string): Promise<string[]> {
	const results: string[] = [];

	let entries: string[];
	try {
		entries = await readdir(dir);
	} catch {
		return results;
	}

	for (const entry of entries) {
		const fullPath = join(dir, entry);
		if (entry.endsWith(".jsonl")) {
			results.push(fullPath);
		} else if (!entry.includes(".")) {
			const nested = await walkJsonlFiles(fullPath);
			results.push(...nested);
		}
	}

	return results;
}

export function toDisplayPath(absolutePath: string): string {
	const home = homedir();
	return absolutePath.startsWith(home)
		? `~${absolutePath.slice(home.length)}`
		: absolutePath;
}
