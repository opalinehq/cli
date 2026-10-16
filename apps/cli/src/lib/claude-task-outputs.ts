import { lstat, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type {
	TaskOutputReference,
	TaskOutputReferences,
} from "../internal/local-context-source/index.js";

/** Bound on listed references, which keeps the capture manifest small. */
export const MAX_TASK_OUTPUT_REFERENCES = 512;
/** Bound on listed task ids whose output file was not on disk. */
export const MAX_MISSING_TASK_IDS = 256;

const TASK_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;
// `<task id>.output`, or one directory below (Claude Code moves some outputs
// to `tasks/rerooted/`).
const TASK_OUTPUT_PATH_PATTERN =
	/^(?:[A-Za-z0-9_-]{1,64}\/)?([A-Za-z0-9_-]{1,64})\.output/u;
// Bounded, so an unclosed tag costs at most this much scanning.
const NOTIFICATION_PATTERN =
	/<task-notification>([\s\S]{0,16384}?)<\/task-notification>/gu;
// `Command running in background with ID: <id>.` and `... was moved to the
// background (ID: <id>)`.
const BACKGROUND_ID_PATTERN =
	/\bbackground(?: with ID: | \(ID: )([A-Za-z0-9_-]{1,64})\b/gu;
const SEGMENT_PATTERN = /^[A-Za-z0-9._-]{1,255}$/u;
// Characters that end a path in transcript text (JSON quotes and escapes,
// tag brackets, whitespace), and how far back a referenced path may start.
const PATH_BOUNDARY = /[\s"'<>\\]/u;
const MAX_REFERENCED_PREFIX_CHARS = 4096;

interface Stream {
	readonly agentId: string | null;
	readonly content: string;
}

/**
 * Claude Code writes the output of background Bash commands and Monitor
 * tools to `<tmp>/claude-<uid>/<project dir>/<session id>/tasks/<task id>.output`,
 * where `<tmp>` is `$CLAUDE_CODE_TMPDIR` or `/tmp`, resolved (so
 * `/private/tmp` on macOS), and `<project dir>` is the name of the session's
 * `~/.claude/projects` directory. Async agents' outputs there are symlinks to
 * their subagent transcripts.
 *
 * The directory is taken from the transcript's own references when it names
 * one under a known temporary directory, for this user and this session;
 * otherwise it is computed. Null when the transcript is not
 * `<session id>.jsonl`, the platform has no user id, or the per-user
 * directory or `tasks` itself is not a plain directory of this user.
 */
export async function resolveClaudeTaskOutputsDirectory(input: {
	readonly transcriptPath: string;
	readonly sessionId: string;
	readonly streams: readonly Stream[];
	readonly env?: NodeJS.ProcessEnv;
	readonly uid?: number | null;
	readonly temporaryDirectory?: string;
}): Promise<string | null> {
	const { sessionId, transcriptPath } = input;
	if (basename(transcriptPath) !== `${sessionId}.jsonl`) return null;
	if (!SEGMENT_PATTERN.test(sessionId) || sessionId.startsWith("."))
		return null;
	const uid = getUid(input.uid);
	if (uid === null) return null;
	const env = input.env ?? process.env;
	const bases = await getTemporaryBases([
		getConfiguredTemporaryDirectory(env),
		"/tmp",
		"/private/tmp",
		input.temporaryDirectory ?? tmpdir(),
	]);
	const directory =
		findReferencedDirectory(input.streams, sessionId, uid, bases) ??
		join(
			await getClaudeTemporaryRoot(env, uid),
			basename(dirname(transcriptPath)),
			sessionId,
			"tasks",
		);
	// Another user may own a pre-created directory in a shared /tmp; only a
	// plain directory of this user (or one not created yet) is collected.
	for (const path of [dirname(dirname(dirname(directory))), directory]) {
		const details = await lstat(path).catch(() => null);
		if (details === null) continue;
		if (!details.isDirectory() || details.uid !== uid) return null;
	}
	return directory;
}

/**
 * Claude Code's per-user temporary directory, `claude-<uid>` in
 * `$CLAUDE_CODE_TMPDIR` or `/tmp` (not `$TMPDIR`), resolved like Claude Code
 * resolves it.
 */
export async function getClaudeTemporaryRoot(
	env: NodeJS.ProcessEnv,
	uid: number,
): Promise<string> {
	return join(
		await resolveExisting(getConfiguredTemporaryDirectory(env) ?? "/tmp"),
		`claude-${uid}`,
	);
}

/** This process's user id, or null on a platform without one. */
export function getUid(uid?: number | null): number | null {
	const value =
		uid === undefined
			? typeof process.getuid === "function"
				? process.getuid()
				: null
			: uid;
	return value !== null && Number.isSafeInteger(value) && value >= 0
		? value
		: null;
}

function getConfiguredTemporaryDirectory(
	env: NodeJS.ProcessEnv,
): string | undefined {
	return env.CLAUDE_CODE_TMPDIR?.trim() || undefined;
}

/**
 * The session's tasks directory with the transcript's references to it and
 * the referenced task ids whose output is not on disk, or null when the
 * session has no such directory (see resolveClaudeTaskOutputsDirectory).
 */
export async function collectClaudeTaskOutputReferences(
	input: Parameters<typeof resolveClaudeTaskOutputsDirectory>[0],
): Promise<{
	readonly directory: string;
	readonly references: TaskOutputReferences;
} | null> {
	const directory = await resolveClaudeTaskOutputsDirectory(input);
	if (directory === null) return null;
	const found = findTaskOutputReferences(input.streams, directory);
	return {
		directory,
		references: {
			...found,
			...(await findMissingTaskOutputs(directory, found.references)),
		},
	};
}

/**
 * The most often named `<base>/claude-<uid>/<project dir>/<session id>/tasks`
 * of the transcript, for a known base.
 */
function findReferencedDirectory(
	streams: readonly Stream[],
	sessionId: string,
	uid: number,
	bases: ReadonlySet<string>,
): string | null {
	// Linear: each `/<session id>/tasks/` is matched backwards to the start
	// of its path (a regex scanning forwards from every `/` would be
	// quadratic in long tokens such as base64 payloads).
	const needle = `/${sessionId}/tasks/`;
	const owner = new RegExp(`/claude-${uid}/([^/]{1,255})$`, "u");
	const counts = new Map<string, number>();
	for (const stream of streams) {
		const { content } = stream;
		for (
			let index = content.indexOf(needle);
			index >= 0;
			index = content.indexOf(needle, index + needle.length)
		) {
			let start = index;
			const limit = Math.max(0, index - MAX_REFERENCED_PREFIX_CHARS);
			while (start > limit && !PATH_BOUNDARY.test(content[start - 1] ?? ""))
				start -= 1;
			const prefix = content.slice(start, index);
			const slash = prefix.indexOf("/");
			if (slash < 0) continue;
			const path = prefix.slice(slash);
			const match = owner.exec(path);
			const slug = match?.[1];
			if (
				match === null ||
				slug === undefined ||
				!SEGMENT_PATTERN.test(slug) ||
				/^\.+$/u.test(slug)
			)
				continue;
			const base = path.slice(0, match.index);
			if (!bases.has(base)) continue;
			const directory = `${base}/claude-${uid}/${slug}/${sessionId}/tasks`;
			counts.set(directory, (counts.get(directory) ?? 0) + 1);
		}
	}
	let best: string | null = null;
	for (const [directory, count] of counts)
		if (best === null || count > (counts.get(best) ?? 0)) best = directory;
	return best;
}

/**
 * Every record that names a task output in `directory`: the tool result that
 * started the task (by its output path, its `background with ID` notice or
 * `toolUseResult.backgroundTaskId`), each task notification, and each Read
 * call on an output, in stream order. `toolUseId` is the tool call that
 * started the task; a notification or Read that does not name it gets it
 * from that call's result.
 */
export function findTaskOutputReferences(
	streams: readonly Stream[],
	directory: string,
): Omit<TaskOutputReferences, "missingTaskIds" | "missingTaskIdsOmitted"> {
	const prefix = `${directory}/`;
	const references: TaskOutputReference[] = [];
	const starters = new Map<string, string>();
	const seen = new Set<string>();
	let omitted = 0;
	const add = (reference: TaskOutputReference) => {
		const key = [
			reference.agentId ?? "",
			reference.recordIndex,
			reference.source,
			reference.taskId,
		].join("\0");
		if (seen.has(key)) return;
		seen.add(key);
		if (references.length >= MAX_TASK_OUTPUT_REFERENCES) {
			omitted += 1;
			return;
		}
		references.push(reference);
	};
	for (const stream of streams) {
		let start = 0;
		for (let line = 1; start < stream.content.length; line += 1) {
			const end = stream.content.indexOf("\n", start);
			const text = stream.content.slice(start, end < 0 ? undefined : end);
			start = end < 0 ? stream.content.length : end + 1;
			if (
				!text.includes(prefix) &&
				!text.includes("<task-notification>") &&
				!text.includes("background")
			)
				continue;
			const base = { agentId: stream.agentId, recordIndex: line };
			const record = parseRecord(text);
			for (const result of readToolResults(record)) {
				const tasks = new Map<string, string>();
				for (const path of findReferencedPaths(result.serialized, prefix))
					tasks.set(getTaskId(path), path);
				for (const match of result.serialized.matchAll(BACKGROUND_ID_PATTERN))
					if (match[1] && !tasks.has(match[1]))
						tasks.set(match[1], `${match[1]}.output`);
				if (result.backgroundTaskId && !tasks.has(result.backgroundTaskId))
					tasks.set(
						result.backgroundTaskId,
						`${result.backgroundTaskId}.output`,
					);
				for (const [taskId, path] of tasks) {
					if (!starters.has(taskId)) starters.set(taskId, result.toolUseId);
					add({
						...base,
						taskId,
						path,
						toolUseId: result.toolUseId,
						source: "result",
					});
				}
			}
			for (const read of readOutputReads(record, prefix))
				add({
					...base,
					taskId: getTaskId(read),
					path: read,
					toolUseId: null,
					source: "read",
				});
			for (const notification of readNotifications(text, prefix))
				add({ ...base, ...notification, source: "notification" });
		}
	}
	return {
		references: references.map((reference) =>
			reference.toolUseId === null
				? { ...reference, toolUseId: starters.get(reference.taskId) ?? null }
				: reference,
		),
		omitted,
	};
}

/**
 * Referenced task ids none of whose named output files (nor
 * `<task id>.output`) exists in `directory`, sorted and bounded.
 */
export async function findMissingTaskOutputs(
	directory: string,
	references: readonly TaskOutputReference[],
): Promise<
	Pick<TaskOutputReferences, "missingTaskIds" | "missingTaskIdsOmitted">
> {
	const candidates = new Map<string, Set<string>>();
	for (const reference of references) {
		const paths =
			candidates.get(reference.taskId) ??
			new Set([`${reference.taskId}.output`]);
		paths.add(reference.path);
		candidates.set(reference.taskId, paths);
	}
	const missing: string[] = [];
	for (const [taskId, paths] of candidates) {
		let present = false;
		for (const path of paths)
			if (
				await lstat(join(directory, path)).then(
					() => true,
					() => false,
				)
			) {
				present = true;
				break;
			}
		if (!present) missing.push(taskId);
	}
	missing.sort();
	return {
		missingTaskIds: missing.slice(0, MAX_MISSING_TASK_IDS),
		missingTaskIdsOmitted: Math.max(0, missing.length - MAX_MISSING_TASK_IDS),
	};
}

function readNotifications(
	text: string,
	prefix: string,
): readonly Pick<TaskOutputReference, "taskId" | "path" | "toolUseId">[] {
	const found: Pick<TaskOutputReference, "taskId" | "path" | "toolUseId">[] =
		[];
	for (const [, body = ""] of text.matchAll(NOTIFICATION_PATTERN)) {
		const toolUseId = readTag(body, "tool-use-id")[0] ?? null;
		const outputs = readTag(body, "output-file");
		const outputPaths = outputs.flatMap((output) =>
			output.startsWith(prefix)
				? findReferencedPaths(output, prefix).slice(0, 1)
				: [],
		);
		// A notification whose output file is elsewhere is not about this
		// session's tasks directory.
		if (outputs.length > 0 && outputPaths.length === 0) continue;
		for (const taskId of readTag(body, "task-id")) {
			if (!TASK_ID_PATTERN.test(taskId)) continue;
			found.push({
				taskId,
				path:
					outputPaths.find((path) => getTaskId(path) === taskId) ??
					`${taskId}.output`,
				toolUseId,
			});
		}
	}
	return found;
}

function readTag(body: string, tag: string): readonly string[] {
	return [
		...body.matchAll(new RegExp(`<${tag}>\\s*([^<]*?)\\s*</${tag}>`, "gu")),
	].flatMap(([, value]) => (value ? [value] : []));
}

/** Output paths below `prefix` named in `text`, relative to it. */
function findReferencedPaths(text: string, prefix: string): readonly string[] {
	const paths = new Set<string>();
	let index = text.indexOf(prefix);
	while (index >= 0) {
		const match = TASK_OUTPUT_PATH_PATTERN.exec(
			text.slice(index + prefix.length, index + prefix.length + 160),
		);
		if (match) paths.add(match[0]);
		index = text.indexOf(prefix, index + prefix.length);
	}
	return [...paths];
}

function getTaskId(path: string): string {
	return TASK_OUTPUT_PATH_PATTERN.exec(path)?.[1] ?? path;
}

function parseRecord(text: string): Record<string, unknown> | undefined {
	try {
		return asRecord(JSON.parse(text));
	} catch {
		return undefined;
	}
}

/** Tool results of a user record, each with its serialized content. */
function readToolResults(
	record: Record<string, unknown> | undefined,
): readonly {
	readonly toolUseId: string;
	readonly serialized: string;
	readonly backgroundTaskId: string | null;
}[] {
	const content = asRecord(record?.message)?.content;
	if (!Array.isArray(content)) return [];
	const results = content.flatMap((item) => {
		const block = asRecord(item);
		return block?.type === "tool_result" &&
			typeof block.tool_use_id === "string"
			? [
					{
						toolUseId: block.tool_use_id,
						serialized: JSON.stringify(block.content ?? ""),
					},
				]
			: [];
	});
	// `toolUseResult` describes the record's single tool result.
	const backgroundTaskId = asRecord(record?.toolUseResult)?.backgroundTaskId;
	return results.map((result) => ({
		...result,
		backgroundTaskId:
			results.length === 1 &&
			typeof backgroundTaskId === "string" &&
			TASK_ID_PATTERN.test(backgroundTaskId)
				? backgroundTaskId
				: null,
	}));
}

/** Output paths below `prefix` that an assistant record's Read calls open. */
function readOutputReads(
	record: Record<string, unknown> | undefined,
	prefix: string,
): readonly string[] {
	if (record?.type !== "assistant") return [];
	const content = asRecord(record.message)?.content;
	if (!Array.isArray(content)) return [];
	return content.flatMap((item) => {
		const block = asRecord(item);
		const path = asRecord(block?.input)?.file_path;
		if (
			block?.type !== "tool_use" ||
			block.name !== "Read" ||
			typeof path !== "string" ||
			!path.startsWith(prefix)
		)
			return [];
		const relative = path.slice(prefix.length);
		const match = TASK_OUTPUT_PATH_PATTERN.exec(relative);
		return match && match[0] === relative ? [relative] : [];
	});
}

async function getTemporaryBases(
	candidates: readonly (string | undefined)[],
): Promise<ReadonlySet<string>> {
	const bases = new Set<string>();
	for (const candidate of candidates) {
		if (candidate === undefined) continue;
		const path = resolve(candidate);
		bases.add(path);
		bases.add(await resolveExisting(path));
	}
	return bases;
}

async function resolveExisting(path: string): Promise<string> {
	return realpath(resolve(path)).catch(() => resolve(path));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? Object.fromEntries(Object.entries(value))
		: undefined;
}
