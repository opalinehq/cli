import {
	claudeCodeAdapter,
	codexAdapter,
} from "../internal/agent-adapters/index.js";
import {
	ANALYSIS_MARKER_TTL_MS,
	recordAnalysisMarker,
	removeAnalysisMarker,
} from "../lib/analysis-markers.js";
import {
	type AnalysisTargetOutcome,
	type AnalysisUploadEnvironment,
	type AnalysisUploadTarget,
	checkAnalysisUploadSupport,
	getAnalysisDestination,
	resolveAnalysisTargets,
	settleMarker,
	uploadAnalysisTargets,
} from "../lib/analysis-upload.js";
import { getCodexHomeDir } from "../lib/codex-thread-family.js";
import type { Credentials } from "../lib/credentials.js";

// The agent waits for this command before it answers; the authoritative
// upload happens in its hook afterwards, so keep server polling short.
const IMPORT_STATUS_MAX_POLLS = 15;

export interface AnalysisImportOptions {
	readonly analysisId: string;
	readonly dryRun: boolean;
	readonly json: boolean;
	readonly related: boolean;
	readonly session: string;
}

/**
 * `opaline import <thread-or-session> --analysis <id>`: mark the chat for the
 * analysis, upload what exists now, and let the agent hook re-upload after
 * each turn so the final answer and follow-ups are attached. One line of
 * output (or one JSON object); exit code 0 only when everything was accepted.
 */
export async function runAnalysisImport(
	options: AnalysisImportOptions,
	environment: Omit<AnalysisUploadEnvironment, "credentials"> & {
		readonly credentials: Credentials | null;
	},
): Promise<undefined | Error> {
	const resolved = await resolveAnalysisTargets(options.session, {
		codexHome: getCodexHomeDir(),
		related: options.related,
	}).catch((error: unknown) =>
		error instanceof Error ? error : new Error(String(error)),
	);
	if (resolved instanceof Error) return resolved;

	if (options.dryRun) {
		writeResult(
			options,
			{
				analysisId: options.analysisId,
				dryRun: true,
				sessions: resolved.targets.map((target) =>
					describe(target, "would-upload"),
				),
			},
			`Dry run: would link ${formatTargets(resolved.targets)} to analysis ${options.analysisId}.`,
		);
		return;
	}
	const { credentials } = environment;
	if (!credentials)
		return new Error("Not authenticated. Run `opaline login` first.");
	const uploadEnvironment: AnalysisUploadEnvironment = {
		...environment,
		credentials,
	};

	const support = await checkAnalysisUploadSupport(uploadEnvironment);
	if (!support.supported) {
		await removeAnalysisMarker({
			sessionId: resolved.sessionId,
			source: resolved.source,
		});
		return new Error(support.reason);
	}

	const marker = await recordAnalysisMarker({
		analysisId: options.analysisId,
		destination: getAnalysisDestination(uploadEnvironment),
		memberIds: resolved.targets.map((target) => target.sessionId),
		related: options.related,
		sessionId: resolved.sessionId,
		source: resolved.source,
	});
	const outcomes = await uploadAnalysisTargets(
		resolved.targets,
		options.analysisId,
		uploadEnvironment,
		{
			previous: {},
			statusMaxPolls: IMPORT_STATUS_MAX_POLLS,
			uploadMode: "manual",
		},
	);
	await settleMarker(marker, resolved.targets, outcomes, uploadEnvironment);

	const linkFailure = outcomes.find((outcome) => outcome.linkFailure);
	if (linkFailure)
		return new Error(linkFailure.error ?? "Analysis upload refused.");

	const failed = outcomes.filter((outcome) => outcome.status === "failed");
	const uploaded = outcomes.filter(
		(outcome) => outcome.status === "uploaded",
	).length;
	const pending = outcomes.filter(
		(outcome) => outcome.status === "pending",
	).length;
	const hookInstalled = isHookInstalled(resolved.source);
	const followUp = hookInstalled
		? `later turns re-upload until ${new Date(Date.now() + ANALYSIS_MARKER_TTL_MS).toISOString().slice(0, 10)}`
		: "agent hooks are off, so run this again after the answer to attach it";
	writeResult(
		options,
		{
			analysisId: options.analysisId,
			expiresAt: marker.expiresAt,
			hookInstalled,
			sessions: outcomes.map((outcome) =>
				describe(outcome.target, outcome.status, outcome.error),
			),
		},
		`Opaline: linked ${formatTargets(resolved.targets)} to analysis ${options.analysisId} (${uploaded} uploaded${pending ? `, ${pending} processing` : ""}${failed.length ? `, ${failed.length} failed` : ""}); ${followUp}.`,
	);
	if (failed.length > 0) {
		return new Error(
			failed
				.map((outcome) => `${outcome.target.sessionId}: ${outcome.error}`)
				.join("\n"),
		);
	}
}

function isHookInstalled(source: AnalysisUploadTarget["source"]): boolean {
	try {
		return source === "codex"
			? codexAdapter.isHookInstalled()
			: claudeCodeAdapter.isHookInstalled({ global: true });
	} catch {
		return false;
	}
}

function describe(
	target: AnalysisUploadTarget,
	status: AnalysisTargetOutcome["status"] | "would-upload",
	error?: string,
) {
	return {
		error,
		relation: target.relation,
		sessionId: target.sessionId,
		source: target.source,
		status,
		transcriptPath: target.transcriptPath,
	};
}

function formatTargets(targets: readonly AnalysisUploadTarget[]): string {
	const related = targets.length - 1;
	const kind = targets[0]?.source === "codex" ? "thread" : "session";
	return related > 0
		? `${kind} ${targets[0]?.sessionId} and ${related} related thread(s)`
		: `${kind} ${targets[0]?.sessionId}`;
}

function writeResult(
	options: AnalysisImportOptions,
	json: Record<string, unknown>,
	line: string,
): void {
	process.stdout.write(`${options.json ? JSON.stringify(json) : line}\n`);
}
