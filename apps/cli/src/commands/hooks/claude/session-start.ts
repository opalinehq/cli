import { stat } from "node:fs/promises";
import { getLogger } from "@logtape/logtape";
import { buildCommand } from "@stricli/core";
import type { IngestSessionInput } from "../../../contracts/index.js";
import {
	claudeCodeAdapter,
	type FileBackedUploadRequest,
} from "../../../internal/agent-adapters/index.js";
import { isRepositoryAutoUploadAllowed } from "../../../lib/auto-upload-config.js";
import { loadCredentials } from "../../../lib/credentials.js";
import { getGitInfo } from "../../../lib/git-info.js";
import { getProjectOrgId } from "../../../lib/project-config.js";
import {
	getLegacyRepositoryKey,
	resolveUploadRepositoryIdentity,
} from "../../../lib/repository-discovery.js";
import { readRepositoryEvidencePauseUntil } from "../../../lib/repository-evidence-pause.js";
import { captureAndUploadSessionEvidence } from "../../../lib/session-evidence.js";
import { disposeLogging, setupHookLogging } from "../../../logging.js";

interface SessionStartInput {
	readonly cwd: string;
	readonly session_id: string;
	readonly transcript_path: string;
}

async function readStdin(): Promise<string> {
	const chunks: string[] = [];
	for await (const chunk of process.stdin) {
		chunks.push(typeof chunk === "string" ? chunk : chunk.toString());
	}
	return chunks.join("");
}

async function runSessionStart(): Promise<undefined> {
	await setupHookLogging();
	const logger = getLogger(["opaline", "cli", "hook"]);
	try {
		const raw = await readStdin();
		if (!raw.trim()) return;
		const input: unknown = JSON.parse(raw);
		if (!isSessionStartInput(input)) return;
		if (readRepositoryEvidencePauseUntil() !== undefined) return;
		const hookReceivedAt = new Date().toISOString();
		const gitInfo = await getGitInfo(input.cwd);
		const repository = resolveUploadRepositoryIdentity(input.cwd, gitInfo);
		if (
			!isRepositoryAutoUploadAllowed(
				repository.repoKey,
				claudeCodeAdapter.source,
				[getLegacyRepositoryKey(input.cwd, gitInfo)],
			)
		) {
			return;
		}
		const credentials = loadCredentials();
		if (!credentials?.user) return;
		const organizationId = await getProjectOrgId(input.cwd);
		if (!organizationId) {
			logger.info(
				"Skipping start context for session {sessionId}: repository has no approved workspace binding",
				{ sessionId: input.session_id },
			);
			return;
		}
		let transcriptExists = true;
		try {
			await stat(input.transcript_path);
		} catch (error) {
			if (!isMissingPath(error)) throw error;
			transcriptExists = false;
		}
		const metadata: FileBackedUploadRequest["metadata"] = {
			organizationId,
			projectPath: input.cwd,
			sessionId: input.session_id,
			source: "claude_code",
			upload_mode: "hook",
		};
		const request: IngestSessionInput | FileBackedUploadRequest =
			transcriptExists
				? {
						kind: "file",
						metadata,
						subagentDiscovery: {
							omittedCount: null,
							reason: "SessionStart did not discover child transcripts",
							status: "unavailable",
						},
						subagents: [],
						transcriptPath: input.transcript_path,
					}
				: { ...metadata, content: "" };
		const receipt = await captureAndUploadSessionEvidence({
			credentials,
			hookReceivedAt,
			lifecycle: "start",
			onWarning: (warning) => logger.warn("{warning}", { warning }),
			organizationId,
			request,
			terminalTranscript: false,
			backgroundDelivery: "spawn",
		});
		if (!receipt) return;
		logger.info(
			"Start context accepted for session {sessionId} ({contextId})",
			{ contextId: receipt.contextId, sessionId: input.session_id },
		);
	} catch (error) {
		logger.warn("Claude start context capture deferred: {error}", {
			error: error instanceof Error ? error.message : String(error),
		});
	} finally {
		await disposeLogging();
	}
}

function isSessionStartInput(value: unknown): value is SessionStartInput {
	return (
		typeof value === "object" &&
		value !== null &&
		"cwd" in value &&
		typeof value.cwd === "string" &&
		"session_id" in value &&
		typeof value.session_id === "string" &&
		"transcript_path" in value &&
		typeof value.transcript_path === "string"
	);
}

function isMissingPath(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export const sessionStartCommand = buildCommand({
	loader: async () => ({ default: runSessionStart }),
	parameters: {},
	docs: { brief: "Handle Claude Code SessionStart hook" },
});
