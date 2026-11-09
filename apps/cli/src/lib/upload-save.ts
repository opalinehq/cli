import type { AgentAdapter } from "../internal/agent-adapters/index.js";
import { describeSavedCredentialsApiBaseRisk } from "./api-base.js";
import { createApiClient } from "./api-client.js";
import { getApiBaseOverride, getDefaultApiBase } from "./api-target.js";
import { verifyAuth } from "./auth.js";
import { loadAutoUploadConfig } from "./auto-upload-config.js";
import { cliMessage } from "./cli-messages.js";
import { loadCredentials } from "./credentials.js";
import type { GuidedUpload } from "./guided-upload.js";
import { getProjectOrgId } from "./project-config.js";
import {
	checkRepositoryUploads,
	uploadRepositorySessions,
} from "./repository-session-upload.js";
import { syncRepositorySettings } from "./repository-settings-sync.js";
import {
	type RepositoryChange,
	saveRepositoryChanges,
} from "./repository-upload.js";
import { startSessionInventoryInBackground } from "./session-inventory.js";
import { getUploadCompletion } from "./upload-completion.js";
import { allowsInsecureEndpointFromEnv } from "./upload-endpoint.js";
import {
	discoverUploadRepositories,
	type ScanProgress,
	type UploadRepository,
} from "./upload-manager-repositories.js";
import {
	getDesiredUploadState,
	getPendingRepositories,
	getRepositoriesToUpload,
	type UploadManagerState,
} from "./upload-manager-state.js";
import type { UploadConfig } from "./uploader.js";

export interface UploadRun {
	repositories: UploadRepository[];
	state: UploadManagerState;
	adapters: AgentAdapter[];
	guided?: GuidedUpload;
	hasPreviousUploads?: boolean;
	uploadedThisRun: number;
	skippedBeforeRun?: number;
	uploadedWorkspaces: Set<string | undefined>;
	operationError?: Error;
}

export type UploadDestination =
	| { cancelled: true }
	| {
			cancelled: false;
			defaultOrganizationId?: string;
			organizations: Array<{ id: string; slug: string }>;
	  };

export interface UploadSaveProgress {
	phase: "authorize" | "save" | "upload";
	completed?: number;
	total?: number;
}

export interface UploadSaveResult {
	uploaded: number;
	failed: number;
	skipped: number;
	changes: number;
}

export interface DestinationPrompts {
	warn(message: string): void;
	login(apiBase: string): Promise<void>;
	selectOrganization(
		organizations: Array<{ id: string; name: string }>,
	): Promise<string | undefined>;
}

export class UploadSaveError extends Error {
	constructor(
		readonly code: "not_signed_in" | "organization_required",
		message: string,
		readonly organizations?: Array<{ id: string; name: string }>,
	) {
		super(message);
	}
}

export async function scanUploadRepositories(
	state: Pick<UploadManagerState, "message">,
	onRepositories: (rows: UploadRepository[], progress?: ScanProgress) => void,
	signal: AbortSignal,
	options: { adapters: AgentAdapter[]; cwd?: string; guided?: GuidedUpload },
): Promise<UploadRepository[]> {
	const rows = await discoverUploadRepositories(
		(progress, discovered) => onRepositories(discovered, progress),
		{ signal, adapters: options.adapters, cwd: options.cwd },
	);
	const config = options.guided ? undefined : getManagerUploadConfig();
	if (config) {
		const settingsSync = syncRepositorySettings(rows, config, signal);
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
		} finally {
			const warning = await settingsSync;
			if (warning) state.message = `${state.message} ${warning}`.trim();
		}
	}
	return rows;
}

export async function prepareUploadSave(
	run: UploadRun,
	options: {
		showPrompt?: () => void;
		resolveDestinations: (
			destinations: RepositoryChange[],
		) => Promise<UploadDestination>;
		onProgress?: (progress: UploadSaveProgress) => void;
	},
): Promise<
	| { kind: "invalid"; message: string }
	| { kind: "cancelled" }
	| {
			kind: "ready";
			operation: (signal: AbortSignal) => Promise<UploadSaveResult>;
	  }
