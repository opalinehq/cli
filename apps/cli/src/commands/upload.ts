import * as p from "@clack/prompts";
import { buildCommand } from "@stricli/core";
import { sanitizeForTerminalDisplay } from "../contracts/index.js";
import type { AgentAdapter } from "../internal/agent-adapters/index.js";
import { describeSavedCredentialsApiBaseRisk } from "../lib/api-base.js";
import { createApiClient } from "../lib/api-client.js";
import { getApiBaseOverride, getDefaultApiBase } from "../lib/api-target.js";
import { verifyAuth } from "../lib/auth.js";
import { loadAutoUploadConfig } from "../lib/auto-upload-config.js";
import { cliMessage } from "../lib/cli-messages.js";
import { loadCredentials } from "../lib/credentials.js";
import type { GuidedUpload } from "../lib/guided-upload.js";
import { getProjectOrgId } from "../lib/project-config.js";
import {
	checkRepositoryUploads,
	uploadRepositorySessions,
} from "../lib/repository-session-upload.js";
import {
	type RepositoryChange,
	saveRepositoryChanges,
} from "../lib/repository-upload.js";
import { getUploadCompletion } from "../lib/upload-completion.js";
import { allowsInsecureEndpointFromEnv } from "../lib/upload-endpoint.js";
import {
	discoverUploadRepositories,
	getUploadAdapters,
	type UploadRepository,
} from "../lib/upload-manager-repositories.js";
import {
	getDesiredUploadState,
	getPendingRepositories,
	getRepositoriesToUpload,
	type UploadManagerState,
} from "../lib/upload-manager-state.js";
import {
	createUploadScreen,
	promptUploadManager,
	type UploadRepositoryScan,
} from "../lib/upload-manager-terminal.js";
import type { UploadConfig } from "../lib/uploader.js";
import { runLogin } from "./login.js";

