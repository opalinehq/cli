import { stat } from "node:fs/promises";
import { ORPCError } from "@orpc/client";
import { parseSafeApiEndpoint, type Source } from "../contracts/index.js";
import {
	getAdapter,
	MissingTranscriptTimestampError,
} from "../internal/agent-adapters/index.js";
import {
	type AnalysisMarker,
	removeAnalysisMarker,
	type TranscriptFingerprint,
	updateAnalysisMarker,
} from "./analysis-markers.js";
import { createRpcClient } from "./api-client.js";
import { orderBySizeAscending } from "./batch-upload.js";
import {
	type CodexThread,
	resolveCodexThreadFamily,
} from "./codex-thread-family.js";
import type { Credentials } from "./credentials.js";
import {
	recordFailedUpload,
	recordPendingUpload,
	removeFailedUpload,
} from "./failed-uploads.js";
import { getGitInfo } from "./git-info.js";
import {
	forgetAnalysisUploadCapability,
	hasCachedAnalysisUploadCapability,
	rememberAnalysisUploadCapability,
} from "./r2-upload-capability.js";
import { resolveSession } from "./session-resolver.js";
import type { UploadResult } from "./types.js";
import {
	ANALYSIS_UPLOAD_UNSUPPORTED_MESSAGE,
	uploadSession,
} from "./uploader.js";

/**
 * Upload the chat in which an Opaline analysis ran, linked to that analysis.
 * Used by `opaline import --analysis` and by the agent hooks for marked chats.
 * These uploads are explicit: they bypass the per-repository auto-upload
 * setting, carry no organization (the analysis decides the workspace) and
 * never capture repository evidence.
 */

export interface AnalysisUploadEnvironment {
	readonly allowInsecureEndpoint: boolean;
	readonly credentials: Pick<Credentials, "authType" | "token">;
	/** RPC endpoint, e.g. `https://opaline.so/rpc`. */
	readonly endpoint: string;
}

export interface AnalysisUploadTarget {
	readonly sessionId: string;
	readonly source: Source;
	readonly transcriptPath: string;
	readonly projectPath: string;
	/** `marked` is the id given to the command; others are related threads. */
	readonly relation: "marked" | "parent" | "child";
	readonly gitBranch: string | undefined;
	readonly gitSha: string | undefined;
}

export interface AnalysisTargetOutcome {
	readonly target: AnalysisUploadTarget;
	readonly status: "uploaded" | "pending" | "unchanged" | "failed";
	readonly error: string | undefined;
	readonly fingerprint: TranscriptFingerprint | undefined;
	/** The server cannot link uploads to this analysis; stop and drop the marker. */
	readonly linkFailure: "unsupported" | "rejected" | undefined;
}

export type AnalysisSupport =
	| { readonly supported: true }
	| { readonly supported: false; readonly reason: string };

export async function checkAnalysisUploadSupport(
	environment: AnalysisUploadEnvironment,
): Promise<AnalysisSupport> {
	const endpoint = parseSafeApiEndpoint(environment.endpoint, {
		allowPlaintext: environment.allowInsecureEndpoint,
	});
	if (!endpoint.ok)
		return { supported: false, reason: "The upload endpoint was refused." };
	const url = new URL(endpoint.url);
	const authType = environment.credentials.authType ?? "bearer";
	const { token } = environment.credentials;
	if (hasCachedAnalysisUploadCapability(url, authType, token))
		return { supported: true };
	try {
		const status = await createRpcClient({
			authType,
			rpcUrl: endpoint.url,
			token,
		}).cli.authStatus(undefined, { signal: AbortSignal.timeout(15_000) });
		if (status.capabilities?.analysisLinkedUploads !== true)
			return { supported: false, reason: ANALYSIS_UPLOAD_UNSUPPORTED_MESSAGE };
	} catch (error) {
		if (
			error instanceof ORPCError &&
			(error.status === 401 || error.status === 403)
		)
			return {
				supported: false,
				reason: "Not authenticated. Run `opaline login` first.",
			};
		if (error instanceof ORPCError && error.status === 404)
			return { supported: false, reason: ANALYSIS_UPLOAD_UNSUPPORTED_MESSAGE };
		const detail = error instanceof Error ? error.message : String(error);
		return {
			supported: false,
			reason: `Could not reach Opaline to check analysis upload support: ${detail}`,
		};
	}
	await rememberAnalysisUploadCapability(url, authType, token);
	return { supported: true };
}

