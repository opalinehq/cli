import * as p from "@clack/prompts";
import { buildCommand } from "@stricli/core";
import type { Source } from "../contracts/index.js";
import {
	type AgentAdapter,
	getAvailableAdapters,
} from "../internal/agent-adapters/index.js";
import { describeSavedCredentialsApiBaseRisk } from "../lib/api-base.js";
import { createApiClient } from "../lib/api-client.js";
import { PRODUCTION_API_BASE } from "../lib/api-target.js";
import { verifyAuth } from "../lib/auth.js";
import {
	type AutoUploadHookResult,
	captureAutoUploadSetupResult,
	summarizeAutoUploadRepositories,
} from "../lib/auto-upload-analytics.js";
import { enableAutoUploadRepository } from "../lib/auto-upload-config.js";
import type { BatchUploadItem } from "../lib/batch-upload.js";
import { renderBatchSummary, runBatchUpload } from "../lib/batch-upload-ui.js";
import { getGitInfo } from "../lib/git-info.js";
import {
	CliProductAnalyticsEvents,
	captureCliProductAnalyticsEvent,
	getBaseCliEventPayload,
	getCliDistinctId,
	normalizeFailureReason,
	shouldDisableCliPersonProfile,
} from "../lib/product-analytics.js";
import { getProjectOrgId, setProjectOrgId } from "../lib/project-config.js";
import {
	getLegacyRepositoryKey,
	resolveUploadRepositoryIdentity,
} from "../lib/repository-discovery.js";
import { allowsInsecureEndpointFromEnv } from "../lib/upload-endpoint.js";
import { uploadSession } from "../lib/uploader.js";

