import { getLogger } from "@logtape/logtape";
import { buildCommand } from "@stricli/core";
import {
	claudeCodeAdapter,
	type SessionFile,
} from "../../../internal/agent-adapters/index.js";
import { getApiBaseOverride } from "../../../lib/api-target.js";
import { isRepositoryAutoUploadAllowed } from "../../../lib/auto-upload-config.js";
import { loadCredentials } from "../../../lib/credentials.js";
import { removeFailedUpload } from "../../../lib/failed-uploads.js";
import { getGitInfo } from "../../../lib/git-info.js";
import { reportHookUploadFailure } from "../../../lib/hook-upload-failure.js";
import { getProjectOrgId } from "../../../lib/project-config.js";
import {
	getLegacyRepositoryKey,
	resolveUploadRepositoryIdentity,
} from "../../../lib/repository-discovery.js";
import { allowsInsecureEndpointFromEnv } from "../../../lib/upload-endpoint.js";
import {
	formatRedactionSummary,
	uploadSession,
} from "../../../lib/uploader.js";
import { disposeLogging, setupHookLogging } from "../../../logging.js";

interface HookInput {
	session_id: string;
	transcript_path: string;
	cwd: string;
}

async function readStdin(): Promise<string> {
	const chunks: string[] = [];
	for await (const chunk of process.stdin) {
		chunks.push(typeof chunk === "string" ? chunk : chunk.toString());
	}
	return chunks.join("");
}

async function runSessionEnd(): Promise<undefined | Error> {
	await setupHookLogging();
	const logger = getLogger(["opaline", "cli", "hook"]);

	try {
		const raw = await readStdin();
		if (!raw.trim()) return;

		const input = JSON.parse(raw) as HookInput;
		if (!input.session_id || !input.transcript_path) return;
		const gitInfo = await getGitInfo(input.cwd);
		const repository = resolveUploadRepositoryIdentity(input.cwd, gitInfo);
		if (
			!isRepositoryAutoUploadAllowed(
				repository.repoKey,
				claudeCodeAdapter.source,
				[getLegacyRepositoryKey(input.cwd, gitInfo)],
			)
		) {
			logger.info(
				"Skipping session {sessionId}: automatic upload is disabled for {repository}",
				{
					repository: repository.repoLabel,
					sessionId: input.session_id,
				},
			);
			return;
		}

		const credentials = loadCredentials();
		if (!credentials) {
			process.stderr.write(
				`Opaline hook upload skipped for session ${input.session_id}: not authenticated; run \`opaline login\`.\n`,
			);
			return;
		}

		logger.info("Uploading session {sessionId}", {
			sessionId: input.session_id,
		});

		const sessionFile: SessionFile = {
			sessionId: input.session_id,
			transcriptPath: input.transcript_path,
			projectPath: input.cwd,
		};

		const organizationId = await getProjectOrgId(input.cwd);

		const request = await claudeCodeAdapter.buildUploadRequest(sessionFile, {
			gitInfo,
			organizationId,
			uploadMode: "hook",
		});

		const apiBase = getApiBaseOverride() ?? credentials.apiBaseUrl;
		const endpoint = `${apiBase}/rpc`;
		const result = await uploadSession(request, {
			endpoint,
			token: credentials.token,
			allowInsecureEndpoint: allowsInsecureEndpointFromEnv(),
			authType: credentials.authType,
			onRetry: (attempt, maxAttempts, error) => {
				logger.warn(
					"Retrying upload for {sessionId} ({attempt}/{maxAttempts}): {error}",
					{ sessionId: input.session_id, attempt, maxAttempts, error },
				);
			},
		});

		if (result.success) {
			logger.info(
				"Upload successful for session {sessionId} (attempts: {attempts})",
				{ sessionId: input.session_id, attempts: result.attempts },
			);
			const redactionSummary = formatRedactionSummary(
				result.redacted,
				result.redactedBytes,
			);
			if (redactionSummary) {
				logger.info("{redactionSummary}", { redactionSummary });
			}
			await removeFailedUpload(input.session_id);
		} else {
			const hookError = await reportHookUploadFailure(logger, result, {
				sessionId: input.session_id,
				transcriptPath: input.transcript_path,
				projectPath: input.cwd,
				source: claudeCodeAdapter.source,
				organizationId,
			});
			return hookError;
		}
	} catch (error) {
		logger.error("Session end hook failed: {error}", { error });
		process.stderr.write(
			`Opaline Claude Code hook failed: ${error instanceof Error ? error.message : String(error)}\n`,
		);
	} finally {
		await disposeLogging();
	}
}

export const sessionEndCommand = buildCommand({
	loader: async () => ({ default: runSessionEnd }),
	parameters: {},
	docs: {
		brief: "Handle Claude Code SessionEnd hook",
	},
});
