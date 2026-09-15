import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import pMap from "p-map";
import { scanBoundedJsonlFile } from "../../bounded-jsonl-scan.js";
import { MissingTranscriptTimestampError } from "../../errors.js";
import type {
	AgentAdapter,
	FileBackedUploadRequest,
	FileBackedUploadSubagent,
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
	removeHook,
} from "./settings.js";

const SAFE_BASENAME_PATTERN = /^[A-Za-z0-9_-]{1,200}$/;

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

async function resolveSubagentFilePaths(
	sessionDir: string,
	agentIds: string[],
	sessionId?: string,
): Promise<FileBackedUploadSubagent[]> {
	const subagents: FileBackedUploadSubagent[] = [];
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
			subagents.push({ agentId, path: agentPath });
			break;
		}
	}

	return subagents;
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
		const subagents =
			scan.agentIds.length > 0
				? await resolveSubagentFilePaths(
						sessionDir,
						scan.agentIds,
						session.sessionId,
					)
				: [];

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
			subagents,
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
	let canonicalSessionDir: string;
	try {
		canonicalSessionDir = await realpath(sessionDir);
	} catch {
		return [];
	}

	const directories = [canonicalSessionDir];
	if (!isSafeBasename(sessionId)) {
		return directories;
	}

	try {
		const nestedDir = await realpath(
			join(canonicalSessionDir, sessionId, "subagents"),
		);
		if (isContainedPath(canonicalSessionDir, nestedDir)) {
			directories.push(nestedDir);
		}
	} catch {
		// The nested subagent directory is optional.
	}

	return directories;
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
