import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { filterKnownSecrets } from "../secret-filter/index.js";
import type { BlobStore } from "./blob-store.js";
import { addSanitizedTextBlob } from "./blob-store.js";
import { getHighRiskContentPathspecExclusions } from "./path-policy.js";
import type {
	CaptureConsistency,
	GitCommandResult,
	GitCommit,
	GitDiff,
	GitFileProvenance,
	GitRemote,
	GitRepositorySnapshot,
	GitSnapshot,
	GitStatusEntry,
	GitWorktree,
	LocalContextCollectionLimits,
	LocalContextGitRunner,
} from "./types.js";

const UTF8_DECODER = new TextDecoder();
export const SAFE_DIFF_PATHSPEC: readonly string[] = [
	".",
	...getHighRiskContentPathspecExclusions(),
];

function buildDiffPathspec(
	excludedPathPrefixes: readonly string[],
): readonly string[] {
	return [
		...SAFE_DIFF_PATHSPEC,
		...excludedPathPrefixes.map((prefix) => {
			const normalized = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
			return `:(exclude,top,literal)${normalized}`;
		}),
	];
}

export interface GitIndexEntry {
	readonly objectId: string;
	readonly mode: string;
	readonly stage: number;
}

export interface GitCollectionResult {
	readonly snapshot: GitSnapshot;
	readonly repositoryRoot: string;
	readonly headCommit: string | null;
	readonly objectFormat: "sha1" | "sha256" | "unknown";
	readonly indexEntries: ReadonlyMap<string, GitIndexEntry>;
	readonly dirtyPaths: ReadonlySet<string>;
	readonly trackedPaths: ReadonlySet<string>;
	readonly untrackedPaths: ReadonlySet<string>;
	readonly ignoredPaths: ReadonlySet<string>;
	readonly statusFingerprint: string | null;
	readonly canReuseGitObjects: boolean;
}

interface NamedGitResult {
	readonly name: string;
	readonly result: GitCommandResult;
}