export async function runUpload(
	guided?: GuidedUpload,
	env: { adapters?: AgentAdapter[]; cwd?: string } = {},
): Promise<undefined | Error> {
	if (!process.stdin.isTTY || !process.stdout.isTTY) {
		return new Error(
			"Open `opaline upload` in an interactive terminal to toggle repositories.",
		);
	}
	const screen = createUploadScreen();
	try {
		const adapters = env.adapters ?? getUploadAdapters();
		const repositories: UploadRepository[] = [];
		const state: UploadManagerState = {
			query: "",
			cursor: 0,
			selectionVisible: false,
			desired: new Map(),
			message: "",
			singleRun: Boolean(guided),
		};
		let scan: UploadRepositoryScan | undefined = async (
			onRepositories,
			signal,
		) => {
			const rows = await discoverUploadRepositories(
				(progress, discovered) => onRepositories(discovered, progress),
				{ signal, adapters, cwd: env.cwd },
			);
			const config = guided ? undefined : getManagerUploadConfig();
			if (config) {
				const updateHistory = () =>
					onRepositories(rows, {
						phase: "history",
						sessions: rows.reduce((sum, row) => sum + row.sessionCount, 0),
						repositories: rows.length,
					});
				updateHistory();
				try {
					await checkRepositoryUploads(rows, config, updateHistory, signal);
				} catch (error) {
					signal.throwIfAborted();
					state.message = `Upload history unavailable: ${error instanceof Error ? error.message : String(error)}`;
				}
			}
			return rows;
		};
		let operation: ((signal: AbortSignal) => Promise<void>) | undefined;
		let operationError: Error | undefined;
		let hasPreviousUploads: boolean | undefined;
		let uploadedThisRun = 0;
		let skippedBeforeRun: number | undefined;
		const uploadedWorkspaces = new Set<string | undefined>();
		while (
			(await promptUploadManager(
				repositories,
				state,
				scan,
				operation,
				screen,
			)) === "save"
		) {
			scan = undefined;
			operation = undefined;
			const selected = repositories.filter((repo) =>
				getDesiredUploadState(repo, state),
			);
			if (guided && !selected.length) {
				state.message = "Select at least one repository to continue setup.";
				continue;
			}
			const changes: RepositoryChange[] = getPendingRepositories(
				repositories,
				state,
			).map((repository) => ({
				repository,
				enabled: getDesiredUploadState(repository, state),
			}));
			const targets = guided
				? selected
				: getRepositoriesToUpload(repositories, state);
			// A newly enabled repository may use a different destination. Recheck
			// its history there even when every session exists in the old one.
			for (const change of changes)
				if (
					change.enabled &&
					change.repository.sessionCount > 0 &&
					!targets.includes(change.repository)
				)
					targets.push(change.repository);
			const destinations = [...changes];
			for (const repository of targets)
				if (!destinations.some((change) => change.repository === repository))
					destinations.push({ repository, enabled: true });
			try {
				const destination = guided
					? await resolveGuidedDestination(
							guided,
							repositories,
							state,
							destinations,
							screen.close,
						)
					: await resolveDestinations(destinations, screen.close);
				if (destination.cancelled) {
					state.message = "Save cancelled. Your changes are still pending.";
					continue;
				}
				for (const change of destinations)
					if (
						change.enabled &&
						(guided ||
							change.organizationId !== change.repository.organizationId) &&
						!changes.includes(change)
					)
						changes.push(change);
				const config = getManagerUploadConfig(guided);
				if (targets.length && !config)
					throw new Error("Sign in to upload existing sessions.");
				if (guided) hasPreviousUploads = guided.hasPreviousUploads;
				else if (targets.length && hasPreviousUploads === undefined) {
					const credentials = loadCredentials();
					if (!credentials)
						throw new Error("Sign in to upload existing sessions.");
					// Capture account-wide history before this run uploads anything.
					// Retrying a first upload must still continue onboarding afterward.
					const setup = await createApiClient(credentials).cli.setupStatus();
					hasPreviousUploads = setup.hasUploadedSessions === true;
				}
				state.stage = "upload";
				state.message = "";
				state.uploadFailed = false;
				state.uploadPage = 0;
				state.followUpload = true;
				state.completion = undefined;
				operation = async (signal) => {
					try {
						signal.throwIfAborted();
						if (changes.length)
							await saveRepositoryChanges(repositories, changes, adapters, {
								defaultOrganizationId: destination.defaultOrganizationId,
							});
						state.desired.clear();
						state.message = "";
						signal.throwIfAborted();
						if (targets.length && config) {
							await guided?.start();
							if (state.operation)
								state.operation.label = cliMessage("uploadProgress");
							const summary = await uploadRepositorySessions(
								targets.filter((repo) => repo.enabled),
								config,
								() => {},
								signal,
							);
							uploadedThisRun += summary.succeeded;
							skippedBeforeRun ??=
								targets.reduce((count, repo) => count + repo.sessionCount, 0) -
								summary.total;
							state.message =
								summary.failed + summary.skipped
									? [
											`${uploadedThisRun} uploaded`,
											summary.failed ? `${summary.failed} failed` : "",
											summary.skipped ? `${summary.skipped} skipped` : "",
										]
											.filter(Boolean)
											.join(" · ")
									: cliMessage("uploadSummary", { count: uploadedThisRun });
							state.uploadFailed = summary.failed + summary.skipped > 0;
							if (uploadedThisRun > 0 || !state.uploadFailed) {
								operationError = undefined;
								for (const repo of targets)
									uploadedWorkspaces.add(
										repo.uploadedOrganizationId ?? repo.organizationId,
									);
								const completion = getUploadCompletion(
									config.endpoint,
									hasPreviousUploads ?? false,
									destination.organizations.filter((org) =>
										uploadedWorkspaces.has(org.id),
									),
								);
								if (guided) {
									await guided.complete({
										uploaded: uploadedThisRun,
										skipped: skippedBeforeRun,
										failed: summary.failed + summary.skipped,
									});
									state.completion = guided.completionLink(completion);
								} else state.completion = completion;
								state.selectionVisible = false;
							} else {
								state.uploadFailed = true;
								state.uploadPage = 0;
								if (guided) {
									operationError = new Error(state.message);
								}
							}
						} else
							state.message = cliMessage("saveSummary", {
								changes: `${changes.length} change${changes.length === 1 ? "" : "s"}`,
							});
					} catch (error) {
						if (guided && !signal.aborted) {
							operationError =
								error instanceof Error ? error : new Error(String(error));
							await guided.close(operationError);
						}
						throw error;
					}
				};
			} catch (error) {
				if (guided) throw error;
				state.error = {
					message: error instanceof Error ? error.message : String(error),
					page: 0,
				};
			}
		}
		screen.close();
		if (operationError) return operationError;
		if (state.completion) {
			p.log.success(state.message);
			for (const url of state.completion.kind === "setup"
				? [state.completion.url]
				: state.completion.dashboards.map((dashboard) => dashboard.url))
				p.log.info(url);
			return;
		}
		p.outro(
			getPendingRepositories(repositories, state).length
				? cliMessage("discarded")
				: cliMessage("closed"),
		);
	} catch (error) {
		return error instanceof Error ? error : new Error(String(error));
	} finally {
		screen.close();
	}
}

