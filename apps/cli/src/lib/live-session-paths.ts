import { constants, type Stats } from "node:fs";
import { type FileHandle, open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { isContainedPath } from "../internal/agent-adapters/index.js";
import { getCodexHomeDir } from "./codex-thread-family.js";
import type { LiveSessionSource } from "./live-session-registry.js";

/** Directories transcripts of each agent must live under. */
export type LiveTranscriptRoots = Readonly<
	Record<LiveSessionSource, readonly string[]>
>;

/**
 * Claude Code keeps transcripts under `<config dir>/projects`
 * (`CLAUDE_CONFIG_DIR`, else `~/.claude`); Codex under `<CODEX_HOME>/sessions`
 * (else `~/.codex`).
 */
export function getLiveTranscriptRoots(
	environment: NodeJS.ProcessEnv = process.env,
): LiveTranscriptRoots {
	const home = homedir();
	const claude = new Set([join(home, ".claude", "projects")]);
	const claudeConfig = environment.CLAUDE_CONFIG_DIR?.trim();
	if (claudeConfig) claude.add(join(claudeConfig, "projects"));
	const codex = new Set([
		join(home, ".codex", "sessions"),
		join(getCodexHomeDir(environment), "sessions"),
	]);
	return { claude_code: [...claude], codex: [...codex] };
}

/**
 * Whether a transcript path is a `.jsonl` file inside one of the agent's
 * transcript roots after resolving symbolic links. The file itself may not
 * exist yet (Claude Code creates it with the first record).
 */
export async function isAllowedTranscriptPath(
	source: LiveSessionSource,
	path: string,
	roots: LiveTranscriptRoots,
): Promise<boolean> {
	if (!path.endsWith(".jsonl")) return false;
	let canonical: string | undefined;
	let current = resolve(path);
	const missing: string[] = [];
	for (let depth = 0; depth < 64; depth += 1) {
		try {
			canonical = join(await realpath(current), ...missing);
			break;
		} catch {
			const parent = dirname(current);
			if (parent === current) return false;
			missing.unshift(basename(current));
			current = parent;
		}
	}
	if (!canonical?.endsWith(".jsonl")) return false;
	for (const root of roots[source]) {
		try {
			if (isContainedPath(await realpath(root), canonical)) return true;
		} catch {
			// This root does not exist.
		}
	}
	return false;
}

const SAFE_OPEN_FLAGS =
	constants.O_RDONLY |
	(constants.O_NOFOLLOW ?? 0) |
	(constants.O_NONBLOCK ?? 0);

export class NotRegularFileError extends Error {
	constructor() {
		super("Not a regular file");
	}
}

/**
 * Opens a transcript for reading without following a final symbolic link
 * and without blocking on FIFOs or devices; only regular files are returned.
 */
export async function openRegularFile(
	path: string,
): Promise<{ readonly handle: FileHandle; readonly stats: Stats }> {
	const handle = await open(path, SAFE_OPEN_FLAGS);
	try {
		const stats = await handle.stat();
		if (!stats.isFile()) throw new NotRegularFileError();
		return { handle, stats };
	} catch (error) {
		await handle.close().catch(() => undefined);
		throw error;
	}
}

/** The first line of a regular file as JSON (at most `maxBytes`), or null. */
export async function readFirstJsonLine(
	path: string,
	maxBytes = 1024 * 1024,
): Promise<unknown | null> {
	let opened: Awaited<ReturnType<typeof openRegularFile>>;
	try {
		opened = await openRegularFile(path);
	} catch {
		return null;
	}
	try {
		const buffer = Buffer.alloc(Math.min(maxBytes, opened.stats.size));
		const { bytesRead } = await opened.handle.read(buffer, 0, buffer.length, 0);
		const newline = buffer.subarray(0, bytesRead).indexOf(10);
		if (newline < 0) return null;
		return JSON.parse(buffer.subarray(0, newline).toString("utf8"));
	} catch {
		return null;
	} finally {
		await opened.handle.close().catch(() => undefined);
	}
}