export async function collectGitSnapshot(
	requestedRoot: string,
	limits: LocalContextCollectionLimits,
	git: LocalContextGitRunner,
	blobStore: BlobStore,
	excludedPathPrefixes: readonly string[],
): Promise<GitCollectionResult> {
	const rootResult = await runGit(
		requestedRoot,
		["rev-parse", "--show-toplevel"],
		limits,
		git,
	);
	if (rootResult.timedOut) {
		return unavailableGitResult(
			requestedRoot,
			"command-timeout",
			"Git repository discovery timed out.",
		);
	}
	if (rootResult.exitCode !== 0 || rootResult.truncated) {
		return unavailableGitResult(
			requestedRoot,
			"not-a-repository",
			"The requested root is not an accessible Git worktree.",
		);
	}

	const repositoryRoot = decode(rootResult.stdout).trim();
	const diffPathspec = buildDiffPathspec(excludedPathPrefixes);
	const commands = await Promise.all([
		runNamed(
			"head",
			repositoryRoot,
			["rev-parse", "--verify", "HEAD"],
			limits,
			git,
		),
		runNamed(
			"branch",
			repositoryRoot,
			["symbolic-ref", "--quiet", "--short", "HEAD"],
			limits,
			git,
		),
		runNamed(
			"git-directory",
			repositoryRoot,
			["rev-parse", "--path-format=absolute", "--git-dir"],
			limits,
			git,
		),
		runNamed(
			"common-directory",
			repositoryRoot,
			["rev-parse", "--path-format=absolute", "--git-common-dir"],
			limits,
			git,
		),
		runNamed(
			"bare",
			repositoryRoot,
			["rev-parse", "--is-bare-repository"],
			limits,
			git,
		),
		runNamed(
			"object-format",
			repositoryRoot,
			["rev-parse", "--show-object-format"],
			limits,
			git,
		),
		runNamed("remotes", repositoryRoot, ["remote", "-v"], limits, git),
		runNamed(
			"worktrees",
			repositoryRoot,
			["worktree", "list", "--porcelain", "-z"],
			limits,
			git,
		),
		runNamed(
			"status",
			repositoryRoot,
			[
				"status",
				"--porcelain=v2",
				"-z",
				"--branch",
				"--untracked-files=all",
				"--ignored=matching",
			],
			limits,
			git,
		),
		runNamed(
			"index",
			repositoryRoot,
			["ls-files", "--stage", "-z"],
			limits,
			git,
		),
		runNamed(
			"untracked",
			repositoryRoot,
			["ls-files", "--others", "--exclude-standard", "-z"],
			limits,
			git,
		),
		runNamed(
			"ignored",
			repositoryRoot,
			["ls-files", "--others", "--ignored", "--exclude-standard", "-z"],
			limits,
			git,
		),
		runNamed(
			"working-diff",
			repositoryRoot,
			[
				"diff",
				"--no-ext-diff",
				"--no-textconv",
				"--no-color",
				"--submodule=short",
				"--",
				...diffPathspec,
			],
			limits,
			git,
		),
		runNamed(
			"staged-diff",
			repositoryRoot,
			[
				"diff",
				"--cached",
				"--no-ext-diff",
				"--no-textconv",
				"--no-color",
				"--submodule=short",
				"--",
				...diffPathspec,
			],
			limits,
			git,
		),
		runNamed(
			"commits",
			repositoryRoot,
			[
				"log",
				`-${limits.maxCommits}`,
				"--format=%H%x00%P%x00%an%x00%ae%x00%aI%x00%cI%x00%D%x00%s%x00",
			],
			limits,
			git,
		),
	]);
	const results = new Map(
		commands.map((command) => [command.name, command.result]),
	);
	const truncatedSections = commands
		.filter((command) => command.result.truncated)
		.map((command) => command.name)
		.sort(compareStrings);
	const errors = commands
		.filter(
			(command) =>
				command.result.exitCode !== 0 &&
				command.name !== "branch" &&
				command.name !== "head",
		)
		.map((command) => `${command.name}: ${summarizeGitFailure(command.result)}`)
		.sort(compareStrings);

	const headCommit = getSuccessfulText(results.get("head"));
	const branch = getSuccessfulText(results.get("branch"));
	const objectFormat = parseObjectFormat(
		getSuccessfulText(results.get("object-format")),
	);
	const statusEntries = parseStatus(getSuccessfulBytes(results.get("status")));
	const statusFingerprint = getResultFingerprint(results.get("status"));
	const indexEntries = parseIndex(getSuccessfulBytes(results.get("index")));
	const canReuseGitObjects =
		headCommit !== null &&
		isCompleteSuccessfulResult(results.get("status")) &&
		isCompleteSuccessfulResult(results.get("index"));
	const trackedPaths = new Set(indexEntries.keys());
	const untrackedPaths = new Set(
		parseNulPaths(getSuccessfulBytes(results.get("untracked"))),
	);
	const ignoredPaths = new Set(
		parseNulPaths(getSuccessfulBytes(results.get("ignored"))),
	);
	const dirtyPaths = getDirtyPaths(statusEntries);
	const diffs = [
		buildDiff("working-tree", results.get("working-diff"), blobStore),
		buildDiff("staged", results.get("staged-diff"), blobStore),
	];

	const snapshot: GitRepositorySnapshot = {
		status: "available",
		root: repositoryRoot,
		gitDirectory: resolveGitPath(
			repositoryRoot,
			getSuccessfulText(results.get("git-directory")),
		),
		commonDirectory: resolveGitPath(
			repositoryRoot,
			getSuccessfulText(results.get("common-directory")),
		),
		bare: getSuccessfulText(results.get("bare")) === "true",
		head: {
			commit: headCommit,
			branch: sanitizeNullableGitMetadata(branch),
			detached: headCommit !== null && branch === null,
		},
		remotes: parseRemotes(getSuccessfulText(results.get("remotes")) ?? ""),
		worktrees: parseWorktrees(getSuccessfulBytes(results.get("worktrees"))),
		statusEntries,
		commits: parseCommits(getSuccessfulBytes(results.get("commits"))),
		diffs,
		truncatedSections,
		errors,
	};
	return {
		snapshot,
		repositoryRoot,
		headCommit,
		objectFormat,
		indexEntries,
		dirtyPaths,
		trackedPaths,
		untrackedPaths,
		ignoredPaths,
		statusFingerprint,
		canReuseGitObjects,
	};
}

