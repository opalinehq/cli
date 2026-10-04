import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { readJsonlFirstLine } from "../internal/agent-adapters/utils.js";

const DAY_MS = 24 * 60 * 60 * 1_000;
const MAX_ANCESTOR_DEPTH = 8;
const MAX_DESCENDANTS = 64;
// Child threads are spawned while their parent runs; a chat resumed later can
// still spawn more, so look a week past the thread's start.
const CHILD_WINDOW_DAYS = 7;
const MAX_CHILD_SCAN_FILES = 2_000;
const UUID_PATTERN =
	/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/iu;

export interface CodexThread {
	readonly threadId: string;
	readonly transcriptPath: string;
	readonly parentThreadId: string | undefined;
	/**
	 * `subagent` threads are delegated work spawned by a parent; `other` covers
	 * internal helpers such as guardian approval reviews, which are not part of
	 * the conversation.
	 */
	readonly kind: "root" | "subagent" | "other";
	readonly cwd: string;
	readonly gitBranch: string | undefined;
	readonly gitSha: string | undefined;
}

export interface CodexThreadFamily {
	readonly self: CodexThread;
	/** Parent chain, nearest parent first. */
	readonly ancestors: readonly CodexThread[];
	/** Spawned subagent threads below `self`, transitively. */
	readonly descendants: readonly CodexThread[];
}

export interface CodexThreadSearch {
	readonly codexHome: string;
	readonly now?: Date;
}

/** Codex's own convention: `$CODEX_HOME`, else `~/.codex`. */
export function getCodexHomeDir(
	environment: NodeJS.ProcessEnv = process.env,
): string {
	const configured = environment.CODEX_HOME?.trim();
	return configured ? configured : join(homedir(), ".codex");
}

/**
 * Resolve a Codex thread and the threads that belong to the same conversation:
 * its parent chain (the orchestrating chat) and the subagents it spawned.
 * Returns null when the thread's rollout cannot be found.
 */
export async function resolveCodexThreadFamily(
	threadId: string,
	search: CodexThreadSearch,
): Promise<CodexThreadFamily | null> {
	const dayDirectories = await listDayDirectories(search.codexHome);
	const self = await findThreadInDays(threadId, dayDirectories);
	if (!self) return null;

	const ancestors: CodexThread[] = [];
	const seen = new Set([self.threadId]);
	let parentId = self.parentThreadId;
	while (
		parentId &&
		ancestors.length < MAX_ANCESTOR_DEPTH &&
		!seen.has(parentId)
	) {
		seen.add(parentId);
		const parent = await findThreadInDays(parentId, dayDirectories);
		if (!parent) break;
		ancestors.push(parent);
		parentId = parent.parentThreadId;
	}

	const descendants = await findDescendants(
		self,
		dayDirectories,
		search.now ?? new Date(),
	);
	return { self, ancestors, descendants };
}

/** Locate one thread's rollout; reads only directory listings until a match. */
export async function findCodexThread(
	threadId: string,
	codexHome: string,
): Promise<CodexThread | null> {
	return findThreadInDays(threadId, await listDayDirectories(codexHome));
}

interface DayDirectory {
	readonly path: string;
	/** Local midnight of the directory's date. */
	readonly startsAt: number;
}

async function findThreadInDays(
	threadId: string,
	dayDirectories: readonly DayDirectory[],
): Promise<CodexThread | null> {
	const startedAt = getUuidV7Time(threadId);
	// UUIDv7 ids carry their creation time: check that date's folders first.
	const likely =
		startedAt === undefined
			? []
			: dayDirectories.filter(
					(day) => Math.abs(day.startsAt - startedAt) <= 2 * DAY_MS,
				);
	const rest = dayDirectories.filter((day) => !likely.includes(day));
	for (const day of [...likely, ...rest]) {
		const names = await readNames(day.path);
		for (const name of names) {
			if (!name.endsWith(`${threadId}.jsonl`)) continue;
			const thread = await readCodexThread(join(day.path, name));
			if (thread?.threadId === threadId) return thread;
		}
	}
	return null;
}

