import { ORPCError } from "@orpc/client";
import pMap from "p-map";
import {
	CLI_SESSION_UPLOAD_STATUS_MAX_IDS,
	parseSafeApiEndpoint,
	type RepoIdentity,
} from "../contracts/index.js";
import type {
	ScannedProject,
	SessionFile,
} from "../internal/agent-adapters/index.js";
import { createRpcClient } from "./api-client.js";
import { describeUploadEndpointRejection } from "./upload-endpoint.js";

export interface UploadProjectTarget {
	readonly organizationId: string | undefined;
	readonly project: ScannedProject;
}

export interface ResolvedOrganizationUploadStatus {
	readonly organizationId: string;
	readonly uploadedSessionIds: ReadonlySet<string>;
}

export interface ReconciledUploadProject extends UploadProjectTarget {
	readonly duplicateSessions: readonly SessionFile[];
	readonly newSessions: readonly SessionFile[];
	readonly resolvedOrganizationId: string;
	readonly uploadedSessions: readonly SessionFile[];
}

export interface UploadReconciliationConfig {
	readonly allowInsecureEndpoint: boolean;
	readonly authType: "bearer" | "api-key" | undefined;
	readonly endpoint: string;
	readonly token: string;
}

export interface UploadProjectOrder {
	readonly containsCwd: boolean;
	readonly index: number;
}

export interface RepositoryUploadProject {
	readonly newSessions: readonly SessionFile[];
	readonly project: ScannedProject;
	readonly repositoryIdentity: RepoIdentity;
	readonly legacyRepositoryKey?: string;
}

export interface HookAwareRepositoryUploadProject
	extends RepositoryUploadProject {
	readonly hookInstalled: boolean;
}

export interface UploadRepositoryGroup<
	TProject extends RepositoryUploadProject,
> {
	readonly key: string;
	readonly label: string;
	readonly projects: TProject[];
}

export type RepositoryHookState = "disabled" | "enabled" | "mixed";

export function getRepositoryLegacyKeys<
	TProject extends RepositoryUploadProject,
>(repository: UploadRepositoryGroup<TProject>): string[] {
	return [
		...new Set(
			repository.projects.flatMap((project) =>
				project.legacyRepositoryKey ? [project.legacyRepositoryKey] : [],
			),
		),
	];
}

export function getRepositorySessionCount<
	TProject extends RepositoryUploadProject,
>(repository: UploadRepositoryGroup<TProject>): number {
	return new Set(
		repository.projects.flatMap(({ project }) =>
			project.sessions.map((session) => session.sessionId),
		),
	).size;
}

export function getRepositoryLastActivity<
	TProject extends RepositoryUploadProject,
>(repository: UploadRepositoryGroup<TProject>): number {
	let latest = 0;
	for (const { project } of repository.projects)
		for (const session of project.sessions) {
			if (
				session.lastActivityAt !== undefined &&
				Number.isFinite(session.lastActivityAt)
			)
				latest = Math.max(latest, session.lastActivityAt);
		}
	return latest;
}

// A month's inactivity halves a repo's rank. Logarithmic counts give a
// substantial history a boost without letting the largest archive dominate.
const REPOSITORY_ACTIVITY_HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000;

export function orderUploadRepositoriesForSelection<
	TProject extends RepositoryUploadProject,
>(
	repositories: readonly UploadRepositoryGroup<TProject>[],
	now: number = Date.now(),
): UploadRepositoryGroup<TProject>[] {
	return repositories
		.map((repository) => {
			const count = getRepositorySessionCount(repository);
			const latest = getRepositoryLastActivity(repository);
			const age = Math.max(0, now - latest);
			const score =
				latest > 0
					? Math.log2(1 + count) *
						2 ** (-age / REPOSITORY_ACTIVITY_HALF_LIFE_MS)
					: 0;
			return { repository, score, count, latest };
		})
		.sort(
			(a, b) =>
				b.score - a.score ||
				b.count - a.count ||
				b.latest - a.latest ||
				a.repository.label.localeCompare(b.repository.label) ||
				a.repository.key.localeCompare(b.repository.key),
		)
		.map(({ repository }) => repository);
}