export async function checkGitConsistency(
	initial: GitCollectionResult,
	limits: LocalContextCollectionLimits,
	git: LocalContextGitRunner,
): Promise<CaptureConsistency> {
	if (initial.snapshot.status !== "available") {
		return {
			atomic: false,
			status: "unavailable",
			initialHead: initial.headCommit,
			finalHead: null,
			initialStatusFingerprint: initial.statusFingerprint,
			finalStatusFingerprint: null,
		};
	}
	const [head, status] = await Promise.all([
		runGit(
			initial.repositoryRoot,
			["rev-parse", "--verify", "HEAD"],
			limits,
			git,
		),
		runGit(
			initial.repositoryRoot,
			[
				"status",
				"--porcelain=v2",
				"-z",
				"--branch",
				"--untracked-files=all",
				"--ignored=matching",
			],
			limits,
			git,
		),
	]);
	const finalHead = getSuccessfulText(head);
	const finalStatusFingerprint = getResultFingerprint(status);
	if (finalStatusFingerprint === null || head.timedOut || status.timedOut) {
		return {
			atomic: false,
			status: "unavailable",
			initialHead: initial.headCommit,
			finalHead,
			initialStatusFingerprint: initial.statusFingerprint,
			finalStatusFingerprint,
		};
	}
	return {
		atomic: false,
		status:
			initial.headCommit === finalHead &&
			initial.statusFingerprint === finalStatusFingerprint
				? "stable"
				: "concurrent-change",
		initialHead: initial.headCommit,
		finalHead,
		initialStatusFingerprint: initial.statusFingerprint,
		finalStatusFingerprint,
	};
}

export function getGitFileProvenance(
	path: string,
	git: GitCollectionResult,
): GitFileProvenance {
	if (git.trackedPaths.has(path)) return "tracked";
	if (git.untrackedPaths.has(path)) return "untracked";
	if (
		git.ignoredPaths.has(path) ||
		isUnderListedDirectory(path, git.ignoredPaths)
	) {
		return "ignored";
	}
	return git.snapshot.status === "available"
		? "unclassified"
		: "outside-repository";
}

function unavailableGitResult(
	root: string,
	reason: "not-a-repository" | "command-failed" | "command-timeout",
	detail: string,
): GitCollectionResult {
	return {
		snapshot: { status: "unavailable", reason, detail },
		repositoryRoot: root,
		headCommit: null,
		objectFormat: "unknown",
		indexEntries: new Map(),
		dirtyPaths: new Set(),
		trackedPaths: new Set(),
		untrackedPaths: new Set(),
		ignoredPaths: new Set(),
		statusFingerprint: null,
		canReuseGitObjects: false,
	};
}

async function runNamed(
	name: string,
	root: string,
	args: readonly string[],
	limits: LocalContextCollectionLimits,
	git: LocalContextGitRunner,
): Promise<NamedGitResult> {
	return { name, result: await runGit(root, args, limits, git) };
}

function runGit(
	root: string,
	args: readonly string[],
	limits: LocalContextCollectionLimits,
	git: LocalContextGitRunner,
): Promise<GitCommandResult> {
	return git.run(
		root,
		args,
		limits.maxGitOutputBytesPerCommand,
		limits.gitCommandTimeoutMs,
	);
}

function buildDiff(
	kind: GitDiff["kind"],
	result: GitCommandResult | undefined,
	blobStore: BlobStore,
): GitDiff {
	if (result === undefined || result.exitCode !== 0) {
		return omittedDiff(kind, "secret-filter-failure");
	}
	if (result.truncated || result.timedOut) {
		return {
			...omittedDiff(kind, "truncated"),
			sourceByteLength: result.stdout.byteLength,
			truncated: true,
		};
	}
	if (result.stdout.byteLength === 0) return omittedDiff(kind, "empty");

	const patch = decode(result.stdout);
	const sanitized = addSanitizedTextBlob(
		patch,
		result.stdout.byteLength,
		blobStore,
	);
	if (sanitized.status === "failure") {
		return {
			...omittedDiff(kind, sanitized.reason),
			sourceByteLength: result.stdout.byteLength,
		};
	}
	const containsBinaryChanges =
		patch.includes("GIT binary patch") || patch.includes("Binary files ");
	return {
		kind,
		blobId: sanitized.blobId,
		sourceByteLength: sanitized.sourceByteLength,
		storedByteLength: sanitized.storedByteLength,
		truncated: false,
		reconstructable:
			!containsBinaryChanges && sanitized.secretFilter.redactedBytes === 0,
		containsBinaryChanges,
		highRiskPathsExcluded: true,
		secretFilter: sanitized.secretFilter,
		omissionReason: null,
	};
}

function omittedDiff(
	kind: GitDiff["kind"],
	reason: Exclude<GitDiff["omissionReason"], null>,
): GitDiff {
	return {
		kind,
		blobId: null,
		sourceByteLength: 0,
		storedByteLength: 0,
		truncated: reason === "truncated",
		reconstructable: reason === "empty",
		containsBinaryChanges: false,
		highRiskPathsExcluded: true,
		secretFilter: null,
		omissionReason: reason,
	};
}