async function findDescendants(
	self: CodexThread,
	dayDirectories: readonly DayDirectory[],
	now: Date,
): Promise<CodexThread[]> {
	const selfStartedAt =
		getUuidV7Time(self.threadId) ??
		dayDirectories.find((day) => self.transcriptPath.startsWith(day.path))
			?.startsAt ??
		now.getTime() - CHILD_WINDOW_DAYS * DAY_MS;
	const windowStart = selfStartedAt - DAY_MS;
	const windowEnd = Math.min(
		now.getTime() + DAY_MS,
		selfStartedAt + (CHILD_WINDOW_DAYS + 1) * DAY_MS,
	);
	const childrenByParent = new Map<string, CodexThread[]>();
	let scanned = 0;
	const days = dayDirectories
		.filter((day) => day.startsAt >= windowStart && day.startsAt <= windowEnd)
		.sort((left, right) => left.startsAt - right.startsAt);
	scan: for (const day of days) {
		for (const name of await readNames(day.path)) {
			if (!name.endsWith(".jsonl")) continue;
			// Children are created after their parent; skip older UUIDv7 rollouts.
			const fileTime = getUuidV7Time(name.match(UUID_PATTERN)?.[0] ?? "");
			if (fileTime !== undefined && fileTime < selfStartedAt) continue;
			if (scanned >= MAX_CHILD_SCAN_FILES) break scan;
			scanned += 1;
			const thread = await readCodexThread(join(day.path, name));
			if (!thread?.parentThreadId || thread.kind !== "subagent") continue;
			const siblings = childrenByParent.get(thread.parentThreadId) ?? [];
			siblings.push(thread);
			childrenByParent.set(thread.parentThreadId, siblings);
		}
	}

	const descendants: CodexThread[] = [];
	const seen = new Set([self.threadId]);
	const queue = [self.threadId];
	while (queue.length > 0 && descendants.length < MAX_DESCENDANTS) {
		const parentId = queue.shift();
		if (parentId === undefined) break;
		for (const child of childrenByParent.get(parentId) ?? []) {
			if (seen.has(child.threadId) || descendants.length >= MAX_DESCENDANTS)
				continue;
			seen.add(child.threadId);
			descendants.push(child);
			queue.push(child.threadId);
		}
	}
	return descendants;
}

async function readCodexThread(path: string): Promise<CodexThread | null> {
	const first = await readJsonlFirstLine(path);
	if (!isRecord(first) || first.type !== "session_meta") return null;
	const payload = first.payload;
	if (!isRecord(payload) || typeof payload.id !== "string") return null;
	const source = isRecord(payload.source) ? payload.source : undefined;
	const subagent = isRecord(source?.subagent) ? source.subagent : undefined;
	const spawn = isRecord(subagent?.thread_spawn)
		? subagent.thread_spawn
		: undefined;
	const parentThreadId =
		readString(payload.parent_thread_id) ?? readString(spawn?.parent_thread_id);
	const git = isRecord(payload.git) ? payload.git : {};
	return {
		threadId: payload.id,
		transcriptPath: path,
		parentThreadId: parentThreadId === payload.id ? undefined : parentThreadId,
		kind: getThreadKind(payload.thread_source, subagent, spawn, parentThreadId),
		cwd: readString(payload.cwd) ?? "",
		gitBranch: readString(git.branch),
		gitSha: readString(git.commit_hash) ?? readString(git.sha),
	};
}

function getThreadKind(
	threadSource: unknown,
	subagent: Record<string, unknown> | undefined,
	spawn: Record<string, unknown> | undefined,
	parentThreadId: string | undefined,
): CodexThread["kind"] {
	if (spawn || threadSource === "subagent") return "subagent";
	if (subagent || (typeof threadSource === "string" && threadSource !== "user"))
		return "other";
	return parentThreadId ? "subagent" : "root";
}

/** `sessions/YYYY/MM/DD` folders, newest first. */
async function listDayDirectories(codexHome: string): Promise<DayDirectory[]> {
	const sessions = join(codexHome, "sessions");
	const days: DayDirectory[] = [];
	for (const year of await readNames(sessions)) {
		if (!/^\d{4}$/u.test(year)) continue;
		for (const month of await readNames(join(sessions, year))) {
			if (!/^\d{2}$/u.test(month)) continue;
			for (const day of await readNames(join(sessions, year, month))) {
				if (!/^\d{2}$/u.test(day)) continue;
				days.push({
					path: join(sessions, year, month, day),
					startsAt: new Date(
						Number(year),
						Number(month) - 1,
						Number(day),
					).getTime(),
				});
			}
		}
	}
	return days.sort((left, right) => right.startsAt - left.startsAt);
}

async function readNames(path: string): Promise<string[]> {
	try {
		return (await readdir(path)).sort();
	} catch {
		return [];
	}
}

/** Milliseconds encoded in a UUIDv7, or undefined for other ids. */
export function getUuidV7Time(id: string): number | undefined {
	const match = basename(id).match(UUID_PATTERN)?.[0];
	if (match?.[14] !== "7") return undefined;
	const time = Number.parseInt(match.replaceAll("-", "").slice(0, 12), 16);
	return Number.isSafeInteger(time) ? time : undefined;
}

function readString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