export async function reconcileUploadProjects(
	targets: readonly UploadProjectTarget[],
	config: UploadReconciliationConfig,
): Promise<ReconciledUploadProject[]> {
	const endpoint = parseSafeApiEndpoint(config.endpoint, {
		allowPlaintext: config.allowInsecureEndpoint,
	});
	if (!endpoint.ok) {
		throw new Error(
			`Upload endpoint refused: ${describeUploadEndpointRejection(endpoint)}`,
		);
	}

	const client = createRpcClient({
		rpcUrl: endpoint.url,
		token: config.token,
		authType: config.authType,
	});
	const sessionIdsByOrganization = collectSessionIdsByOrganization(targets);
	const statusEntries = await pMap(
		Array.from(sessionIdsByOrganization),
		async ([organizationId, sessionIds]) => {
			const responses = await pMap(
				chunk(sessionIds, CLI_SESSION_UPLOAD_STATUS_MAX_IDS),
				(ids) =>
					client.cli.sessionUploadStatus({
						organizationId,
						sessionIds: ids,
					}),
				{ concurrency: 4 },
			);
			const firstResponse = responses[0];
			if (!firstResponse) {
				throw new Error("Upload status response was empty");
			}
			const uploadedSessionIds = new Set<string>();
			for (const response of responses) {
				if (response.organizationId !== firstResponse.organizationId) {
					throw new Error("Upload status resolved inconsistent organizations");
				}
				for (const sessionId of response.uploadedSessionIds) {
					uploadedSessionIds.add(sessionId);
				}
			}
			return [
				organizationId,
				{
					organizationId: firstResponse.organizationId,
					uploadedSessionIds,
				},
			] as const;
		},
		{ concurrency: 4 },
	).catch((error: unknown) => {
		throw new Error(formatUploadReconciliationError(error));
	});

	return classifyUploadProjects(targets, new Map(statusEntries));
}

export function classifyUploadProjects(
	targets: readonly UploadProjectTarget[],
	statusByRequestedOrganization: ReadonlyMap<
		string | undefined,
		ResolvedOrganizationUploadStatus
	>,
): ReconciledUploadProject[] {
	const locallyClaimedByOrganization = new Map<string, Set<string>>();

	return targets.map((target) => {
		const status = statusByRequestedOrganization.get(target.organizationId);
		if (!status) {
			throw new Error("Upload status is missing for a target organization");
		}
		const locallyClaimed =
			locallyClaimedByOrganization.get(status.organizationId) ?? new Set();
		locallyClaimedByOrganization.set(status.organizationId, locallyClaimed);

		const newSessions: SessionFile[] = [];
		const uploadedSessions: SessionFile[] = [];
		const duplicateSessions: SessionFile[] = [];
		for (const session of target.project.sessions) {
			if (status.uploadedSessionIds.has(session.sessionId)) {
				uploadedSessions.push(session);
				continue;
			}
			if (locallyClaimed.has(session.sessionId)) {
				duplicateSessions.push(session);
				continue;
			}
			locallyClaimed.add(session.sessionId);
			newSessions.push(session);
		}

		return {
			...target,
			duplicateSessions,
			newSessions,
			resolvedOrganizationId: status.organizationId,
			uploadedSessions,
		};
	});
}

export function groupUploadProjectsByRepository<
	TProject extends RepositoryUploadProject,
>(projects: readonly TProject[]): UploadRepositoryGroup<TProject>[] {
	const groups = new Map<string, UploadRepositoryGroup<TProject>>();

	for (const project of projects) {
		const existing = groups.get(project.repositoryIdentity.repoKey);
		if (existing) {
			existing.projects.push(project);
			continue;
		}
		groups.set(project.repositoryIdentity.repoKey, {
			key: project.repositoryIdentity.repoKey,
			label: project.repositoryIdentity.repoLabel,
			projects: [project],
		});
	}

	return Array.from(groups.values());
}