function parseStatus(bytes: Uint8Array): readonly GitStatusEntry[] {
	const records = splitNul(bytes);
	const entries: GitStatusEntry[] = [];
	for (let index = 0; index < records.length; index += 1) {
		const record = records[index];
		if (
			record === undefined ||
			record.length === 0 ||
			record.startsWith("# ")
		) {
			continue;
		}
		if (record.startsWith("? ") || record.startsWith("! ")) {
			entries.push({
				path: record.slice(2),
				originalPath: null,
				indexStatus: record[0] === "?" ? "?" : "!",
				worktreeStatus: record[0] === "?" ? "?" : "!",
				kind: record[0] === "?" ? "untracked" : "ignored",
			});
			continue;
		}
		const fields = record.split(" ");
		const type = fields[0];
		const status = fields[1] ?? "..";
		const pathFieldIndex = type === "u" ? 10 : type === "2" ? 9 : 8;
		const path = fields.slice(pathFieldIndex).join(" ");
		if (type === "1" || type === "u") {
			entries.push({
				path,
				originalPath: null,
				indexStatus: status[0] ?? ".",
				worktreeStatus: status[1] ?? ".",
				kind: type === "u" ? "unmerged" : "ordinary",
			});
			continue;
		}
		if (type === "2") {
			const originalPath = records[index + 1] ?? null;
			entries.push({
				path,
				originalPath,
				indexStatus: status[0] ?? ".",
				worktreeStatus: status[1] ?? ".",
				kind: "renamed",
			});
			index += 1;
		}
	}
	return entries.sort((left, right) => compareStrings(left.path, right.path));
}

function parseIndex(bytes: Uint8Array): ReadonlyMap<string, GitIndexEntry> {
	const entries = new Map<string, GitIndexEntry>();
	for (const record of splitNul(bytes)) {
		const separator = record.indexOf("\t");
		if (separator < 0) continue;
		const metadata = record.slice(0, separator).split(" ");
		const path = record.slice(separator + 1);
		const objectId = metadata[1];
		const stageText = metadata[2];
		if (objectId === undefined || stageText === undefined) continue;
		const stage = Number.parseInt(stageText, 10);
		if (!Number.isSafeInteger(stage)) continue;
		entries.set(path, {
			objectId,
			mode: metadata[0] ?? "",
			stage,
		});
	}
	return entries;
}

function parseNulPaths(bytes: Uint8Array): readonly string[] {
	return splitNul(bytes)
		.filter((path) => path.length > 0)
		.sort(compareStrings);
}

function getDirtyPaths(
	entries: readonly GitStatusEntry[],
): ReadonlySet<string> {
	const paths = new Set<string>();
	for (const entry of entries) {
		if (
			entry.kind === "ordinary" ||
			entry.kind === "renamed" ||
			entry.kind === "unmerged"
		) {
			paths.add(entry.path);
			if (entry.originalPath !== null) paths.add(entry.originalPath);
		}
	}
	return paths;
}

function parseRemotes(text: string): readonly GitRemote[] {
	const remotes: GitRemote[] = [];
	for (const line of text.split("\n")) {
		const match = /^(\S+)\s+(.+)\s+\((fetch|push)\)$/u.exec(line);
		if (
			match?.[1] === undefined ||
			match[2] === undefined ||
			match[3] === undefined
		) {
			continue;
		}
		remotes.push({
			name: sanitizeGitMetadata(match[1]),
			direction: match[3] === "fetch" ? "fetch" : "push",
			url: sanitizeGitMetadata(sanitizeRemoteUrl(match[2])),
		});
	}
	return remotes.sort((left, right) =>
		compareStrings(
			`${left.name}\0${left.direction}`,
			`${right.name}\0${right.direction}`,
		),
	);
}

function parseWorktrees(bytes: Uint8Array): readonly GitWorktree[] {
	const worktrees: GitWorktree[] = [];
	let fields: string[] = [];
	for (const token of [...splitNul(bytes), ""]) {
		if (token.length > 0) {
			fields.push(token);
			continue;
		}
		if (fields.length > 0) worktrees.push(buildWorktree(fields));
		fields = [];
	}
	return worktrees.sort((left, right) => compareStrings(left.path, right.path));
}

function buildWorktree(fields: readonly string[]): GitWorktree {
	return {
		path: sanitizeGitMetadata(getPorcelainValue(fields, "worktree") ?? ""),
		head: getPorcelainValue(fields, "HEAD"),
		branch: sanitizeNullableGitMetadata(getPorcelainValue(fields, "branch")),
		bare: fields.includes("bare"),
		detached: fields.includes("detached"),
		locked: sanitizeNullableGitMetadata(
			getPorcelainOptionalValue(fields, "locked"),
		),
		prunable: sanitizeNullableGitMetadata(
			getPorcelainOptionalValue(fields, "prunable"),
		),
	};
}

