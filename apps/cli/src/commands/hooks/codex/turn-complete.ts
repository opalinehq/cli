import { getLogger } from "@logtape/logtape";
import { buildCommand } from "@stricli/core";
import {
	codexAdapter,
	findActiveRolloutFile,
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

interface CodexNotifyInput {
	type: "agent-turn-complete";
	threadId: string;
	cwd: string;
}

function parseNotification(raw: string): CodexNotifyInput | null {
	const parsed: unknown = JSON.parse(raw);
	if (typeof parsed !== "object" || parsed === null) return null;
	if (!("type" in parsed) || parsed.type !== "agent-turn-complete") return null;
	if (!("thread-id" in parsed) || typeof parsed["thread-id"] !== "string") {
		return null;
	}
	if (!("cwd" in parsed) || typeof parsed.cwd !== "string") return null;
	return {
		type: parsed.type,
		threadId: parsed["thread-id"],
		cwd: parsed.cwd,
	};
}

async function runTurnComplete(
	_flags: Record<string, never>,
	notification: string,
): Promise<undefined | Error> {
	await setupHookLogging();
	const logger = getLogger(["opaline", "cli", "hook"]);

	try {
		if (!notification.trim()) return;

		const input = parseNotification(notification);
		if (!input) return;
		const gitInfo = await getGitInfo(input.cwd);
		const repository = resolveUploadRepositoryIdentity(input.cwd, gitInfo);
		if (
			!isRepositoryAutoUploadAllowed(repository.repoKey, codexAdapter.source, [
				getLegacyRepositoryKey(input.cwd, gitInfo),
			])
		) {
			logger.info(
				"Skipping session {sessionId}: automatic upload is disabled for {repository}",
				{
					repository: repository.repoLabel,
					sessionId: input.threadId,
				},
			);
			return;
		}

		const credentials = loadCredentials();
		if (!credentials) {
			process.stderr.write(
				`Opaline hook upload skipped for session ${input.threadId}: not authenticated; run \`opaline login\`.\n`,
			);
			return;
		}

		const transcriptPath = await findActiveRolloutFile(input.threadId);
		if (!transcriptPath) {
			process.stderr.write(
				`Opaline hook upload skipped for session ${input.threadId}: transcript file was not found.\n`,
			);
			return;
		}

		const sessionFile: SessionFile = {
			sessionId: input.threadId,
			transcriptPath,
			projectPath: input.cwd,
		};

		const organizationId = await getProjectOrgId(input.cwd);

		const request = await codexAdapter.buildUploadRequest(sessionFile, {
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
		});

		if (result.success) {
			const redactionSummary = formatRedactionSummary(
				result.redacted,
				result.redactedBytes,
			);
			if (redactionSummary) {
				logger.info("{redactionSummary}", { redactionSummary });
			}
			await removeFailedUpload(input.threadId);
		} else {
			const hookError = await reportHookUploadFailure(logger, result, {
				sessionId: input.threadId,
				transcriptPath,
				projectPath: input.cwd,
				source: codexAdapter.source,
				organizationId,
			});
			return hookError;
		}
	} catch (error) {
		logger.error("Codex turn-complete hook failed: {error}", { error });
		process.stderr.write(
			`Opaline Codex hook failed: ${error instanceof Error ? error.message : String(error)}\n`,
		);
	} finally {
		await disposeLogging();
	}
}

export const turnCompleteCommand = buildCommand({
	loader: async () => ({ default: runTurnComplete }),
	parameters: {
		flags: {},
		positional: {
			kind: "tuple",
			parameters: [
				{
					brief: "Codex notification JSON",
					parse: String,
					placeholder: "notification",
				},
			],
		},
	},
	docs: {
		brief: "Handle Codex agent-turn-complete hook",
	},
});
