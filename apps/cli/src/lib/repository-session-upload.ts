import pMap from "p-map";
import {
	CLI_SESSION_UPLOAD_STATUS_MAX_IDS,
	CliSessionUploadStatusOutputSchema,
	parseSafeApiEndpoint,
} from "../contracts/index.js";
import { type GitInfo, getAdapter } from "../internal/agent-adapters/index.js";
import { createApiClient } from "./api-client.js";
import { type BatchUploadSummary, batchUpload } from "./batch-upload.js";
import { getGitInfo } from "./git-info.js";
import { getProjectOrgId } from "./project-config.js";
import type { UploadRepository } from "./upload-manager-repositories.js";
import { type UploadConfig, uploadSession } from "./uploader.js";

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
		repository.upload = {
			completed: repository.uploadedCount ?? 0,
			total: repository.sessionCount,
			active: false,
			failed: 0,
		};
		return sessions.map((session) => ({
			...session,
			organizationId: repository.uploadedOrganizationId,
			label: `${repository.name}/${session.sessionId}`,
			repository,
		}));
	});
	const active = new Map<string, number>();
	const git = new Map<string, Promise<GitInfo>>();
	onUpdate();
	const summary = await batchUpload({
		items,
		concurrency: 3,
		signal,
		upload: async (item, onRetry) => {
			signal.throwIfAborted();
			const { repository } = item;
			active.set(repository.key, (active.get(repository.key) ?? 0) + 1);
			if (repository.upload) repository.upload.active = true;
			onUpdate();
			try {
				let gitInfo = git.get(item.projectPath);
				if (!gitInfo) {
					gitInfo = getGitInfo(item.projectPath);
					git.set(item.projectPath, gitInfo);
				}
				const request = await getAdapter(item.source).buildUploadRequest(item, {
					organizationId: item.organizationId,
					gitInfo: await gitInfo,
					uploadMode: "manual",
				});
				signal.throwIfAborted();
				const result = await uploadSession(request, {
					...config,
					signal,
					onRetry,
				});
				if (result.success) {
					repository.uploadedSessionIds?.add(item.sessionId);
					repository.uploadedCount = (repository.uploadedCount ?? 0) + 1;
					if (repository.upload)
						repository.upload.completed = repository.uploadedCount;
				} else {
					if (repository.upload) repository.upload.failed++;
					repository.uploadError = result.error;
				}
				return result;
			} catch (error) {
				if (!signal.aborted) {
					if (repository.upload) repository.upload.failed++;
					repository.uploadError =
						error instanceof Error ? error.message : String(error);
				}
				throw error;
			} finally {
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
				!repository.uploadedSessionIds?.has(item.sessionId),
		);
		if (repository.upload) repository.upload.failed = remaining.length;
		if (remaining.length && !repository.uploadError)
			repository.uploadError =
				"Upload paused after the rate limit. Press Enter to retry remaining sessions.";
	}
	onUpdate();
	return summary;
}
