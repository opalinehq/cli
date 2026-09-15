export {
	claudeCodeAdapter,
	createClaudeCodeAdapter,
	decodeProjectPath,
	extractAgentIds,
	readSubagentFiles,
} from "./adapters/claude-code/index.js";
export {
	codexAdapter,
	createCodexAdapter,
	findActiveRolloutFile,
	readCodexSessionMeta,
} from "./adapters/codex/index.js";
export {
	getMissingTranscriptTimestampMessage,
	isMissingTranscriptTimestampMessage,
	MissingTranscriptTimestampError,
} from "./errors.js";
export {
	getAdapter,
	getAllAdapters,
	getAvailableAdapters,
	registerAdapter,
} from "./registry.js";
export type {
	AgentAdapter,
	FileBackedUploadRequest,
	FileBackedUploadSubagent,
	GitInfo,
	HookOptions,
	ScannedProject,
	SessionFile,
	SessionScanOptions,
	SessionTimestamps,
	UploadContext,
} from "./types.js";
export {
	readFileWithRetry,
	toDisplayPath,
	walkJsonlFiles,
} from "./utils.js";

// Auto-register adapters
import { claudeCodeAdapter } from "./adapters/claude-code/index.js";
import { codexAdapter } from "./adapters/codex/index.js";
import { registerAdapter } from "./registry.js";

registerAdapter(claudeCodeAdapter);
registerAdapter(codexAdapter);
