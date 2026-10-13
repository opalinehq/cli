import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { RepoIdentity } from "../contracts/index.js";
import type { FileBackedUploadRequest } from "../internal/agent-adapters/index.js";
import { exec } from "./exec.js";
import { type GitInfo, getGitInfo, getGitRemoteUrl } from "./git-info.js";
import {
	getLegacyRepositoryKeys,
	resolveUploadRepositoryIdentity,
} from "./repository-discovery.js";

// A session started outside a repository (a scratch folder, an empty launcher
// repository, a folder that only links to projects) still works in one: its
// tool calls edit, read and run commands there. Attribute it to the repository
// with the most such activity, edits counting more than reads and commands.

const WRITE_WEIGHT = 3;
const LOCATION_WEIGHT = 1;
// One edit, or two other signals: a single read elsewhere is not the session's work.
const MIN_REPOSITORY_SCORE = 2;
const MAX_RESOLVED_DIRECTORIES = 32;

const WRITE_TOOLS = new Set(["Edit", "MultiEdit", "Write"]);
const LOCATION_TOOLS = new Set(["Glob", "Grep", "LS", "Read"]);
const PATCH_FILE_PATTERN =
	/\*\*\* (?:Add|Update|Delete) File: ([^\n\\"]+)|\*\*\* Move to: ([^\n\\"]+)/gu;
const SHELL_PATH_PATTERN =
	/(?:^|[\s;&|("'])(?:cd|git\s+-C)\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|)'"\\]+))/gu;
const WORKDIR_PATTERN = /"?workdir"?\s*:\s*\\?"([^"\\]+)\\?"/gu;

export interface SessionPathSignal {
	readonly path: string;
	readonly weight: number;
}

export interface InferredSessionRepository {
	readonly gitInfo: GitInfo;
	readonly legacyKeys: readonly string[];
	readonly repository: RepoIdentity;
}

/**
 * The repository a session worked in when its working directory has none (no
 * remote and no package), from the paths its tool calls used. Null when the
 * working directory already identifies one, or the transcript does not.
 */
export async function inferSessionRepository(
	request: FileBackedUploadRequest,
): Promise<InferredSessionRepository | null> {
	const { gitRemote, packageName, projectPath } = request.metadata;
	if (gitRemote || packageName) return null;
	const signals: SessionPathSignal[] = [];
	for (const path of [
		request.transcriptPath,
		...request.subagents.map((subagent) => subagent.path),
	]) {
		await readSessionPathSignals(path, projectPath, signals);
	}
	const root = await pickSessionRepositoryRoot(signals);
	if (!root) return null;
	const gitInfo = await getGitInfo(root);
	if (!gitInfo.gitRemote) return null;
	return {
		gitInfo,
		legacyKeys: getLegacyRepositoryKeys(root, gitInfo),
		repository: resolveUploadRepositoryIdentity(root, gitInfo),
	};
}

/** The request with the repository's metadata; `projectPath` is unchanged. */
export function withSessionRepository(
	request: FileBackedUploadRequest,
	gitInfo: GitInfo,
): FileBackedUploadRequest {
	return {
		...request,
		metadata: {
			...request.metadata,
			gitRemote: gitInfo.gitRemote,
			packageName: gitInfo.packageName,
			packageType: gitInfo.packageType,
			gitBranch: gitInfo.branch,
			gitSha: gitInfo.sha,
		},
	};
}

/** For uploads the user chose by hand: no automatic upload setting applies. */
export async function withInferredSessionRepository(
	request: FileBackedUploadRequest,
): Promise<FileBackedUploadRequest> {
	const inferred = await inferSessionRepository(request);
	return inferred ? withSessionRepository(request, inferred.gitInfo) : request;
}

async function readSessionPathSignals(
	path: string,
	projectPath: string,
	signals: SessionPathSignal[],
): Promise<void> {
	// Transcripts can be hundreds of MiB: stream them, and parse only tool calls.
	const lines = createInterface({
		input: createReadStream(path, { encoding: "utf8" }),
		crlfDelay: Number.POSITIVE_INFINITY,
	});
	try {
		for await (const line of lines) {
			collectLineSignals(line, projectPath, signals);
		}
	} catch {
		// An unreadable stream only loses its signals; the upload reports the file.
	} finally {
		lines.close();
	}
}

/** Paths a Claude Code or Codex transcript's tool calls wrote, read or ran in. */
export function collectSessionPathSignals(
	content: string,
	projectPath: string,
): SessionPathSignal[] {
	const signals: SessionPathSignal[] = [];
	for (const line of content.split("\n")) {
		collectLineSignals(line, projectPath, signals);
	}
	return signals;
}

function collectLineSignals(
	line: string,
	projectPath: string,
	signals: SessionPathSignal[],
) {
	if (!line.includes("tool_use") && !line.includes("_call")) return;
	let record: unknown;
	try {
		record = JSON.parse(line);
	} catch {
		return;
	}
	if (!isRecord(record)) return;
	collectClaudeSignals(record, projectPath, signals);
	collectCodexSignals(record, projectPath, signals);
}

function collectClaudeSignals(
	record: Record<string, unknown>,
	projectPath: string,
	signals: SessionPathSignal[],
) {
	const message = record.message;
	if (!isRecord(message) || !Array.isArray(message.content)) return;
	for (const block of message.content) {
		if (!isRecord(block) || block.type !== "tool_use") continue;
		if (typeof block.name !== "string" || !isRecord(block.input)) continue;
		const input = block.input;
		if (WRITE_TOOLS.has(block.name)) {
			pushPath(signals, input.file_path, projectPath, WRITE_WEIGHT);
		} else if (block.name === "NotebookEdit") {
			pushPath(signals, input.notebook_path, projectPath, WRITE_WEIGHT);
		} else if (LOCATION_TOOLS.has(block.name)) {
			pushPath(signals, input.file_path, projectPath, LOCATION_WEIGHT);
			pushPath(signals, input.path, projectPath, LOCATION_WEIGHT);
		} else if (block.name === "Bash" && typeof input.command === "string") {
			collectShellSignals(input.command, signals);
		}
	}
}

