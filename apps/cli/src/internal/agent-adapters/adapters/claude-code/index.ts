import {
	lstat,
	opendir,
	readdir,
	readFile,
	realpath,
	stat,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import pMap from "p-map";
import { INGEST_MAX_SUBAGENT_COUNT } from "../../../../contracts/ingest.js";
import { MAX_RAW_TRANSCRIPT_BYTES } from "../../../../lib/filtered-upload-staging.js";
import { scanBoundedJsonlFile } from "../../bounded-jsonl-scan.js";
import { MissingTranscriptTimestampError } from "../../errors.js";
import type {
	AgentAdapter,
	FileBackedUploadRequest,
	FileBackedUploadSubagent,
	FileBackedUploadSubagentDiscovery,
	HookOptions,
	ScannedProject,
	SessionFile,
	SessionScanOptions,
	SessionTimestamps,
	UploadContext,
} from "../../types.js";
import { readSessionDiscoveryMetadata, toDisplayPath } from "../../utils.js";
import {
	addHook,
	getClaudeProjectSettingsPath,
	isHookEnabled,
	readClaudeSettings,
	removeHook,
} from "./settings.js";

const SAFE_BASENAME_PATTERN = /^[A-Za-z0-9_-]{1,200}$/;
const SUBAGENT_FILENAME_PATTERN = /^agent-([A-Za-z0-9_-]{1,200})\.jsonl$/u;
const MAX_SUBAGENT_DIRECTORY_ENTRIES = 4_096;

// ── Exported utilities ──

export function encodeProjectPath(projectPath: string): string {
	return projectPath.replace(/\//g, "-");
}

export async function decodeProjectPath(encodedDir: string): Promise<string> {
	const parts = encodedDir.replace(/^-/, "").split("-");

	async function findPath(
		partIndex: number,
		currentPath: string,
	): Promise<string | null> {
		if (partIndex >= parts.length) {
			try {
				await stat(currentPath);
				return currentPath;
			} catch {
				return null;
			}
		}

		for (let endIndex = parts.length; endIndex > partIndex; endIndex--) {
			const segment = parts.slice(partIndex, endIndex).join("-");
			const testPath = currentPath
				? `${currentPath}/${segment}`
				: `/${segment}`;

			try {
				await stat(testPath);
				if (endIndex === parts.length) {
					return testPath;
				}
				const result = await findPath(endIndex, testPath);
				if (result) {
					return result;
				}
			} catch {
				// Path doesn't exist, try shorter segment
			}
		}

		return null;
	}

	const result = await findPath(0, "");
	if (result) {
		return result;
	}

	return `/${parts.join("/")}`;
}

export function extractAgentIds(sessionContent: string): string[] {
	const agentIds = new Set<string>();

	for (const line of sessionContent.split("\n")) {
		if (!line.trim()) continue;

		try {
			const entry: unknown = JSON.parse(line);
			if (!isRecord(entry) || !isRecord(entry.toolUseResult)) continue;

			const agentId = entry.toolUseResult.agentId;
			if (isSafeBasename(agentId)) {
				agentIds.add(agentId);
			}
		} catch {
			// Skip malformed lines
		}
	}

	return Array.from(agentIds);
}

interface SubagentFile {
	agentId: string;
	content: string;
}

interface DiscoveredSubagentFiles {
	discovery: FileBackedUploadSubagentDiscovery;
	files: FileBackedUploadSubagent[];
}

async function scanUploadTranscript(path: string): Promise<{
	agentIds: string[];
	hasTimestamp: boolean;
}> {
	const state = await scanBoundedJsonlFile(
		path,
		() => ({ agentIds: new Set<string>(), hasTimestamp: false }),
		(line, scanState) => {
			if (!line) return true;
			let entry: unknown;
			try {
				entry = JSON.parse(line);
			} catch {
				return true;
			}
			if (!isRecord(entry)) return true;
			if (
				(entry.type === "user" || entry.type === "assistant") &&
				typeof entry.timestamp === "string" &&
				Number.isFinite(Date.parse(entry.timestamp))
			) {
				scanState.hasTimestamp = true;
			}
			if (!isRecord(entry.toolUseResult)) return true;
			const agentId = entry.toolUseResult.agentId;
			if (isSafeBasename(agentId)) scanState.agentIds.add(agentId);
			return true;
		},
	);
	return {
		agentIds: Array.from(state.agentIds),
		hasTimestamp: state.hasTimestamp,
	};
}

export async function readSubagentFiles(
	sessionDir: string,
	agentIds: string[],
	sessionId?: string,
): Promise<SubagentFile[]> {
	const subagents: SubagentFile[] = [];
	const subagentDirs = await resolveSubagentDirectories(sessionDir, sessionId);

	for (const agentId of agentIds) {
		if (!isSafeBasename(agentId)) continue;

		for (const subagentDir of subagentDirs) {
			let agentPath: string;
			try {
				agentPath = await realpath(join(subagentDir, `agent-${agentId}.jsonl`));
			} catch {
				continue;
			}
			if (!isContainedPath(subagentDir, agentPath)) continue;

			try {
				const content = await readFile(agentPath, "utf-8");
				subagents.push({ agentId, content });
				break;
			} catch {
				// Try next path
			}
		}
	}

	return subagents;
}

// ── Adapter ──

class ClaudeCodeAdapter implements AgentAdapter {
	private readonly sessionsBaseDir: string;
	private readonly hookConfigPath: string;
	constructor(environment: { homeDir?: string } = {}) {
		const homeDir = environment.homeDir ?? homedir();
		this.sessionsBaseDir = join(homeDir, ".claude", "projects");
		this.hookConfigPath = join(homeDir, ".claude", "settings.json");
	}
	name = "Claude Code";
	source = "claude_code" as const;

	getSessionsBaseDir(): string {
		return this.sessionsBaseDir;
	}

	async findProjectSessions(projectPath: string): Promise<SessionFile[]> {
		const encoded = encodeProjectPath(projectPath);
		const sessionDir = join(this.sessionsBaseDir, encoded);

		const files = await this.listSessionFiles(sessionDir, projectPath);
		if (files.length > 0) return files;

		return this.findByDecoding(projectPath);
	}

	async scanAllSessions(
		options: SessionScanOptions = {},
	): Promise<ScannedProject[]> {
		options.signal?.throwIfAborted();
		let projectDirs: string[];
		try {
			projectDirs = await readdir(this.sessionsBaseDir);
		} catch {
			return [];
		}

		const projects: ScannedProject[] = [];

		for (const dir of projectDirs) {
			options.signal?.throwIfAborted();
			const sessionDir = `${this.sessionsBaseDir}/${dir}`;
			let files: string[];
			try {
				files = await readdir(sessionDir);
			} catch {
				continue;
			}

			const sessionFiles = files.filter(
				(f) => f.endsWith(".jsonl") && !f.startsWith("agent-"),
			);

			if (sessionFiles.length === 0) continue;

			const decodedPath = await decodeProjectPath(dir);

			const sessions = await pMap(
				sessionFiles,
				async (file): Promise<SessionFile> => {
					options.signal?.throwIfAborted();
					const transcriptPath = join(sessionDir, file);
					const metadata = await readSessionDiscoveryMetadata(transcriptPath);
					const session: SessionFile = {
						sessionId: file.replace(/\.jsonl$/, ""),
						transcriptPath,
						projectPath:
							metadata.cwd && isAbsolute(metadata.cwd)
								? metadata.cwd
								: decodedPath,
						lastActivityAt: metadata.lastActivityAt,
						sessionDate: metadata.sessionDate,
					};
					options.signal?.throwIfAborted();
					await options.onSession?.(session);
					return session;
				},
				{ concurrency: 8 },
			);
			const byPath = new Map<string, SessionFile[]>();
			for (const session of sessions) {
				const grouped = byPath.get(session.projectPath) ?? [];
				grouped.push(session);
				byPath.set(session.projectPath, grouped);
			}
			for (const [projectPath, grouped] of byPath)
				projects.push({
					source: this.source,
					projectPath,
					displayPath: toDisplayPath(projectPath),
					sessions: grouped,
					sessionCount: grouped.length,
				});
		}

		return projects;
	}

	getHookConfigPath(options: HookOptions = {}): string {
		return options.projectPath
			? getClaudeProjectSettingsPath(options.projectPath)
			: this.hookConfigPath;
	}

	validateHook(options: HookOptions = {}): void {
		readClaudeSettings(this.getHookConfigPath(options));
	}

	installHook(options: HookOptions = {}): void {
		addHook(this.getHookConfigPath(options));
	}

	removeHook(options: HookOptions = {}): void {
		removeHook(this.getHookConfigPath(options));
	}

	isHookInstalled(options: HookOptions = {}): boolean {
		return isHookEnabled(this.getHookConfigPath(options));
	}

	async buildUploadRequest(
		session: SessionFile,
		context: UploadContext,
	): Promise<FileBackedUploadRequest> {
		const scan = await scanUploadTranscript(session.transcriptPath);
		if (!scan.hasTimestamp) {
			throw new MissingTranscriptTimestampError(this.source);
		}

		const sessionDir = dirname(session.transcriptPath);
		const discovered = await discoverClaudeSubagentFiles(
			sessionDir,
			session.sessionId,
			scan.agentIds,
		);

		return {
			kind: "file",
			metadata: {
				source: this.source,
				sessionId: session.sessionId,
				projectPath: session.projectPath,
				gitRemote: context.gitInfo.gitRemote,
				packageName: context.gitInfo.packageName,
				packageType: context.gitInfo.packageType,
				gitBranch: context.gitInfo.branch,
				gitSha: context.gitInfo.sha,
				tag: context.tag,
				organizationId: context.organizationId,
				upload_mode: context.uploadMode,
			},
			subagentDiscovery: discovered.discovery,
			subagents: discovered.files,
			transcriptPath: session.transcriptPath,
		};
	}

	extractTimestamps(content: string): SessionTimestamps | null {
		let min: string | null = null;
		let max: string | null = null;
		let minTime = Number.POSITIVE_INFINITY;
		let maxTime = Number.NEGATIVE_INFINITY;

		for (const line of content.split("\n")) {
			if (!line) continue;
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				continue;
			}
			if (!isRecord(parsed)) continue;
			if (parsed.type !== "user" && parsed.type !== "assistant") continue;
			if (typeof parsed.timestamp !== "string") continue;
			const timestampTime = Date.parse(parsed.timestamp);
			if (!Number.isFinite(timestampTime)) continue;

			const timestamp = new Date(timestampTime).toISOString();
			if (timestampTime < minTime) {
				min = timestamp;
				minTime = timestampTime;
			}
			if (timestampTime > maxTime) {
				max = timestamp;
				maxTime = timestampTime;
			}
		}

		if (!min || !max) return null;

		return { sessionDate: min, lastInteractionDate: max };
	}

	private async listSessionFiles(
		sessionDir: string,
		projectPath: string,
	): Promise<SessionFile[]> {
		try {
			const entries = await readdir(sessionDir);
			return entries
				.filter((f) => f.endsWith(".jsonl") && !f.startsWith("agent-"))
				.map((f) => ({
					sessionId: f.replace(/\.jsonl$/, ""),
					transcriptPath: join(sessionDir, f),
					projectPath,
				}));
		} catch {
			return [];
		}
	}

	private async findByDecoding(projectPath: string): Promise<SessionFile[]> {
		let projectDirs: string[];
		try {
			projectDirs = await readdir(this.sessionsBaseDir);
		} catch {
			return [];
		}

		for (const dir of projectDirs) {
			try {
				const decoded = await decodeProjectPath(dir);
				if (decoded === projectPath) {
					const sessionDir = join(this.sessionsBaseDir, dir);
					return this.listSessionFiles(sessionDir, projectPath);
				}
			} catch {
				// skip undecodable dirs
			}
		}

		return [];
	}
}

export async function discoverClaudeSubagentFiles(
	sessionDir: string,
	sessionId: string,
	referencedAgentIds: readonly string[] = [],
): Promise<DiscoveredSubagentFiles> {
	const resolvedDirectories = await resolveSubagentDirectoriesWithCoverage(
		sessionDir,
		sessionId,
	);
	const directories = resolvedDirectories.directories;
	const referenced = [
		...new Set(referencedAgentIds.filter((agentId) => isSafeBasename(agentId))),
	];
	const candidateAgentIds = new Set(referenced);
	const candidatePaths = new Map<string, string>();
	const reasons = new Set<string>();
	let omittedCount = 0;
	let omissionCountKnown = !resolvedDirectories.unavailable;
	if (resolvedDirectories.unavailable) {
		reasons.add("A subagent directory could not be enumerated");
	}
	for (const directory of directories) {
		let handle: Awaited<ReturnType<typeof opendir>>;
		try {
			handle = await opendir(directory);
		} catch {
			reasons.add("A subagent directory could not be enumerated");
			omissionCountKnown = false;
			continue;
		}
		let entryCount = 0;
		for await (const entry of handle) {
			entryCount += 1;
			if (entryCount > MAX_SUBAGENT_DIRECTORY_ENTRIES) {
				reasons.add("Subagent directory entry limit reached");
				omissionCountKnown = false;
				break;
			}
			const match = SUBAGENT_FILENAME_PATTERN.exec(entry.name);
			if (!match?.[1]) continue;
			candidateAgentIds.add(match[1]);
			if (!candidatePaths.has(match[1])) {
				candidatePaths.set(match[1], join(directory, entry.name));
			}
		}
	}

	const files: FileBackedUploadSubagent[] = [];
	let inspectedBytes = 0;
	let inspectedFileCount = 0;
	const unreferenced = [...candidateAgentIds]
		.filter((agentId) => !referenced.includes(agentId))
		.sort();
	for (const agentId of [...referenced, ...unreferenced]) {
		if (inspectedFileCount >= INGEST_MAX_SUBAGENT_COUNT) {
			omittedCount += 1;
			reasons.add("Subagent count limit reached");
			continue;
		}
		inspectedFileCount += 1;
		const path =
			candidatePaths.get(agentId) ??
			(await findSubagentPath(directories, agentId));
		if (!path) {
			omittedCount += 1;
			reasons.add("A referenced subagent file was unavailable");
			continue;
		}
		let canonicalPath: string;
		let fileBytes: number;
		try {
			const pathMetadata = await lstat(path);
			if (pathMetadata.isSymbolicLink()) {
				throw new Error("Subagent path cannot be a symbolic link");
			}
			canonicalPath = await realpath(path);
			if (
				!directories.some((directory) =>
					isContainedPath(directory, canonicalPath),
				)
			) {
				throw new Error("Subagent path escaped its session directory");
			}
			const metadata = await stat(canonicalPath);
			if (!metadata.isFile()) throw new Error("Subagent path is not a file");
			fileBytes = metadata.size;
		} catch {
			omittedCount += 1;
			reasons.add("A subagent file could not be safely resolved");
			continue;
		}
		// Raw bytes bound the read; the ingest limit applies after slimming.
		if (
			fileBytes > MAX_RAW_TRANSCRIPT_BYTES ||
			inspectedBytes + fileBytes > MAX_RAW_TRANSCRIPT_BYTES
		) {
			omittedCount += 1;
			reasons.add("Subagent byte limit reached");
			continue;
		}
		inspectedBytes += fileBytes;
		if (
			!(await hasMatchingClaudeSubagentIdentity(
				canonicalPath,
				agentId,
				sessionId,
			))
		) {
			omittedCount += 1;
			reasons.add("A subagent filename did not match its native identity");
			continue;
		}
		files.push({ agentId, path: canonicalPath });
	}

	const reason = reasons.size > 0 ? [...reasons].sort().join("; ") : null;
	return {
		discovery: {
			omittedCount: omissionCountKnown ? omittedCount : null,
			reason,
			status: reason === null ? "complete" : "partial",
		},
		files,
	};
}

async function findSubagentPath(
	directories: readonly string[],
	agentId: string,
): Promise<string | null> {
	for (const directory of directories) {
		const candidatePath = join(directory, `agent-${agentId}.jsonl`);
		try {
			await stat(candidatePath);
			return candidatePath;
		} catch {
			// Try the next supported Claude subagent layout.
		}
	}
	return null;
}

async function hasMatchingClaudeSubagentIdentity(
	path: string,
	agentId: string,
	sessionId: string,
): Promise<boolean> {
	const identity = await scanBoundedJsonlFile(
		path,
		() => ({ conflict: false, matched: false }),
		(line, state) => {
			if (!line) return true;
			let record: unknown;
			try {
				record = JSON.parse(line);
			} catch {
				return true;
			}
			if (!isRecord(record)) return true;
			if (
				("agentId" in record && record.agentId !== agentId) ||
				("sessionId" in record && record.sessionId !== sessionId)
			) {
				state.conflict = true;
			}
			if (record.agentId === agentId && record.sessionId === sessionId) {
				state.matched = true;
			}
			return true;
		},
	);
	return identity.matched && !identity.conflict;
}

export const claudeCodeAdapter = new ClaudeCodeAdapter();

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isSafeBasename(value: unknown): value is string {
	return typeof value === "string" && SAFE_BASENAME_PATTERN.test(value);
}

async function resolveSubagentDirectories(
	sessionDir: string,
	sessionId: string | undefined,
): Promise<string[]> {
	return (await resolveSubagentDirectoriesWithCoverage(sessionDir, sessionId))
		.directories;
}

async function resolveSubagentDirectoriesWithCoverage(
	sessionDir: string,
	sessionId: string | undefined,
): Promise<{ directories: string[]; unavailable: boolean }> {
	let canonicalSessionDir: string;
	try {
		canonicalSessionDir = await realpath(sessionDir);
	} catch {
		return { directories: [], unavailable: true };
	}

	const directories = [canonicalSessionDir];
	if (!isSafeBasename(sessionId)) {
		return { directories, unavailable: false };
	}

	try {
		const nestedDir = await realpath(
			join(canonicalSessionDir, sessionId, "subagents"),
		);
		if (isContainedPath(canonicalSessionDir, nestedDir)) {
			directories.push(nestedDir);
		}
	} catch (error) {
		if (!isMissingPath(error)) {
			return { directories, unavailable: true };
		}
	}

	return { directories, unavailable: false };
}

function isMissingPath(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isContainedPath(parentPath: string, candidatePath: string): boolean {
	const pathFromParent = relative(parentPath, candidatePath);
	return (
		pathFromParent !== "" &&
		pathFromParent !== ".." &&
		!pathFromParent.startsWith(`..${sep}`) &&
		!isAbsolute(pathFromParent)
	);
}

export function createClaudeCodeAdapter(
	environment: { homeDir?: string } = {},
): AgentAdapter {
	return new ClaudeCodeAdapter(environment);
}
