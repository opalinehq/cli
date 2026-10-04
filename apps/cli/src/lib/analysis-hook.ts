import type { Logger } from "@logtape/logtape";
import {
	type AnalysisMarker,
	findAnalysisMarkers,
	removeAnalysisMarker,
} from "./analysis-markers.js";
import {
	type AnalysisUploadTarget,
	checkAnalysisUploadSupport,
	getAnalysisDestination,
	isSameAnalysisDestination,
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
 * Find the live analysis markers for the hook's session, one per analysis.
 * Marker lookup failures never stop the regular hook path.
 */
export async function findHookAnalysisMarkers(
	logger: Logger,
	source: AnalysisMarker["source"],
	sessionId: string,
): Promise<AnalysisMarker[]> {
	try {
		return await findAnalysisMarkers(source, sessionId);
	} catch (error) {
		logger.warn("Could not read analysis markers: {error}", {
			error: error instanceof Error ? error.message : String(error),
		});
		return [];
	}
}

/**
 * Upload a chat marked by `opaline import --analysis` after the agent's turn
 * ended, so the final answer is included, once per analysis it belongs to.
 * Runs instead of the regular hook upload: it bypasses the auto-upload
 * setting (the user asked for this chat), sends no organization and captures
 * no repository evidence.
 *
 * Content only goes to the endpoint and account the import approved, after the
 * server confirms (now or from the positive cache) that it links analyses.
 * Returns `released` when no marker applies any more (each was removed), so
 * the caller continues with the regular hook path.
 */
export async function runMarkedAnalysisHook(
	logger: Logger,
	markers: readonly AnalysisMarker[],
	hookTarget: AnalysisUploadTarget | undefined,
): Promise<"handled" | "released"> {
	let result: "handled" | "released" = "released";
	for (const marker of markers) {
		if ((await runMarker(logger, marker, hookTarget)) === "handled")
			result = "handled";
	}
	return result;
}

async function runMarker(
	logger: Logger,
	marker: AnalysisMarker,
	hookTarget: AnalysisUploadTarget | undefined,
): Promise<"handled" | "released"> {
	const credentials = loadCredentials();
	if (!credentials) {
		process.stderr.write(
			`Opaline analysis upload skipped for session ${marker.sessionId}: not authenticated; run \`opaline login\`.\n`,
		);
		return "handled";
	}
	const environment = {
		allowInsecureEndpoint: allowsInsecureEndpointFromEnv(),
		credentials,
		endpoint: `${getApiBaseOverride() ?? credentials.apiBaseUrl}/rpc`,
	};
	if (
		!isSameAnalysisDestination(
			marker.destination,
			getAnalysisDestination(environment),
		)
	) {
		await removeAnalysisMarker(marker);
		process.stderr.write(
			`Opaline stopped linking session ${marker.sessionId} to analysis ${marker.analysisId}: the Opaline server or account changed since \`opaline import --analysis\`. Run that command again to link it.\n`,
		);
		return "released";
	}
	const support = await checkAnalysisUploadSupport(environment);
	if (!support.supported) {
		if (support.kind === "unavailable") {
			logger.warn(
				"Analysis upload for session {sessionId} deferred to the next turn: {reason}",
				{ reason: support.reason, sessionId: marker.sessionId },
			);
			return "handled";
		}
		await removeAnalysisMarker(marker);
		process.stderr.write(
			`Opaline stopped linking session ${marker.sessionId} to analysis ${marker.analysisId}: ${support.reason}\n`,
		);
		return support.kind === "unsupported" ? "released" : "handled";
	}
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
	return "handled";
}