function parseCommits(bytes: Uint8Array): readonly GitCommit[] {
	const fields = splitNul(bytes);
	const commits: GitCommit[] = [];
	for (let index = 0; index + 7 < fields.length; index += 8) {
		const hash = (fields[index] ?? "").replace(/^\n/u, "");
		if (hash.length === 0) continue;
		commits.push({
			hash,
			parentHashes: (fields[index + 1] ?? "").split(" ").filter(Boolean),
			authorName: sanitizeGitMetadata(fields[index + 2] ?? ""),
			authorEmail: sanitizeGitMetadata(fields[index + 3] ?? ""),
			authoredAt: fields[index + 4] ?? "",
			committedAt: fields[index + 5] ?? "",
			decorations: sanitizeGitMetadata(fields[index + 6] ?? ""),
			subject: sanitizeGitMetadata(fields[index + 7] ?? ""),
		});
	}
	return commits;
}

function getPorcelainValue(
	fields: readonly string[],
	key: string,
): string | null {
	const prefix = `${key} `;
	const field = fields.find((candidate) => candidate.startsWith(prefix));
	return field?.slice(prefix.length) ?? null;
}

function getPorcelainOptionalValue(
	fields: readonly string[],
	key: string,
): string | null {
	const exact = fields.find((candidate) => candidate === key);
	if (exact !== undefined) return "";
	return getPorcelainValue(fields, key);
}

function getSuccessfulText(
	result: GitCommandResult | undefined,
): string | null {
	if (
		result === undefined ||
		result.exitCode !== 0 ||
		result.truncated ||
		result.timedOut
	) {
		return null;
	}
	return decode(result.stdout).trim();
}

function getSuccessfulBytes(result: GitCommandResult | undefined): Uint8Array {
	if (
		result === undefined ||
		result.exitCode !== 0 ||
		result.truncated ||
		result.timedOut
	) {
		return new Uint8Array();
	}
	return result.stdout;
}

function getResultFingerprint(
	result: GitCommandResult | undefined,
): string | null {
	if (!isCompleteSuccessfulResult(result)) {
		return null;
	}
	return createHash("sha256").update(result.stdout).digest("hex");
}

function isCompleteSuccessfulResult(
	result: GitCommandResult | undefined,
): result is GitCommandResult {
	return (
		result !== undefined &&
		result.exitCode === 0 &&
		!result.truncated &&
		!result.timedOut
	);
}

function splitNul(bytes: Uint8Array): readonly string[] {
	return decode(bytes).split("\0");
}

function parseObjectFormat(
	value: string | null,
): "sha1" | "sha256" | "unknown" {
	if (value === "sha1" || value === "sha256") return value;
	return "unknown";
}

function resolveGitPath(root: string, path: string | null): string {
	if (path === null) return "";
	return isAbsolute(path) ? path : resolve(root, path);
}

function sanitizeRemoteUrl(value: string): string {
	try {
		const url = new URL(value);
		if (url.username.length > 0) url.username = "[REDACTED]";
		if (url.password.length > 0) url.password = "[REDACTED]";
		url.search = "";
		url.hash = "";
		return url.toString();
	} catch {
		return value.replace(/^(https?:\/\/)[^/@\s]+@/u, "$1[REDACTED]@");
	}
}

function sanitizeGitMetadata(value: string): string {
	try {
		return filterKnownSecrets(value).text;
	} catch {
		return "[REDACTED]";
	}
}

function sanitizeNullableGitMetadata(value: string | null): string | null {
	return value === null ? null : sanitizeGitMetadata(value);
}

function summarizeGitFailure(result: GitCommandResult): string {
	if (result.timedOut) return "command timed out";
	const message =
		decode(result.stderr).trim().split("\n")[0] ?? "command failed";
	return sanitizeGitMetadata(sanitizeRemoteUrl(message)).slice(0, 500);
}

/**
 * Whether an ancestor directory of `path` is listed. Looks up each ancestor
 * instead of scanning the list, which holds every ignored file of the
 * repository (tens of thousands in agent workspaces) and was scanned once per
 * inventory entry.
 */
function isUnderListedDirectory(
	path: string,
	listed: ReadonlySet<string>,
): boolean {
	for (
		let separator = path.indexOf("/");
		separator > 0;
		separator = path.indexOf("/", separator + 1)
	) {
		const ancestor = path.slice(0, separator);
		if (listed.has(ancestor) || listed.has(`${ancestor}/`)) return true;
	}
	return false;
}

function decode(bytes: Uint8Array): string {
	return UTF8_DECODER.decode(bytes);
}

function compareStrings(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}
