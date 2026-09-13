import { describe, expect, test } from "bun:test";
import {
	PRODUCT_ANALYTICS_EVENTS,
	parseProductAnalyticsEvent,
} from "../contracts/product-analytics.js";
import { summarizeAutoUploadRepositories } from "../lib/auto-upload-analytics.js";

describe("automatic-upload repository analytics", () => {
	test("folds worktrees into repositories and counts each local session once", () => {
		const summaries = summarizeAutoUploadRepositories([
			{
				repositoryKey: "private/repo-a",
				organizationId: "org-a",
				source: "claude_code",
				sessionIds: ["session-a", "session-b"],
			},
			{
				repositoryKey: "private/repo-a",
				organizationId: "org-a",
				source: "claude_code",
				sessionIds: ["session-b", "session-c"],
			},
			{
				repositoryKey: "private/repo-b",
				organizationId: "org-a",
				source: "claude_code",
				sessionIds: ["session-d"],
			},
		]);

		expect(summaries).toEqual([
			{
				organization_id: "org-a",
				agent_source: "claude_code",
				repository_count: 2,
				session_count: 4,
				repository_session_counts: [3, 1],
			},
		]);
		expect(JSON.stringify(summaries)).not.toContain("private/");
		expect(JSON.stringify(summaries)).not.toContain("session-a");
	});

	test("keeps counts scoped to the event's organization and agent", () => {
		const summaries = summarizeAutoUploadRepositories([
			{
				repositoryKey: "repo",
				organizationId: "org-a",
				source: "claude_code",
				sessionIds: ["one", "two"],
			},
			{
				repositoryKey: "repo",
				organizationId: "org-a",
				source: "codex",
				sessionIds: ["one"],
			},
			{
				repositoryKey: "repo",
				organizationId: "org-b",
				source: "claude_code",
				sessionIds: ["one", "two", "three"],
			},
		]);

		expect(summaries).toEqual([
			{
				organization_id: "org-a",
				agent_source: "claude_code",
				repository_count: 1,
				session_count: 2,
				repository_session_counts: [2],
			},
			{
				organization_id: "org-a",
				agent_source: "codex",
				repository_count: 1,
				session_count: 1,
				repository_session_counts: [1],
			},
			{
				organization_id: "org-b",
				agent_source: "claude_code",
				repository_count: 1,
				session_count: 3,
				repository_session_counts: [3],
			},
		]);
	});

	test("distinguishes an empty repository from no repositories selected", () => {
		expect(summarizeAutoUploadRepositories([])).toEqual([]);
		expect(
			summarizeAutoUploadRepositories([
				{
					repositoryKey: "empty",
					organizationId: undefined,
					source: "codex",
					sessionIds: [],
				},
			]),
		).toEqual([
			{
				organization_id: undefined,
				agent_source: "codex",
				repository_count: 1,
				session_count: 0,
				repository_session_counts: [0],
			},
		]);
	});

	test("accepts count properties on existing events and rejects identifying extras", () => {
		const payload = {
			event_version: 1,
			surface: "cli",
			environment: "production",
			cli_version: "0.5.3",
			platform_os: "macos",
			agent_source: "codex",
			setup_command: "upload",
			repository_count: 2,
			session_count: 5,
			repository_session_counts: [3, 2],
		};
		expect(
			parseProductAnalyticsEvent(
				PRODUCT_ANALYTICS_EVENTS.AUTO_UPLOAD_ENABLED,
				payload,
			),
		).toEqual(payload);
		const failure = {
			...payload,
			failure_stage: "hook_install",
			failure_reason: "unknown",
		};
		expect(
			parseProductAnalyticsEvent(
				PRODUCT_ANALYTICS_EVENTS.AUTO_UPLOAD_ENABLE_FAILED,
				failure,
			),
		).toEqual(failure);
		expect(() =>
			parseProductAnalyticsEvent(PRODUCT_ANALYTICS_EVENTS.AUTO_UPLOAD_ENABLED, {
				...payload,
				repository_names: ["private/repo"],
			}),
		).toThrow();
		expect(() =>
			parseProductAnalyticsEvent(PRODUCT_ANALYTICS_EVENTS.AUTO_UPLOAD_ENABLED, {
				...payload,
				repository_session_counts: [-1],
			}),
		).toThrow();
	});
});
