import { stat } from "node:fs/promises";
import pMap from "p-map";
import {
	CLI_SESSION_UPLOAD_STATUS_MAX_IDS,
	CliSessionUploadStatusOutputSchema,
	parseSafeApiEndpoint,
} from "../contracts/index.js";
import {
	type UploadFailure,
	UploadFailureSchema,
} from "../contracts/upload-failure.js";
import { type GitInfo, getAdapter } from "../internal/agent-adapters/index.js";
import { filterKnownSecrets } from "../internal/secret-filter/index.js";
import { createApiClient } from "./api-client.js";
import { type BatchUploadSummary, batchUpload } from "./batch-upload.js";
import { getGitInfo } from "./git-info.js";
import { getProjectOrgId } from "./project-config.js";
import type { UploadRepository } from "./upload-manager-repositories.js";
import {
	recordUploadBytes,
	type SessionUploadDetail,
} from "./upload-progress.js";
import {
	getUploadSizeFailure,
	type UploadConfig,
	uploadSession,
} from "./uploader.js";

export async function checkRepositoryUploads(
	repositories: UploadRepository[],
	config: UploadConfig,
	onUpdate: () => void,
	signal?: AbortSignal,
): Promise<void> {
	const endpoint = parseSafeApiEndpoint(config.endpoint, {
		allowPlaintext: config.allowInsecureEndpoint,
	});
	if (!endpoint.ok) throw new Error("Upload history endpoint is not allowed.");
	const client = createApiClient({
		apiBaseUrl: endpoint.url.replace(/\/rpc\/?$/u, ""),
		token: config.token,
		authType: config.authType,
	});
	const groups = new Map<string | undefined, UploadRepository[]>();
	for (const repository of repositories) {
		signal?.throwIfAborted();
		const path = repository.paths[0];
		const organizationId =
			repository.organizationId ??
			(path ? await getProjectOrgId(path) : undefined);
		const group = groups.get(organizationId) ?? [];
		group.push(repository);
		groups.set(organizationId, group);
		if (!repository.sessions?.length) repository.uploadedCount = 0;
	}
	await pMap(
		[...groups],
		async ([organizationId, group]) => {
			const ids = [
				...new Set(
					group.flatMap(
						(repo) => repo.sessions?.map((session) => session.sessionId) ?? [],
					),
				),
			];
			const uploaded = new Set<string>();
			const checked = new Set<string>();
			let resolvedOrganizationId = organizationId;
			const chunks: string[][] = [];
			for (let i = 0; i < ids.length; i += CLI_SESSION_UPLOAD_STATUS_MAX_IDS)
				chunks.push(ids.slice(i, i + CLI_SESSION_UPLOAD_STATUS_MAX_IDS));
			await pMap(
				chunks,
				async (sessionIds) => {
					signal?.throwIfAborted();
					const response = CliSessionUploadStatusOutputSchema.parse(
						await client.cli.sessionUploadStatus(
							{ organizationId, sessionIds },
							{
								signal: signal
									? AbortSignal.any([signal, AbortSignal.timeout(10000)])
									: AbortSignal.timeout(10000),
							},
						),
					);
					signal?.throwIfAborted();
					if (
						resolvedOrganizationId &&
						response.organizationId !== resolvedOrganizationId
					)
						throw new Error(
							"Upload history returned a different organization.",
						);
					resolvedOrganizationId = response.organizationId;
					for (const id of response.uploadedSessionIds) {
						if (!sessionIds.includes(id))
							throw new Error("Upload history returned an unexpected session.");
						uploaded.add(id);
					}
					for (const id of sessionIds) checked.add(id);
					for (const repo of group) {
						if (
							!repo.sessions?.every((session) => checked.has(session.sessionId))
						)
							continue;
						repo.uploadedSessionIds = new Set(
							repo.sessions
								.filter((session) => uploaded.has(session.sessionId))
								.map((session) => session.sessionId),
						);
						repo.uploadedCount = repo.sessions.filter((session) =>
							uploaded.has(session.sessionId),
						).length;
						repo.uploadedOrganizationId = resolvedOrganizationId;
					}
					onUpdate();
				},
				{ concurrency: 4, stopOnError: false },
			);
		},
		{ concurrency: 2, stopOnError: false },
	).catch((error: unknown) => {
		let reason = error;
		while (
			reason instanceof AggregateError &&
			reason.errors[0] instanceof Error
		)
			reason = reason.errors[0];
		throw reason;
	});
}