async function runEnable(): Promise<undefined | Error> {
	p.intro("opaline enable");

	const captureEnableFailure = (options: {
		agentSource?: Source | "unknown";
		failureStage:
			| "auth_verify"
			| "organization_fetch"
			| "organization_select"
			| "hook_install";
		error: unknown;
		organizationId?: string;
		userId?: string;
	}) => {
		captureCliProductAnalyticsEvent({
			distinctId: getCliDistinctId(options.userId),
			event: CliProductAnalyticsEvents.AUTO_UPLOAD_ENABLE_FAILED,
			surface: "cli",
			disablePersonProfile: shouldDisableCliPersonProfile(options.userId),
			payload: {
				setup_command: "enable",
				agent_source: options.agentSource ?? "unknown",
				failure_stage: options.failureStage,
				failure_reason: normalizeFailureReason(options.error),
				organization_id: options.organizationId,
				user_id: options.userId,
				...getBaseCliEventPayload(),
			},
		});
	};

	// Before verifyAuth, which sends the stored token to the stored base.
	const storedApiBaseRisk = describeSavedCredentialsApiBaseRisk();
	if (storedApiBaseRisk) {
		p.log.warn(storedApiBaseRisk);
	}

	// Verify auth (loads credentials + pings API)
	const auth = await verifyAuth();
	if (!auth.authenticated) {
		captureEnableFailure({
			failureStage: "auth_verify",
			error: auth.reason,
		});
		p.outro("Run `opaline login` to authenticate.");
		return new Error(auth.message);
	}

	const { credentials } = auth;

	// Fetch user's organizations
	let orgs: { id: string; name: string; slug: string }[];
	if (credentials.authType === "api-key") {
		orgs = credentials.organizations ?? [];
	} else {
		const client = createApiClient(credentials);
		try {
			orgs = await client.listMyOrganizations();
		} catch (error) {
			captureEnableFailure({
				agentSource: "unknown",
				failureStage: "organization_fetch",
				error,
				userId: auth.user.id,
			});
			return new Error("Failed to fetch organizations. Check your connection.");
		}
	}

	if (orgs.length === 0) {
		captureEnableFailure({
			agentSource: "unknown",
			failureStage: "organization_fetch",
			error: new Error("No organizations found"),
			userId: auth.user.id,
		});
		p.outro(`Create one at ${PRODUCTION_API_BASE} first.`);
		return new Error("No organizations found.");
	}

	// Check if already configured for this project
	const cwd = process.cwd();
	const existingOrgId = await getProjectOrgId(cwd);
	const existingOrg = existingOrgId
		? orgs.find((o) => o.id === existingOrgId)
		: undefined;

	let selectedOrgId: string;

	const [firstOrg] = orgs;
	if (orgs.length === 1 && firstOrg) {
		selectedOrgId = firstOrg.id;
		p.log.info(`Using organization: ${firstOrg.name}`);
	} else if (existingOrg) {
		p.log.info(`Currently configured for: ${existingOrg.name}`);
		selectedOrgId = existingOrg.id;
	} else {
		const selected = await p.select({
			message: "Select an organization for this repository",
			options: orgs.map((org) => ({
				value: org.id,
				label: org.name,
				hint: org.slug,
			})),
		});

		if (p.isCancel(selected)) {
			p.cancel("Setup cancelled.");
			return;
		}

		selectedOrgId = selected;
		const selectedOrg = orgs.find((o) => o.id === selected);
		if (selectedOrg) {
			p.log.success(`Selected: ${selectedOrg.name}`);
		}
	}

	await setProjectOrgId(cwd, selectedOrgId);

	// Detect available agents and install hooks
	const adapters = getAvailableAdapters();
	let adaptersToEnable: AgentAdapter[];
	let hookInstallFailures = 0;
	const hookResults = new Map<Source, AutoUploadHookResult>();

	if (adapters.length > 1) {
		const agentOptions = adapters.map((a) => ({
			value: a,
			label: a.name,
			hint: a.isHookInstalled() ? "already enabled" : undefined,
		}));
		const selectedAdapters = await p.multiselect({
			message: "Select agents to enable auto-upload for",
			options: agentOptions,
			initialValues: adapters,
			required: true,
		});

		if (p.isCancel(selectedAdapters)) {
			p.cancel("Setup cancelled.");
			return;
		}
		adaptersToEnable = selectedAdapters;
	} else {
		adaptersToEnable = adapters;
	}
	const gitInfo = await getGitInfo(cwd);
	const repository = resolveUploadRepositoryIdentity(cwd, gitInfo);
	enableAutoUploadRepository({
		key: repository.repoKey,
		legacyKeys: [getLegacyRepositoryKey(cwd, gitInfo)],
		label: repository.repoLabel,
		sources: adaptersToEnable.map((adapter) => adapter.source),
	});

	for (const adapter of adaptersToEnable) {
		const isAlreadyEnabled = adapter.isHookInstalled();

		try {
			adapter.installHook();
			p.log.success(
				isAlreadyEnabled
					? `${adapter.name}: Auto-upload hook updated. Organization updated.`
					: `${adapter.name}: Auto-upload hook enabled in ${adapter.getHookConfigPath()}`,
			);
		} catch (error) {
			hookInstallFailures++;
			hookResults.set(adapter.source, {
				source: adapter.source,
				status: "failed",
				error,
			});
			p.log.error(
				`${adapter.name}: failed to enable auto-upload hook (${error instanceof Error ? error.message : String(error)})`,
			);
			continue;
		}

		hookResults.set(adapter.source, {
			source: adapter.source,
			status: "enabled",
			alreadyInstalled: isAlreadyEnabled,
		});
	}

	// Check for existing sessions to upload from all enabled agents
	const endpoint = `${credentials.apiBaseUrl}/rpc`;
	const allowPlaintextEndpoint = allowsInsecureEndpointFromEnv();
	let totalFailed = 0;

	const discovered = await Promise.all(
		adaptersToEnable.map(async (adapter) => ({
			adapter,
			sessions: await adapter.findProjectSessions(cwd),
		})),
	);
	for (const { adapter, sessions } of discovered) {
		const result = hookResults.get(adapter.source);
		if (result) {
			captureAutoUploadSetupResult({
				result,
				summaries: summarizeAutoUploadRepositories([
					{
						repositoryKey: repository.repoKey,
						organizationId: selectedOrgId,
						source: adapter.source,
						sessionIds: sessions.map((session) => session.sessionId),
					},
				]),
				userId: auth.user.id,
				command: "enable",
			});
		}
	}

	for (const { adapter, sessions } of discovered) {
		if (sessions.length === 0) continue;

		const shouldUpload = await p.confirm({
			message: `Found ${sessions.length} previous ${adapter.name} session(s). Upload them now?`,
			initialValue: false,
		});

		if (p.isCancel(shouldUpload) || !shouldUpload) continue;

		const items: BatchUploadItem[] = sessions.map((session) => ({
			sessionId: session.sessionId,
			label: session.sessionId,
			transcriptPath: session.transcriptPath,
			projectPath: session.projectPath,
			source: adapter.source,
			organizationId: selectedOrgId,
		}));

		const summary = await runBatchUpload({
			items,
			label: `Uploading ${adapter.name} sessions...`,
			upload: async (item, onRetry) => {
				const session = sessions.find((s) => s.sessionId === item.sessionId);
				if (!session) {
					return { success: false, error: "Session not found" };
				}
				const request = await adapter.buildUploadRequest(session, {
					gitInfo,
					organizationId: selectedOrgId,
					uploadMode: "manual",
				});
				return uploadSession(request, {
					endpoint,
					token: credentials.token,
					allowInsecureEndpoint: allowPlaintextEndpoint,
					authType: credentials.authType,
					onRetry,
				});
			},
		});

		renderBatchSummary(summary, { context: adapter.name });
		totalFailed += summary.failed;
	}

	if (totalFailed > 0) {
		p.log.info("Run `opaline upload --retry` to retry failed uploads.");
	}

	p.outro("Done!");

	if (totalFailed > 0 || hookInstallFailures > 0) {
		return new Error(
			`Enable completed with ${hookInstallFailures} hook installation failure(s) and ${totalFailed} upload failure(s).`,
		);
	}
}

export const enableCommand = buildCommand({
	loader: async () => ({ default: runEnable }),
	parameters: {},
	docs: {
		brief: "Enable automatic session upload for coding agents",
	},
});