export function getRepositoryHookState<
	TProject extends HookAwareRepositoryUploadProject,
>(repository: UploadRepositoryGroup<TProject>): RepositoryHookState {
	const enabledCount = repository.projects.filter(
		(project) => project.hookInstalled,
	).length;
	if (enabledCount === 0) return "disabled";
	if (enabledCount === repository.projects.length) return "enabled";
	return "mixed";
}

export function orderUploadRepositoriesNewFirst<
	TProject extends RepositoryUploadProject,
>(
	repositories: readonly UploadRepositoryGroup<TProject>[],
	projectOrder: ReadonlyMap<ScannedProject, UploadProjectOrder>,
): UploadRepositoryGroup<TProject>[] {
	return [...repositories].sort((left, right) => {
		const leftHasNew = repositoryHasNewSessions(left);
		const rightHasNew = repositoryHasNewSessions(right);
		if (leftHasNew !== rightHasNew) return leftHasNew ? -1 : 1;
		const leftOrder = getRepositoryOrder(left, projectOrder);
		const rightOrder = getRepositoryOrder(right, projectOrder);
		if (leftOrder?.containsCwd !== rightOrder?.containsCwd) {
			return leftOrder?.containsCwd ? -1 : 1;
		}
		return (leftOrder?.index ?? 0) - (rightOrder?.index ?? 0);
	});
}

function repositoryHasNewSessions<TProject extends RepositoryUploadProject>(
	repository: UploadRepositoryGroup<TProject>,
): boolean {
	return repository.projects.some((project) => project.newSessions.length > 0);
}

function getRepositoryOrder<TProject extends RepositoryUploadProject>(
	repository: UploadRepositoryGroup<TProject>,
	projectOrder: ReadonlyMap<ScannedProject, UploadProjectOrder>,
): UploadProjectOrder | undefined {
	let containsCwd = false;
	let index: number | undefined;
	for (const project of repository.projects) {
		const order = projectOrder.get(project.project);
		if (!order) continue;
		containsCwd ||= order.containsCwd;
		index = index === undefined ? order.index : Math.min(index, order.index);
	}
	return index === undefined ? undefined : { containsCwd, index };
}

function collectSessionIdsByOrganization(
	targets: readonly UploadProjectTarget[],
): Map<string | undefined, string[]> {
	const sessionIdsByOrganization = new Map<string | undefined, Set<string>>();
	for (const target of targets) {
		const sessionIds =
			sessionIdsByOrganization.get(target.organizationId) ?? new Set<string>();
		sessionIdsByOrganization.set(target.organizationId, sessionIds);
		for (const session of target.project.sessions) {
			sessionIds.add(session.sessionId);
		}
	}

	return new Map(
		Array.from(sessionIdsByOrganization, ([organizationId, sessionIds]) => [
			organizationId,
			Array.from(sessionIds),
		]),
	);
}

function chunk<TValue>(values: readonly TValue[], maxSize: number): TValue[][] {
	const chunks: TValue[][] = [];
	for (let index = 0; index < values.length; index += maxSize) {
		chunks.push(values.slice(index, index + maxSize));
	}
	return chunks;
}

function formatUploadReconciliationError(error: unknown): string {
	if (
		error instanceof ORPCError &&
		(error.status === 401 || error.status === 403)
	) {
		return "Could not check uploaded sessions because authentication expired. Run `opaline login` and try again.";
	}
	if (error instanceof ORPCError) {
		return `Could not check uploaded sessions (${error.status} ${error.message}). No sessions were uploaded.`;
	}
	const message = error instanceof Error ? error.message : "connection failed";
	return `Could not check uploaded sessions: ${message}. No sessions were uploaded.`;
}