function getManagerUploadConfig(
	guided?: GuidedUpload,
): UploadConfig | undefined {
	const credentials = guided?.credentials ?? loadCredentials();
	if (!credentials) return undefined;
	return {
		endpoint: `${guided?.apiBase ?? getApiBaseOverride() ?? credentials.apiBaseUrl}/rpc`,
		token: credentials.token,
		authType: credentials.authType,
		allowInsecureEndpoint:
			guided?.allowInsecureApiBase || allowsInsecureEndpointFromEnv(),
	};
}

async function resolveGuidedDestination(
	guided: GuidedUpload,
	repositories: UploadRepository[],
	state: UploadManagerState,
	changes: RepositoryChange[],
	showPrompt: () => void,
) {
	const approved = await guided.authorize(repositories, state, showPrompt);
	for (const change of changes)
		if (change.enabled) change.organizationId = approved.organizationId;
	return {
		cancelled: false,
		defaultOrganizationId: approved.organizationId,
		organizations: approved.organizations,
	};
}

async function resolveDestinations(
	changes: RepositoryChange[],
	showPrompt: () => void,
): Promise<
	| { cancelled: true }
	| {
			cancelled: false;
			defaultOrganizationId?: string;
			organizations: Array<{ id: string; slug: string }>;
	  }
> {
	const enabling = changes.filter((change) => change.enabled);
	if (enabling.length === 0) return { cancelled: false, organizations: [] };
	const risk = describeSavedCredentialsApiBaseRisk();
	if (risk) {
		showPrompt();
		p.log.warn(risk);
	}
	const apiBase = loadCredentials()?.apiBaseUrl ?? getDefaultApiBase();
	let auth = await verifyAuth();
	if (
		!auth.authenticated &&
		(auth.reason === "no_credentials" || auth.reason === "token_expired")
	) {
		showPrompt();
		const error = await runLogin({
			apiBase,
			allowInsecureApiBase: false,
			noBrowser: false,
		});
		if (error) throw error;
		auth = await verifyAuth();
	}
	if (!auth.authenticated) throw new Error(auth.message);
	const organizations =
		auth.credentials.authType === "api-key"
			? (auth.credentials.organizations ?? [])
			: await createApiClient(auth.credentials).listMyOrganizations();
	if (!organizations.length)
		throw new Error(
			"No upload destinations found. Create an organization in Opaline first.",
		);
	const config = loadAutoUploadConfig();
	let defaultOrganizationId = organizations.find(
		(org) => org.id === config?.defaultOrganizationId,
	)?.id;
	for (const change of enabling) {
		const path = change.repository.paths[0];
		const previous =
			change.repository.organizationId ??
			(path ? await getProjectOrgId(path) : undefined);
		let organizationId =
			organizations.find((org) => org.id === previous)?.id ??
			defaultOrganizationId;
		if (!organizationId && organizations.length === 1)
			organizationId = organizations[0]?.id;
		if (!organizationId) {
			showPrompt();
			const selected = await p.select({
				message: cliMessage("destination"),
				options: organizations.map((org) => ({
					value: org.id,
					label: sanitizeForTerminalDisplay(org.name),
				})),
			});
			if (p.isCancel(selected)) return { cancelled: true };
			organizationId = selected;
			defaultOrganizationId = selected;
		}
		change.organizationId = organizationId;
	}
	return { cancelled: false, defaultOrganizationId, organizations };
}

export const uploadCommand = buildCommand({
	loader: async () => ({ default: () => runUpload() }),
	parameters: {},
	docs: {
		brief: "Turn automatic session uploads on or off for each repository",
	},
});