> {
	const { repositories, state, adapters, guided } = run;
	const selected = repositories.filter((repo) =>
		getDesiredUploadState(repo, state),
	);
	if (guided && !selected.length)
		return {
			kind: "invalid",
			message: "Select at least one repository to continue setup.",
		};
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
	if (guided || destinations.some((change) => change.enabled))
		options.onProgress?.({ phase: "authorize" });
	const destination = guided
		? await resolveGuidedDestination(
				guided,
				repositories,
				state,
				destinations,
				options.showPrompt,
			)
		: await options.resolveDestinations(destinations);
	if (destination.cancelled) return { kind: "cancelled" };
	for (const change of destinations)
		if (
			change.enabled &&
			(guided || change.organizationId !== change.repository.organizationId) &&
			!changes.includes(change)
		)
			changes.push(change);
	const config = getManagerUploadConfig(guided);
	if (targets.length && !config)
		throw new UploadSaveError(
			"not_signed_in",
			"Sign in to upload existing sessions.",
		);
	if (guided) run.hasPreviousUploads = guided.hasPreviousUploads;
	else if (targets.length && run.hasPreviousUploads === undefined) {
		const credentials = loadCredentials();
		if (!credentials)
			throw new UploadSaveError(
				"not_signed_in",
				"Sign in to upload existing sessions.",
			);
		const setup = await createApiClient(credentials).cli.setupStatus();
		run.hasPreviousUploads = setup.hasUploadedSessions === true;
	}
	state.stage = "upload";
	state.message = "";
	state.uploadFailed = false;
	state.uploadPage = 0;
	state.followUpload = true;
	state.completion = undefined;
	const operation = async (signal: AbortSignal): Promise<UploadSaveResult> => {
		let settingsWarning: string | undefined;
		const result: UploadSaveResult = {
			uploaded: run.uploadedThisRun,
			failed: 0,
			skipped: 0,
			changes: changes.length,
		};
		try {
			signal.throwIfAborted();
			options.onProgress?.({ phase: "save" });
			if (changes.length)
				await saveRepositoryChanges(repositories, changes, adapters, {
					defaultOrganizationId: destination.defaultOrganizationId,
				});
			state.desired.clear();
			state.message = "";
			if (config)
				settingsWarning = await syncRepositorySettings(
					repositories,
					config,
					signal,
				);
			signal.throwIfAborted();
			if (targets.length && config) {
				await guided?.start();
				if (state.operation)
					state.operation.label = cliMessage("uploadProgress");
				const uploading = targets.filter((repo) => repo.enabled);
				options.onProgress?.({ phase: "upload" });
				const summary = await uploadRepositorySessions(
					uploading,
					config,
					() => options.onProgress?.(getUploadProgress(uploading)),
					signal,
				);
				startSessionInventoryInBackground({ force: true });
				run.uploadedThisRun += summary.succeeded;
				result.uploaded = run.uploadedThisRun;
				result.failed = summary.failed;
				result.skipped = summary.skipped;
				run.skippedBeforeRun ??=
					targets.reduce((count, repo) => count + repo.sessionCount, 0) -
					summary.total;
				state.message =
					summary.failed + summary.skipped
						? [
								`${run.uploadedThisRun} uploaded`,
								summary.failed ? `${summary.failed} failed` : "",
								summary.skipped ? `${summary.skipped} skipped` : "",
							]
								.filter(Boolean)
								.join(" · ")
						: cliMessage("uploadSummary", { count: run.uploadedThisRun });
				state.uploadFailed = summary.failed + summary.skipped > 0;
				if (run.uploadedThisRun > 0 || summary.failed === 0) {
					run.operationError = undefined;
					for (const repo of targets)
						run.uploadedWorkspaces.add(
							repo.uploadedOrganizationId ?? repo.organizationId,
						);
					const completion = getUploadCompletion(
						config.endpoint,
						run.hasPreviousUploads ?? false,
						destination.organizations.filter((org) =>
							run.uploadedWorkspaces.has(org.id),
						),
					);
					if (guided) {
						await guided.complete({
							uploaded: run.uploadedThisRun,
							skipped: run.skippedBeforeRun,
							failed: summary.failed,
						});
						state.completion = guided.completionLink(completion);
					} else state.completion = completion;
					state.selectionVisible = false;
				} else {
					state.uploadFailed = true;
					state.uploadPage = 0;
					if (guided) {
						run.operationError = new Error(state.message);
					}
				}
			} else
				state.message = cliMessage("saveSummary", {
					changes: `${changes.length} change${changes.length === 1 ? "" : "s"}`,
				});
			if (settingsWarning)
				state.message = `${state.message} ${settingsWarning}`.trim();
			return result;
		} catch (error) {
			if (guided && !signal.aborted) {
				run.operationError =
					error instanceof Error ? error : new Error(String(error));
				await guided.close(run.operationError);
			}
			throw error;
		}
	};
	return { kind: "ready", operation };
}

function getUploadProgress(repositories: UploadRepository[]) {
	let completed = 0;
	let total = 0;
	for (const repository of repositories) {
		completed += repository.upload?.completed ?? 0;
		total += repository.upload?.total ?? 0;
	}
	return { phase: "upload" as const, completed, total };
}

export function getManagerUploadConfig(
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
	showPrompt?: () => void,
): Promise<UploadDestination> {
	const approved = await guided.authorize(repositories, state, showPrompt);
	for (const change of changes)
		if (change.enabled) change.organizationId = approved.organizationId;
	return {
		cancelled: false,
		defaultOrganizationId: approved.organizationId,
		organizations: approved.organizations,
	};
}

export async function resolveDestinations(
	changes: RepositoryChange[],
	prompts: DestinationPrompts,
): Promise<UploadDestination> {
	const enabling = changes.filter((change) => change.enabled);
	if (enabling.length === 0) return { cancelled: false, organizations: [] };
	const risk = describeSavedCredentialsApiBaseRisk();
	if (risk) prompts.warn(risk);
	const apiBase = loadCredentials()?.apiBaseUrl ?? getDefaultApiBase();
	let auth = await verifyAuth();
	if (
		!auth.authenticated &&
		(auth.reason === "no_credentials" || auth.reason === "token_expired")
	) {
		await prompts.login(apiBase);
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
			const selected = await prompts.selectOrganization(organizations);
			if (selected === undefined) return { cancelled: true };
			organizationId = selected;
			defaultOrganizationId = selected;
		}
		change.organizationId = organizationId;
	}
	return { cancelled: false, defaultOrganizationId, organizations };
}