/**
 * Resolve what to upload for a session or thread id (or transcript path).
 * Codex threads bring their parent chain and spawned subagent threads when
 * `related` is set; Claude Code sessions already include their subagents.
 */
export async function resolveAnalysisTargets(
	input: string,
	options: { readonly codexHome: string; readonly related: boolean },
): Promise<{
	readonly source: Source;
	readonly sessionId: string;
	readonly targets: readonly AnalysisUploadTarget[];
}> {
	const looksLikePath = input.includes("/") || input.endsWith(".jsonl");
	if (!looksLikePath) {
		const family = await resolveCodexThreadFamily(input, {
			codexHome: options.codexHome,
		});
		if (family) {
			const related = options.related
				? [
						...family.ancestors.map((thread) => toTarget(thread, "parent")),
						...family.descendants.map((thread) => toTarget(thread, "child")),
					]
				: [];
			return {
				source: "codex",
				sessionId: family.self.threadId,
				targets: [toTarget(family.self, "marked"), ...related],
			};
		}
	}
	const session = await resolveSession(input);
	if (session.source === "codex" && options.related && looksLikePath) {
		return resolveAnalysisTargets(session.sessionId, options);
	}
	return {
		source: session.source,
		sessionId: session.sessionId,
		targets: [
			{
				sessionId: session.sessionId,
				source: session.source,
				transcriptPath: session.transcriptPath,
				projectPath: session.projectPath,
				relation: "marked",
				gitBranch: session.gitBranch,
				gitSha: session.gitSha,
			},
		],
	};
}

/**
 * Upload targets smallest first, linked to `analysisId`. Targets whose
 * transcript has not changed since the last linked upload are skipped. Stops
 * as soon as the server shows it cannot link this analysis.
 */
export async function uploadAnalysisTargets(
	targets: readonly AnalysisUploadTarget[],
	analysisId: string,
	environment: AnalysisUploadEnvironment,
	options: {
		readonly uploadMode: "hook" | "manual";
		readonly statusMaxPolls: number | undefined;
		readonly previous: Readonly<Record<string, TranscriptFingerprint>>;
	},
): Promise<AnalysisTargetOutcome[]> {
	const outcomes: AnalysisTargetOutcome[] = [];
	for (const target of await orderBySizeAscending(targets)) {
		const fingerprint = await readFingerprint(target.transcriptPath);
		const previous = options.previous[target.sessionId];
		if (
			fingerprint &&
			previous &&
			previous.size === fingerprint.size &&
			previous.mtimeMs === fingerprint.mtimeMs
		) {
			outcomes.push({
				target,
				status: "unchanged",
				error: undefined,
				fingerprint,
				linkFailure: undefined,
			});
			continue;
		}
		const result = await uploadTarget(target, analysisId, environment, options);
		const outcome = await recordOutcome(
			target,
			analysisId,
			result,
			fingerprint,
		);
		outcomes.push(outcome);
		if (outcome.linkFailure) break;
	}
	return outcomes;
}

/**
 * Hook entry point for a marked chat: upload the marked conversation (with
 * related threads re-resolved, so newly spawned subagents are included) and
 * remember what was uploaded. Returns the error lines to surface, if any.
 */
export async function uploadMarkedConversation(
	marker: AnalysisMarker,
	environment: AnalysisUploadEnvironment,
	options: {
		readonly codexHome: string;
		readonly statusMaxPolls: number | undefined;
		/** Claude Code: the hook's own transcript for the marked session. */
		readonly hookTarget: AnalysisUploadTarget | undefined;
	},
): Promise<readonly AnalysisTargetOutcome[]> {
	const targets = options.hookTarget
		? [options.hookTarget]
		: (
				await resolveAnalysisTargets(marker.sessionId, {
					codexHome: options.codexHome,
					related: true,
				}).catch(() => ({ targets: [] }))
			).targets;
	const outcomes = await uploadAnalysisTargets(
		targets,
		marker.analysisId,
		environment,
		{
			previous: marker.uploaded,
			statusMaxPolls: options.statusMaxPolls,
			uploadMode: "hook",
		},
	);
	await settleMarker(marker, targets, outcomes, environment);
	return outcomes;
}

