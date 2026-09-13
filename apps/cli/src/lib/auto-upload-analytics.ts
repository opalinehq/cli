import type { Source } from "../contracts/index.js";
import type { ProductAnalyticsRepositoryCounts } from "../contracts/product-analytics.js";
import {
	CliProductAnalyticsEvents,
	captureCliProductAnalyticsEvent,
	getBaseCliEventPayload,
	getCliDistinctId,
	normalizeFailureReason,
	shouldDisableCliPersonProfile,
} from "./product-analytics.js";

interface RepositoryAnalyticsProject {
	readonly repositoryKey: string;
	readonly organizationId: string | undefined;
	readonly source: Source;
	readonly sessionIds: readonly string[];
}

interface AutoUploadRepositorySummary extends ProductAnalyticsRepositoryCounts {
	readonly organization_id: string | undefined;
	readonly agent_source: Source;
}

export type AutoUploadHookResult =
	| {
			readonly source: Source;
			readonly status: "enabled";
			readonly alreadyInstalled: boolean;
	  }
	| {
			readonly source: Source;
			readonly status: "failed";
			readonly error: unknown;
	  };

export function captureAutoUploadSetupResult(options: {
	readonly result: AutoUploadHookResult;
	readonly summaries: readonly AutoUploadRepositorySummary[];
	readonly userId: string | undefined;
	readonly command: "enable" | "upload";
}): void {
	for (const summary of options.summaries) {
		if (summary.agent_source !== options.result.source) continue;
		const common = {
			distinctId: getCliDistinctId(options.userId),
			surface: "cli" as const,
			disablePersonProfile: shouldDisableCliPersonProfile(options.userId),
		};
		const payload = {
			...summary,
			user_id: options.userId,
			setup_command: options.command,
			...getBaseCliEventPayload(),
		};
		if (options.result.status === "enabled") {
			captureCliProductAnalyticsEvent({
				...common,
				event: CliProductAnalyticsEvents.AUTO_UPLOAD_ENABLED,
				payload: {
					...payload,
					is_already_enabled: options.result.alreadyInstalled,
				},
			});
		} else {
			captureCliProductAnalyticsEvent({
				...common,
				event: CliProductAnalyticsEvents.AUTO_UPLOAD_ENABLE_FAILED,
				payload: {
					...payload,
					failure_stage: "hook_install",
					failure_reason: normalizeFailureReason(options.result.error),
				},
			});
		}
	}
}

// Keys and session IDs stay local. Only aggregate counts leave this function.
export function summarizeAutoUploadRepositories(
	projects: readonly RepositoryAnalyticsProject[],
): AutoUploadRepositorySummary[] {
	const scopes = new Map<
		string | undefined,
		Map<Source, Map<string, Set<string>>>
	>();
	for (const project of projects) {
		const sources =
			scopes.get(project.organizationId) ??
			new Map<Source, Map<string, Set<string>>>();
		scopes.set(project.organizationId, sources);
		const repositories =
			sources.get(project.source) ?? new Map<string, Set<string>>();
		sources.set(project.source, repositories);
		const sessions =
			repositories.get(project.repositoryKey) ?? new Set<string>();
		repositories.set(project.repositoryKey, sessions);
		for (const sessionId of project.sessionIds) sessions.add(sessionId);
	}

	const summaries: AutoUploadRepositorySummary[] = [];
	for (const [organizationId, sources] of scopes) {
		for (const [source, repositories] of sources) {
			const counts = Array.from(
				repositories.values(),
				(sessions) => sessions.size,
			).sort((a, b) => b - a);
			summaries.push({
				organization_id: organizationId,
				agent_source: source,
				repository_count: counts.length,
				session_count: counts.reduce((sum, count) => sum + count, 0),
				repository_session_counts: counts,
			});
		}
	}
	return summaries;
}
