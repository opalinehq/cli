import type { Logger } from "@logtape/logtape";
import { type AnalysisMarker, findAnalysisMarker } from "./analysis-markers.js";
import {
	type AnalysisUploadTarget,
	uploadMarkedConversation,
} from "./analysis-upload.js";
import { getApiBaseOverride } from "./api-target.js";
import { getCodexHomeDir } from "./codex-thread-family.js";
import { loadCredentials } from "./credentials.js";
import {
	HOOK_R2_STATUS_MAX_POLLS,
	reconcilePendingUploadsInHook,
} from "./hook-upload-failure.js";
import { allowsInsecureEndpointFromEnv } from "./upload-endpoint.js";

/**
 * Find a live analysis marker for the hook's session. Marker lookup failures
 * never stop the regular hook path.
 */
export async function findHookAnalysisMarker(
	logger: Logger,
	source: AnalysisMarker["source"],
	sessionId: string,
): Promise<AnalysisMarker | null> {
	try {
		return await findAnalysisMarker(source, sessionId);
	} catch (error) {
		logger.warn("Could not read analysis markers: {error}", {
			error: error instanceof Error ? error.message : String(error),
		});
		return null;
	}
}

/**
 * Upload a chat marked by `opaline import --analysis` after the agent's turn
 * ended, so the final answer is included. Runs instead of the regular hook
 * upload: it bypasses the auto-upload setting (the user asked for this chat),
 * sends no organization and captures no repository evidence.
 */
export async function runMarkedAnalysisHook(
	logger: Logger,
	marker: AnalysisMarker,
	hookTarget: AnalysisUploadTarget | undefined,
): Promise<void> {
	const credentials = loadCredentials();
	if (!credentials) {
		process.stderr.write(
			`Opaline analysis upload skipped for session ${marker.sessionId}: not authenticated; run \`opaline login\`.\n`,
		);
		return;
	}
	const environment = {
		allowInsecureEndpoint: allowsInsecureEndpointFromEnv(),
		credentials,
		endpoint: `${getApiBaseOverride() ?? credentials.apiBaseUrl}/rpc`,
	};
	const [outcomes] = await Promise.all([
		uploadMarkedConversation(marker, environment, {
			codexHome: getCodexHomeDir(),
			hookTarget,
			statusMaxPolls: HOOK_R2_STATUS_MAX_POLLS,
		}),
		reconcilePendingUploadsInHook(logger, {
			allowInsecureEndpoint: environment.allowInsecureEndpoint,
			authType: credentials.authType,
			endpoint: environment.endpoint,
			token: credentials.token,
		}),
	]);
	for (const outcome of outcomes) {
		if (outcome.status !== "failed") {
			logger.info("Analysis upload {status} for session {sessionId}", {
				sessionId: outcome.target.sessionId,
				status: outcome.status,
			});
			continue;
		}
		logger.error("Analysis upload failed for session {sessionId}: {error}", {
			error: outcome.error,
			sessionId: outcome.target.sessionId,
		});
		process.stderr.write(
			`Opaline analysis upload failed for session ${outcome.target.sessionId}: ${outcome.error}\n`,
		);
	}
}