/** Persist upload fingerprints, or drop the marker when linking cannot work. */
export async function settleMarker(
	marker: Pick<AnalysisMarker, "sessionId" | "source">,
	targets: readonly AnalysisUploadTarget[],
	outcomes: readonly AnalysisTargetOutcome[],
	environment: AnalysisUploadEnvironment,
): Promise<void> {
	const linkFailure = outcomes.find((outcome) => outcome.linkFailure);
	if (linkFailure) {
		await removeAnalysisMarker(marker);
		if (linkFailure.linkFailure === "unsupported") {
			const endpoint = parseSafeApiEndpoint(environment.endpoint, {
				allowPlaintext: environment.allowInsecureEndpoint,
			});
			if (endpoint.ok)
				await forgetAnalysisUploadCapability(
					new URL(endpoint.url),
					environment.credentials.authType ?? "bearer",
					environment.credentials.token,
				);
		}
		return;
	}
	const uploaded: Record<string, TranscriptFingerprint> = {};
	for (const outcome of outcomes) {
		if (
			outcome.fingerprint &&
			(outcome.status === "uploaded" || outcome.status === "pending")
		)
			uploaded[outcome.target.sessionId] = outcome.fingerprint;
	}
	await updateAnalysisMarker(marker, {
		memberIds: targets.map((target) => target.sessionId),
		uploaded,
	});
}

async function uploadTarget(
	target: AnalysisUploadTarget,
	analysisId: string,
	environment: AnalysisUploadEnvironment,
	options: {
		readonly uploadMode: "hook" | "manual";
		readonly statusMaxPolls: number | undefined;
	},
): Promise<UploadResult> {
	const gitInfo = await getGitInfo(target.projectPath);
	let request: Awaited<
		ReturnType<ReturnType<typeof getAdapter>["buildUploadRequest"]>
	>;
	try {
		request = await getAdapter(target.source).buildUploadRequest(
			{
				sessionId: target.sessionId,
				transcriptPath: target.transcriptPath,
				projectPath: target.projectPath,
				gitBranch: target.gitBranch,
				gitSha: target.gitSha,
			},
			{ gitInfo, organizationId: undefined, uploadMode: options.uploadMode },
		);
	} catch (error) {
		if (error instanceof MissingTranscriptTimestampError)
			return {
				success: false,
				error: error.message,
				attempts: 0,
				retryable: false,
			};
		throw error;
	}
	request.metadata.analysisId = analysisId;
	return uploadSession(request, {
		allowInsecureEndpoint: environment.allowInsecureEndpoint,
		authType: environment.credentials.authType,
		endpoint: environment.endpoint,
		r2StatusMaxPolls: options.statusMaxPolls,
		token: environment.credentials.token,
	});
}

async function recordOutcome(
	target: AnalysisUploadTarget,
	analysisId: string,
	result: UploadResult,
	fingerprint: TranscriptFingerprint | undefined,
): Promise<AnalysisTargetOutcome> {
	const entry = {
		sessionId: target.sessionId,
		transcriptPath: target.transcriptPath,
		projectPath: target.projectPath,
		source: target.source,
		analysisId,
	};
	if (result.success) {
		await removeFailedUpload(target.sessionId);
		return {
			target,
			status: "uploaded",
			error: undefined,
			fingerprint,
			linkFailure: undefined,
		};
	}
	if (result.pendingJobId !== undefined) {
		await recordPendingUpload({
			...entry,
			error: result.error ?? "Still processing on the server",
			jobId: result.pendingJobId,
		});
		return {
			target,
			status: "pending",
			error: undefined,
			fingerprint,
			linkFailure: undefined,
		};
	}
	const error = result.error ?? "Unknown error";
	const linkFailure = result.analysisLinkMissing
		? "unsupported"
		: result.analysisRejected
			? "rejected"
			: undefined;
	// A refused link is not retried: a retry would fail the same way.
	if (!linkFailure)
		await recordFailedUpload({
			...entry,
			error,
			failureKind: result.failureKind,
			status: result.retryable === false ? "permanent" : "retryable",
		});
	return { target, status: "failed", error, fingerprint, linkFailure };
}

function toTarget(
	thread: CodexThread,
	relation: AnalysisUploadTarget["relation"],
): AnalysisUploadTarget {
	return {
		sessionId: thread.threadId,
		source: "codex",
		transcriptPath: thread.transcriptPath,
		projectPath: thread.cwd,
		relation,
		gitBranch: thread.gitBranch,
		gitSha: thread.gitSha,
	};
}

async function readFingerprint(
	path: string,
): Promise<TranscriptFingerprint | undefined> {
	try {
		const stats = await stat(path);
		return { mtimeMs: stats.mtimeMs, size: stats.size };
	} catch {
		return undefined;
	}
}
