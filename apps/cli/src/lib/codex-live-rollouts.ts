import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import {
	type CodexThread,
	codexThreadFromFirstRecord,
} from "./codex-thread-family.js";
import { readFirstJsonLine } from "./live-session-paths.js";

const DAY_MS = 24 * 60 * 60 * 1_000;
/** Look this far back for sub-agents of a session that started earlier. */
const MAX_RANGE_DAYS = 8;
const MAX_TRACKED_DIRECTORIES = 64;
const MAX_CLASSIFY_ATTEMPTS = 5;
const MAX_DESCENDANTS = 511;
const FULL_RESCAN_MS = 60_000;
const DAY_PATH_PATTERN =
	/^(.*)[\\/](\d{4})[\\/](\d{2})[\\/](\d{2})[\\/][^\\/]+\.jsonl$/u;

interface TrackedDirectory {
	mtimeMs: number;
	scannedAt: number;
	readonly names: Set<string>;
}

/**
 * Finds Codex sub-agent rollouts (`session_meta.parent_thread_id`) for live
 * sessions without walking all of `sessions/`: only the date directories a
 * session can have children in are tracked, a directory is listed again only
 * when its mtime changes (or once a minute), and each new rollout's first
 * line is read once.
 */
export class CodexRolloutIndex {
	private readonly directories = new Map<string, TrackedDirectory>();
	private readonly roots = new Set<string>();
	private readonly unclassified = new Map<string, number>();
	private readonly children = new Map<string, Map<string, CodexThread>>();

	/** Tracks the date directories from the rollout's own day through today. */
	track(transcriptPath: string, now = Date.now()): void {
		const match = DAY_PATH_PATTERN.exec(transcriptPath);
		if (!match?.[1]) return;
		const root = match[1];
		this.roots.add(root);
		const start = new Date(
			Number(match[2]),
			Number(match[3]) - 1,
			Number(match[4]),
		).getTime();
		const from = Math.max(start, now - MAX_RANGE_DAYS * DAY_MS);
		for (let day = from; day <= now + DAY_MS / 2; day += DAY_MS)
			this.trackDirectory(dayDirectory(root, new Date(day)));
		this.trackDirectory(dayDirectory(root, new Date(start)));
	}

	/** Lists changed directories and classifies new rollouts. */
	async refresh(now = Date.now()): Promise<void> {
		// New rollouts are written to today's directory (also across midnight).
		for (const root of this.roots) {
			this.trackDirectory(dayDirectory(root, new Date(now)));
			this.trackDirectory(dayDirectory(root, new Date(now - DAY_MS)));
		}
		for (const [path, directory] of this.directories) {
			let mtimeMs: number;
			try {
				mtimeMs = (await stat(path)).mtimeMs;
			} catch {
				continue;
			}
			if (
				mtimeMs === directory.mtimeMs &&
				now - directory.scannedAt < FULL_RESCAN_MS
			)
				continue;
			directory.mtimeMs = mtimeMs;
			directory.scannedAt = now;
			let names: string[];
			try {
				names = await readdir(path);
			} catch {
				continue;
			}
			for (const name of names) {
				if (directory.names.has(name)) continue;
				if (!name.startsWith("rollout-") || !name.endsWith(".jsonl")) continue;
				directory.names.add(name);
				this.unclassified.set(join(path, name), 0);
			}
		}
		for (const [path, attempts] of this.unclassified) {
			// Regular files only (never blocks on a FIFO named like a rollout).
			const thread = codexThreadFromFirstRecord(
				await readFirstJsonLine(path),
				path,
			);
			if (thread) {
				this.unclassified.delete(path);
				if (thread.kind === "subagent" && thread.parentThreadId) {
					const siblings =
						this.children.get(thread.parentThreadId) ?? new Map();
					siblings.set(thread.threadId, thread);
					this.children.set(thread.parentThreadId, siblings);
				}
			} else if (attempts + 1 >= MAX_CLASSIFY_ATTEMPTS) {
				// Not a readable rollout (yet): give up on it.
				this.unclassified.delete(path);
			} else {
				this.unclassified.set(path, attempts + 1);
			}
		}
	}

	/** Spawned sub-agent threads of a thread, transitively. */
	descendants(threadId: string): CodexThread[] {
		const result: CodexThread[] = [];
		const seen = new Set([threadId]);
		const queue = [threadId];
		while (queue.length > 0 && result.length < MAX_DESCENDANTS) {
			const parent = queue.shift() as string;
			for (const child of this.children.get(parent)?.values() ?? []) {
				if (seen.has(child.threadId) || result.length >= MAX_DESCENDANTS)
					continue;
				seen.add(child.threadId);
				result.push(child);
				queue.push(child.threadId);
			}
		}
		return result;
	}

	private trackDirectory(path: string): void {
		if (this.directories.has(path)) return;
		if (this.directories.size >= MAX_TRACKED_DIRECTORIES) {
			// Forget the oldest tracked directory (insertion order).
			const oldest = this.directories.keys().next().value;
			if (oldest !== undefined) this.directories.delete(oldest);
		}
		this.directories.set(path, { mtimeMs: -1, names: new Set(), scannedAt: 0 });
	}
}

function dayDirectory(root: string, date: Date): string {
	return join(
		root,
		String(date.getFullYear()),
		String(date.getMonth() + 1).padStart(2, "0"),
		String(date.getDate()).padStart(2, "0"),
	);
}
