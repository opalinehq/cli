import type { IngestSessionInput, Source } from "../../contracts/index.js";

export interface SessionFile {
	sessionId: string;
	transcriptPath: string;
	projectPath: string;
	gitBranch?: string;
	gitSha?: string;
	gitRemote?: string;
	lastActivityAt?: number;
}

export interface ScannedProject {
	source: Source;
	projectPath: string;
	displayPath: string;
	sessions: SessionFile[];
	sessionCount: number;
}

export interface GitInfo {
	gitRemote?: string;
	packageName?: string;
	packageType?: string;
	branch?: string;
	sha?: string;
}

export interface UploadContext {
	tag?: IngestSessionInput["tag"];
	organizationId?: string;
	gitInfo: GitInfo;
	uploadMode: IngestSessionInput["upload_mode"];
}

export interface FileBackedUploadSubagent {
	agentId: string;
	path: string;
}

export interface FileBackedUploadRequest {
	kind: "file";
	metadata: Omit<IngestSessionInput, "content" | "subagents">;
	subagents: FileBackedUploadSubagent[];
	transcriptPath: string;
}

export interface SessionTimestamps {
	sessionDate: string;
	lastInteractionDate: string;
}

export interface SessionScanOptions {
	signal?: AbortSignal;
	onSession?: (session: SessionFile) => void | Promise<void>;
}
export interface HookOptions {
	global?: boolean;
	projectPath?: string;
}

export interface AgentAdapter {
	name: string;
	source: Source;

	// Session Discovery (CLI)
	getSessionsBaseDir(): string;
	findProjectSessions(projectPath: string): Promise<SessionFile[]>;
	scanAllSessions(options?: SessionScanOptions): Promise<ScannedProject[]>;

	// Hook Management (CLI)
	getHookConfigPath(options?: HookOptions): string;
	validateHook(options?: HookOptions): void;
	installHook(options?: HookOptions): void;
	removeHook(options?: HookOptions): void;
	isHookInstalled(options?: HookOptions): boolean;

	// Upload Request Building (CLI)
	buildUploadRequest(
		session: SessionFile,
		context: UploadContext,
	): Promise<FileBackedUploadRequest>;

	extractTimestamps(content: string): SessionTimestamps | null;
}