export async function uploadRepositorySessions(
	repositories: UploadRepository[],
	config: UploadConfig,
	onUpdate: () => void,
	signal: AbortSignal,
): Promise<BatchUploadSummary> {
	const enabled = repositories.filter((repository) => repository.enabled);
	await checkRepositoryUploads(enabled, config, onUpdate, signal);
	const claimed = new Set<string>();
	const items = enabled.flatMap((repository) => {
		const sessions = (repository.sessions ?? []).filter((session) => {
			const key = `${repository.uploadedOrganizationId}:${session.sessionId}`;
			if (
				repository.uploadedSessionIds?.has(session.sessionId) ||
				claimed.has(key)
			)
				return false;
			claimed.add(key);
			return true;
		});
		repository.uploadError = undefined;
		repository.sessionUploads = [];
		repository.uploadSpeed = { startedAt: performance.now(), samples: [] };
		repository.upload = {
			completed: repository.uploadedCount ?? 0,
			total: repository.sessionCount,
			active: false,
			failed: 0,
		};
		return sessions.map((session) => {
			const detail: SessionUploadDetail = {
				sessionId: session.sessionId,
				source: session.source,
				sessionDate: session.sessionDate,
				status: "queued",
				uploadedBytes: 0,
				totalBytes: undefined,
			};
			repository.sessionUploads?.push(detail);
			return {
				...session,
				organizationId: repository.uploadedOrganizationId,
				label: `${repository.name}/${session.sessionId}`,
				repository,
				detail,
			};
		});
	});
	const reports: Array<{
		organizationId: string;
		failure: UploadFailure;
		detail: SessionUploadDetail;
	}> = [];
	const active = new Map<string, number>();
	const git = new Map<string, Promise<GitInfo>>();
	onUpdate();
	const summary = await batchUpload({
		items,
		concurrency: 3,
		signal,
		upload: async (item, onRetry) => {
			signal.throwIfAborted();
			const { repository, detail } = item;
			detail.status = "preparing";
			let failureMetadata: Partial<UploadFailure> = {};
			let previousBytes = 0;
			let transferStage: "preparing" | "uploading" | "processing" = "preparing";
			active.set(repository.key, (active.get(repository.key) ?? 0) + 1);
			if (repository.upload) repository.upload.active = true;
			onUpdate();
			try {
				let gitInfo = git.get(item.projectPath);
				if (!gitInfo) {
					gitInfo = getGitInfo(item.projectPath);
					git.set(item.projectPath, gitInfo);
				}
				const info = await gitInfo;
				failureMetadata = {
					gitRemote: item.gitRemote ?? info.gitRemote,
					gitBranch: item.gitBranch ?? info.branch,
					gitSha: item.gitSha ?? info.sha,
					packageName: info.packageName,
				};
				// A large main file needs no transcript scan or subagent discovery.
				let result = getUploadSizeFailure(
					(await stat(item.transcriptPath)).size,
					config.maxAggregateBytes,
				);
				if (!result) {
					const request = await getAdapter(item.source).buildUploadRequest(
						item,
						{
							organizationId: item.organizationId,
							gitInfo: info,
							uploadMode: "manual",
						},
					);
					const metadata = request.metadata;
					failureMetadata = {
						gitRemote: metadata.gitRemote,
						gitBranch: metadata.gitBranch,
						gitSha: metadata.gitSha,
						packageName: metadata.packageName,
						cliVersion: metadata.cli_version,
					};
					signal.throwIfAborted();
					result = await uploadSession(request, {
						...config,
						signal,
						onRetry: (attempt, maxAttempts, error) => {
							onRetry(attempt, maxAttempts, error);
							detail.status = "retrying";
							detail.attempt = attempt + 1;
							detail.maxAttempts = maxAttempts;
							detail.error = error;
							onUpdate();
						},
						onTransferProgress: (progress) => {
							config.onTransferProgress?.(progress);
							detail.status = progress.phase;
							transferStage = progress.phase;
							detail.error = undefined;
							detail.uploadedBytes = progress.uploadedBytes;
							detail.totalBytes = progress.totalBytes;
							if (
								progress.uploadedBytes !== undefined &&
								repository.uploadSpeed
							) {
								recordUploadBytes(
									repository.uploadSpeed,
									Math.max(0, progress.uploadedBytes - previousBytes),
									performance.now(),
								);
								previousBytes = progress.uploadedBytes;
							}
							onUpdate();
						},
					});
				}
				if (result.success) {
					detail.status = "uploaded";
					detail.error = undefined;
					detail.uploadedBytes = detail.totalBytes;
					repository.uploadedSessionIds?.add(item.sessionId);
					repository.uploadedCount = (repository.uploadedCount ?? 0) + 1;
					if (repository.upload)
						repository.upload.completed = repository.uploadedCount;
				} else {
					detail.status =
						result.attempts === 0 && result.maxBytes !== undefined
							? "skipped"
							: "failed";
					detail.totalBytes ??= result.totalBytes;
					detail.maxBytes = result.maxBytes;
					if (result.attempts === 0) detail.uploadedBytes ??= 0;
					failureMetadata = {
						...failureMetadata,
						maxBytes: result.maxBytes,
						attempts: result.attempts ?? 0,
						retryable: result.retryable ?? true,
					};
					detail.failureStage = transferStage;
					detail.error =
						result.error ?? "Upload failed without an error message.";
					if (detail.status === "failed") {
						if (repository.upload) repository.upload.failed++;
						repository.uploadError = result.error;
					}
				}
				return result;
			} catch (error) {
				if (!signal.aborted) {
					detail.status = "failed";
					detail.failureStage = transferStage;
					detail.error = error instanceof Error ? error.message : String(error);
					if (repository.upload) repository.upload.failed++;
					repository.uploadError =
						error instanceof Error ? error.message : String(error);
				}
				throw error;
			} finally {
				if (
					(detail.status === "failed" || detail.status === "skipped") &&
					item.organizationId &&
					!signal.aborted
				) {
					const failure = UploadFailureSchema.safeParse({
						repository: repository.name.slice(0, 200),
						projectPath: item.projectPath.slice(0, 200),
						sessionId: item.sessionId,
						source: item.source,
						sessionDate:
							item.sessionDate === undefined
								? null
								: new Date(item.sessionDate).toISOString(),
						totalBytes: detail.totalBytes ?? null,
						uploadedBytes: detail.uploadedBytes ?? null,
						stage: transferStage,
						error: detail.error?.slice(0, 4000),
						attempts: 0,
						retryable: true,
						...failureMetadata,
					});
					if (failure.success)
						reports.push({
							organizationId: item.organizationId,
							failure: failure.data,
							detail,
						});
					else
						detail.reportError =
							"Failure details could not be saved to the dashboard.";
				}
				active.set(repository.key, (active.get(repository.key) ?? 1) - 1);
				if (repository.upload)
					repository.upload.active = (active.get(repository.key) ?? 0) > 0;
				onUpdate();
			}
		},
	});
	signal.throwIfAborted();
	for (const repository of enabled) {
		const remaining = items.filter(
			(item) =>
				item.repository === repository &&
				item.detail.status !== "skipped" &&
				!repository.uploadedSessionIds?.has(item.sessionId),
		);
		if (repository.upload) repository.upload.failed = remaining.length;
		if (remaining.length && !repository.uploadError)
			repository.uploadError =
				"Upload paused after the rate limit. Retry remaining sessions when the limit resets.";
		for (const item of remaining) {
			const { detail } = item;
			if (detail.status !== "queued") continue;
			detail.status = "failed";
			detail.error =
				"Not attempted: upload paused after the server rate limit. Retry later.";
			if (item.organizationId)
				reports.push({
					organizationId: item.organizationId,
					detail,
					failure: {
						sessionId: item.sessionId,
						source: item.source,
						repository: repository.name.slice(0, 200),
						projectPath: item.projectPath.slice(0, 200),
						sessionDate:
							item.sessionDate === undefined
								? null
								: new Date(item.sessionDate).toISOString(),
						totalBytes: null,
						uploadedBytes: 0,
						stage: "preparing",
						error: detail.error ?? "Upload deferred",
						attempts: 0,
						retryable: true,
					},
				});
		}
	}
	await reportFailures(reports, config, signal);
	onUpdate();
	return summary;
}

async function reportFailures(
	reports: Array<{
		organizationId: string;
		failure: UploadFailure;
		detail: SessionUploadDetail;
	}>,
	config: UploadConfig,
	signal: AbortSignal,
): Promise<void> {
	const client = createApiClient({
		apiBaseUrl: config.endpoint.replace(/\/rpc\/?$/u, ""),
		token: config.token,
		authType: config.authType,
	});
	for (const organizationId of new Set(
		reports.map((report) => report.organizationId),
	)) {
		const group = reports.filter(
			(report) => report.organizationId === organizationId,
		);
		for (let offset = 0; offset < group.length; offset += 64) {
			signal.throwIfAborted();
			const batch = group.slice(offset, offset + 64);
			try {
				const failures = batch.map((report) =>
					UploadFailureSchema.parse(
						JSON.parse(filterKnownSecrets(JSON.stringify(report.failure)).text),
					),
				);
				await client.cli.reportUploadFailures(
					{ organizationId, failures },
					{ signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) },
				);
			} catch {
				signal.throwIfAborted();
				for (const report of reports)
					report.detail.reportError =
						"Failure details could not be saved to the dashboard. They remain available in this terminal.";
				return;
			}
		}
	}
}
