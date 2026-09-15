import { homedir } from "node:os";
import { basename, join } from "node:path";
import pMap from "p-map";
import { scanBoundedJsonlFile } from "../../bounded-jsonl-scan.js";
import { MissingTranscriptTimestampError } from "../../errors.js";
import type {
	AgentAdapter,
	FileBackedUploadRequest,
	ScannedProject,
	SessionFile,
	SessionScanOptions,
	SessionTimestamps,
	UploadContext,
} from "../../types.js";
import {
	readJsonlFirstLine,
	readSessionDiscoveryMetadata,
	toDisplayPath,
	walkJsonlFiles,
} from "../../utils.js";
import { installHook, isHookInstalled, removeHook } from "./config.js";

const SESSIONS_BASE_DIR = join(homedir(), ".codex", "sessions");

async function transcriptHasTimestamp(path: string): Promise<boolean> {
	const state = await scanBoundedJsonlFile(
		path,
		() => ({ hasTimestamp: false }),
		(line, scanState) => {
			if (!line) return true;
			let entry: unknown;
			try {
				entry = JSON.parse(line);
			} catch {
				return true;
			}
			scanState.hasTimestamp =
				isRecord(entry) &&
				typeof entry.timestamp === "string" &&
				Number.isFinite(Date.parse(entry.timestamp));
			return !scanState.hasTimestamp;
		},
	);
	return state.hasTimestamp;
}

// ── Exported utilities ──

export interface CodexSessionMeta {
	id: string;
	cwd: string;
	gitBranch?: string;
	gitSha?: string;
	gitRemote?: string;
}

export async function readCodexSessionMeta(
	filePath: string,
): Promise<CodexSessionMeta | null> {
	const parsed = await readJsonlFirstLine(filePath);
	if (
		!isRecord(parsed) ||
		parsed.type !== "session_meta" ||
		!isRecord(parsed.payload)
	)
		return null;
	const payload = parsed.payload;
	const git = isRecord(payload.git) ? payload.git : {};
	return {
		id:
			typeof payload.id === "string"
				? payload.id
				: basename(filePath, ".jsonl"),
		cwd: typeof payload.cwd === "string" ? payload.cwd : "",
		gitBranch: typeof git.branch === "string" ? git.branch : undefined,
		gitSha:
			typeof git.commit_hash === "string"
				? git.commit_hash
				: typeof git.sha === "string"
					? git.sha
					: undefined,
		gitRemote:
			typeof git.repository_url === "string" ? git.repository_url : undefined,
	};
}

export async function findActiveRolloutFile(
	threadId: string,
): Promise<string | null> {
	const files = await walkJsonlFiles(SESSIONS_BASE_DIR);

	for (const filePath of files) {
		if (!basename(filePath).includes(threadId)) continue;
		const meta = await readCodexSessionMeta(filePath);
		if (meta?.id === threadId) {
			return filePath;
		}
	}

	return null;
}

// ── Adapter ──

class CodexAdapter implements AgentAdapter {
	private readonly sessionsBaseDir: string;
	private readonly hookConfigPath: string;
	constructor(environment: { homeDir?: string } = {}) {
		const homeDir = environment.homeDir ?? homedir();
		this.sessionsBaseDir = join(homeDir, ".codex", "sessions");
		this.hookConfigPath = join(homeDir, ".codex", "config.toml");
	}
	name = "OpenAI Codex";
	source = "codex" as const;

	getSessionsBaseDir(): string {
		return this.sessionsBaseDir;
	}

	async findProjectSessions(projectPath: string): Promise<SessionFile[]> {
		const sessions: SessionFile[] = [];

		try {
			const files = await walkJsonlFiles(this.sessionsBaseDir);
			for (const filePath of files) {
				const meta = await readCodexSessionMeta(filePath);
				if (meta?.cwd === projectPath) {
					sessions.push({
						sessionId: meta.id,
						transcriptPath: filePath,
						projectPath,
						gitBranch: meta.gitBranch,
						gitSha: meta.gitSha,
					});
				}
			}
		} catch {
			// sessions dir doesn't exist
		}

		return sessions;
	}

	async scanAllSessions(
		options: SessionScanOptions = {},
	): Promise<ScannedProject[]> {
		options.signal?.throwIfAborted();
		const files = await walkJsonlFiles(this.sessionsBaseDir);
		const projectMap = new Map<string, SessionFile[]>();

		const scanned = await pMap(
			files,
			async (filePath): Promise<SessionFile | null> => {
				options.signal?.throwIfAborted();
				const [meta, metadata] = await Promise.all([
					readCodexSessionMeta(filePath),
					readSessionDiscoveryMetadata(filePath),
				]);
				if (!meta?.cwd) return null;
				const session: SessionFile = {
					sessionId: meta.id,
					transcriptPath: filePath,
					projectPath: meta.cwd,
					gitBranch: meta.gitBranch,
					gitSha: meta.gitSha,
					gitRemote: meta.gitRemote,
					lastActivityAt: metadata.lastActivityAt,
				};
				options.signal?.throwIfAborted();
				await options.onSession?.(session);
				return session;
			},
			{ concurrency: 8 },
		);
		for (const session of scanned) {
			if (!session) continue;
			const sessions = projectMap.get(session.projectPath) ?? [];
			sessions.push(session);
			projectMap.set(session.projectPath, sessions);
		}

		const projects: ScannedProject[] = [];
		for (const [projectPath, sessions] of projectMap) {
			projects.push({
				source: this.source,
				projectPath,
				displayPath: toDisplayPath(projectPath),
				sessions,
				sessionCount: sessions.length,
			});
		}

		return projects.sort((a, b) => a.displayPath.localeCompare(b.displayPath));
	}

	getHookConfigPath(): string {
		return this.hookConfigPath;
	}

	installHook(): void {
		installHook(this.hookConfigPath);
	}

	removeHook(): void {
		removeHook(this.hookConfigPath);
	}

	isHookInstalled(): boolean {
		return isHookInstalled(this.hookConfigPath);
	}

	async buildUploadRequest(
		session: SessionFile,
		context: UploadContext,
	): Promise<FileBackedUploadRequest> {
		if (!(await transcriptHasTimestamp(session.transcriptPath))) {
			throw new MissingTranscriptTimestampError(this.source);
		}

		return {
			kind: "file",
			metadata: {
				source: this.source,
				sessionId: session.sessionId,
				projectPath: session.projectPath,
				gitRemote: context.gitInfo.gitRemote,
				packageName: context.gitInfo.packageName,
				packageType: context.gitInfo.packageType,
				gitBranch: session.gitBranch ?? context.gitInfo.branch,
				gitSha: session.gitSha ?? context.gitInfo.sha,
				tag: context.tag,
				organizationId: context.organizationId,
				upload_mode: context.uploadMode,
			},
			subagents: [],
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
			if (!isRecord(parsed) || typeof parsed.timestamp !== "string") continue;
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
}

export const codexAdapter = new CodexAdapter();

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export function createCodexAdapter(
	environment: { homeDir?: string } = {},
): AgentAdapter {
	return new CodexAdapter(environment);
}