function collectCodexSignals(
	record: Record<string, unknown>,
	projectPath: string,
	signals: SessionPathSignal[],
) {
	const payload = record.payload;
	if (record.type !== "response_item" || !isRecord(payload)) return;
	if (payload.type === "local_shell_call" && isRecord(payload.action)) {
		const { command, working_directory: workdir } = payload.action;
		pushPath(signals, workdir, projectPath, LOCATION_WEIGHT);
		if (Array.isArray(command)) collectShellSignals(command.join(" "), signals);
		return;
	}
	const text =
		payload.type === "function_call"
			? payload.arguments
			: payload.type === "custom_tool_call"
				? payload.input
				: undefined;
	if (typeof text !== "string") return;

	const args = parseJsonObject(text);
	const workdir =
		typeof args?.workdir === "string" ? args.workdir : projectPath;
	if (args) {
		pushPath(signals, args.workdir, projectPath, LOCATION_WEIGHT);
		const command = Array.isArray(args.command)
			? args.command.join(" ")
			: (args.cmd ?? args.command);
		if (typeof command === "string") collectShellSignals(command, signals);
	} else {
		// Tool calls wrapped in code (such as `exec`) are scanned as text.
		for (const match of text.matchAll(WORKDIR_PATTERN)) {
			pushPath(signals, match[1], projectPath, LOCATION_WEIGHT);
		}
		collectShellSignals(text, signals);
	}
	for (const match of text.matchAll(PATCH_FILE_PATTERN)) {
		pushPath(signals, (match[1] ?? match[2])?.trim(), workdir, WRITE_WEIGHT);
	}
}

function collectShellSignals(command: string, signals: SessionPathSignal[]) {
	for (const match of command.matchAll(SHELL_PATH_PATTERN)) {
		const path = match[1] ?? match[2] ?? match[3];
		// Relative shell paths depend on earlier commands, so only absolute ones count.
		if (path && (isAbsolute(path) || path.startsWith("~/"))) {
			pushPath(signals, path, "/", LOCATION_WEIGHT);
		}
	}
}

function pushPath(
	signals: SessionPathSignal[],
	value: unknown,
	base: string,
	weight: number,
) {
	if (typeof value !== "string" || !value.trim()) return;
	const path = value.startsWith("~/")
		? resolve(homedir(), value.slice(2))
		: resolve(base, value);
	signals.push({ path, weight });
}

/**
 * Scores worktrees, then groups them by remote so a repository's worktrees
 * count together. The most active worktree of the winning repository supplies
 * the branch and SHA. Null when the most active repository has no remote: a
 * local-only project the session edited must not be credited to one it read.
 */
async function pickSessionRepositoryRoot(
	signals: readonly SessionPathSignal[],
): Promise<string | null> {
	const directoryScores = new Map<string, number>();
	const directoryByPath = new Map<string, Promise<string | null>>();
	for (const signal of signals) {
		let lookup = directoryByPath.get(signal.path);
		if (!lookup) {
			lookup = nearestExistingDirectory(signal.path);
			directoryByPath.set(signal.path, lookup);
		}
		const directory = await lookup;
		if (!directory) continue;
		directoryScores.set(
			directory,
			(directoryScores.get(directory) ?? 0) + signal.weight,
		);
	}
	const directories = [...directoryScores]
		.sort((left, right) => right[1] - left[1])
		.slice(0, MAX_RESOLVED_DIRECTORIES);
	const roots = await Promise.all(
		directories.map(([directory]) => getWorktreeRoot(directory)),
	);
	const rootScores = new Map<string, number>();
	for (const [index, root] of roots.entries()) {
		const score = directories[index]?.[1];
		if (!root || score === undefined) continue;
		rootScores.set(root, (rootScores.get(root) ?? 0) + score);
	}

	const repositories = new Map<
		string,
		{ remote: string | null; score: number; root: string; rootScore: number }
	>();
	for (const [root, score] of rootScores) {
		const remote = await getGitRemoteUrl(root);
		const key = remote ?? `local:${root}`;
		const current = repositories.get(key);
		repositories.set(key, {
			remote,
			score: (current?.score ?? 0) + score,
			...(current && current.rootScore >= score
				? { root: current.root, rootScore: current.rootScore }
				: { root, rootScore: score }),
		});
	}
	const [top] = [...repositories.values()].sort(
		(left, right) => right.score - left.score,
	);
	if (!top || top.score < MIN_REPOSITORY_SCORE || !top.remote) return null;
	return top.root;
}

async function nearestExistingDirectory(path: string): Promise<string | null> {
	let current = path;
	while (current !== dirname(current)) {
		const stats = await stat(current).catch(() => null);
		if (stats?.isDirectory()) return current;
		if (stats) return dirname(current);
		current = dirname(current);
	}
	return null;
}

async function getWorktreeRoot(directory: string): Promise<string | null> {
	const result = await exec("git", [
		"-C",
		directory,
		"rev-parse",
		"--show-toplevel",
	]).catch(() => null);
	if (result?.exitCode !== 0) return null;
	return result.stdout.trim() || null;
}

function parseJsonObject(text: string): Record<string, unknown> | null {
	if (!text.trimStart().startsWith("{")) return null;
	try {
		const value: unknown = JSON.parse(text);
		return isRecord(value) ? value : null;
	} catch {
		return null;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
