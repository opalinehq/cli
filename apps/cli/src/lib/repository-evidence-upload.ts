import { createHash, randomUUID } from "node:crypto";
import { createORPCClient, ORPCError } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ContractRouterClient } from "@orpc/contract";
import {
	type contract,
	type IngestSessionInput,
	parseSafeApiEndpoint,
	REPOSITORY_EVIDENCE_PROTOCOL,
	type RepositoryEvidenceCapture,
	type RepositoryEvidenceCommitOutput,
	type RepositoryEvidenceCoverageArea,
	type RepositoryEvidenceInitInput,
	type RepositoryEvidenceObjectDescriptor,
} from "../contracts/index.js";
import {
	assessContextSkillUse,
	type LocalContextBundle,
} from "../internal/local-context-source/index.js";
import type { RepositoryContext } from "./repo-context.js";
import type { SessionAttributionManifest } from "./session-attribution.js";
import type { TranscriptRevisionPlan } from "./transcript-revision.js";
import { describeUploadEndpointRejection } from "./upload-endpoint.js";

export interface RepositoryEvidenceBytes {
	readonly bytes: Uint8Array;
	readonly descriptor: RepositoryEvidenceObjectDescriptor;
}

export interface BuiltRepositoryEvidenceUpload {
	readonly input: RepositoryEvidenceInitInput;
	readonly objects: ReadonlyMap<string, RepositoryEvidenceBytes>;
}

export interface RepositoryEvidenceUploadConfig {
	readonly allowInsecureEndpoint: boolean;
	readonly authType?: "bearer" | "api-key";
	readonly endpoint: string;
	readonly fetch?: typeof globalThis.fetch;
	readonly operationTimeoutMs?: number;
	readonly requestTimeoutMs?: number;
	readonly token: string;
}

export function buildRepositoryEvidenceUpload(input: {
	readonly attribution: SessionAttributionManifest;
	readonly bundle: LocalContextBundle;
	readonly captureLifecycle: RepositoryEvidenceCapture["timing"]["lifecycle"];
	readonly context: Pick<RepositoryContext, "localIdentity" | "remoteHint">;
	readonly firstActionAt: string | null;
	readonly firstActionBasis: RepositoryEvidenceCapture["timing"]["firstActionBasis"];
	readonly firstActionRelationship: RepositoryEvidenceCapture["timing"]["firstActionRelationship"];
	readonly organizationId: string;
	readonly session: Pick<
		IngestSessionInput,
		"content" | "sessionId" | "source" | "subagents"
	>;
	readonly terminalTranscript: boolean;
	readonly transcriptLastEventAt: string | null;
	readonly transcriptRevision: TranscriptRevisionPlan;
}): BuiltRepositoryEvidenceUpload {
	const observedSkills = extractObservedSkills(input.session);
	const skillAssessments = assessContextSkillUse(
		input.bundle.manifest.contextIndex.skills,
		input.captureLifecycle === "start"
			? null
			: {
					coverage: "partial",
					observedSkillNames: observedSkills,
					scope: { kind: "session", id: input.session.sessionId },
				},
	);
	const manifestValue = {
		attribution: input.attribution,
		contextIndex: {
			facets: input.bundle.manifest.contextIndex.facets,
			skills: skillAssessments,
		},
		localContext: input.bundle.manifest,
		protocol: REPOSITORY_EVIDENCE_PROTOCOL,
		transcriptRevision: input.transcriptRevision.manifest,
	};
	const manifestBytes = new TextEncoder().encode(JSON.stringify(manifestValue));
	const manifest = buildObject(
		manifestBytes,
		"context-manifest",
		"application/json",
		input.bundle.manifest.transport.secretFilterVersion,
	);
	const objects = new Map<string, RepositoryEvidenceBytes>([
		[manifest.descriptor.objectId, manifest],
	]);
	for (const blob of input.bundle.blobs) {
		const bytes = new TextEncoder().encode(blob.content);
		if (bytes.byteLength === 0) continue;
		const object = buildObject(
			bytes,
			"source-blob",
			"text/plain; charset=utf-8",
			input.bundle.manifest.transport.secretFilterVersion,
		);
		if (object.descriptor.objectId !== blob.id) {
			throw new Error(`Local context blob ${blob.id} failed its content hash.`);
		}
		objects.set(object.descriptor.objectId, object);
	}
	for (const chunk of input.transcriptRevision.newChunks) {
		const object = buildObject(
			chunk.bytes,
			"transcript-chunk",
			"application/x-ndjson",
			input.bundle.manifest.transport.secretFilterVersion,
		);
		if (object.descriptor.sha256 !== chunk.sha256) {
			throw new Error("Transcript revision chunk failed its content hash.");
		}
		objects.set(object.descriptor.objectId, object);
	}

	const capture: RepositoryEvidenceCapture = {
		baseGitCommit: input.bundle.manifest.baseGitCommit,
		contextId: input.bundle.manifest.captureId,
		headGitCommit:
			input.bundle.manifest.git.status === "available"
				? input.bundle.manifest.git.head.commit
				: null,
		parentContextId: input.bundle.manifest.parentCaptureId,
		timing: {
			captureCompletedAt: input.bundle.manifest.completedAt,
			captureStartedAt: input.bundle.manifest.startedAt,
			firstActionAt: input.firstActionAt,
			firstActionBasis: input.firstActionBasis,
			firstActionRelationship: input.firstActionRelationship,
			lifecycle: input.captureLifecycle,
		},
		transcriptWatermark: buildLegacyTranscriptWatermark(
			input.transcriptRevision,
			input.transcriptLastEventAt,
		),
	};
	return {
		input: {
			capture,
			coverage: buildCoverage(input.bundle),
			manifestObjectId: manifest.descriptor.objectId,
			objects: [...objects.values()].map((object) => object.descriptor),
			operationId: randomUUID(),
			organizationId: input.organizationId,
			protocol: REPOSITORY_EVIDENCE_PROTOCOL,
			repository: {
				local: input.context.localIdentity,
				provider: null,
				remoteHint: input.context.remoteHint,
			},
			session: {
				agentId: null,
				parentAgentId: null,
				runId: input.session.sessionId,
				segmentId: input.session.sessionId,
				sessionId: input.session.sessionId,
				source: input.session.source,
			},
		},
		objects,
	};
}

export function buildLegacyTranscriptWatermark(
	transcriptRevision: TranscriptRevisionPlan,
	lastEventAt: string | null,
): RepositoryEvidenceCapture["transcriptWatermark"] {
	const watermark = transcriptRevision.manifest.watermark;
	if (watermark.recordCount === 0) return null;
	return {
		byteOffset: watermark.byteOffset,
		eventOrdinal: watermark.lastOrdinal ?? watermark.recordCount - 1,
		lastEventAt,
	};
}

export async function uploadRepositoryEvidence(
	upload: BuiltRepositoryEvidenceUpload,
	config: RepositoryEvidenceUploadConfig,
): Promise<RepositoryEvidenceCommitOutput> {
	const endpoint = parseSafeApiEndpoint(config.endpoint, {
		allowPlaintext: config.allowInsecureEndpoint,
	});
	if (!endpoint.ok) {
		throw new Error(
			`Evidence upload endpoint refused: ${describeUploadEndpointRejection(endpoint)}`,
		);
	}
	const authType = config.authType ?? "bearer";
	const authHeaders =
		authType === "api-key"
			? { "x-api-key": config.token }
			: { Authorization: `Bearer ${config.token}` };
	const fetchImplementation = config.fetch ?? globalThis.fetch;
	const operationTimeout = config.operationTimeoutMs
		? AbortSignal.timeout(config.operationTimeoutMs)
		: undefined;
	const boundedFetch = withRequestTimeout(
		fetchImplementation,
		config.requestTimeoutMs ?? 15_000,
		operationTimeout,
	);
	const link = new RPCLink({
		fetch: boundedFetch,
		headers: authHeaders,
		url: endpoint.url.toString(),
	});
	const client: ContractRouterClient<typeof contract> = createORPCClient(link);
	const initialized = await client.repositoryEvidence.init(upload.input);
	const completed = [];
	for (const remoteObject of initialized.missingObjects) {
		const local = upload.objects.get(remoteObject.objectId);
		if (!local) {
			throw new Error(
				`Server requested evidence object ${remoteObject.objectId}, but its bytes are not in the local capture.`,
			);
		}
		const parts = [];
		let offset = 0;
		for (const part of remoteObject.parts) {
			const bytes = local.bytes.slice(offset, offset + part.byteLength);
			if (bytes.byteLength !== part.byteLength) {
				throw new Error(
					`Evidence object ${remoteObject.objectId} is shorter than its upload plan.`,
				);
			}
			const response = await boundedFetch(part.uploadUrl, {
				body: bytes,
				headers: part.headers,
				method: "PUT",
			});
			if (!response.ok) {
				throw new RepositoryEvidenceHttpError(response.status);
			}
			const etag = response.headers.get("etag");
			if (!etag) {
				throw new Error("Evidence object upload did not return an ETag.");
			}
			parts.push({ etag, partNumber: part.partNumber });
			offset += part.byteLength;
		}
		if (offset !== local.bytes.byteLength) {
			throw new Error(
				`Evidence object ${remoteObject.objectId} is longer than its upload plan.`,
			);
		}
		completed.push({
			objectId: remoteObject.objectId,
			objectKey: remoteObject.objectKey,
			parts,
			uploadId: remoteObject.uploadId,
		});
	}
	return client.repositoryEvidence.commit({
		objects: completed,
		organizationId: upload.input.organizationId,
		uploadReceiptId: initialized.uploadReceiptId,
	});
}

export function isRetryableRepositoryEvidenceError(error: unknown): boolean {
	if (error instanceof RepositoryEvidenceHttpError) {
		return [408, 429, 502, 503, 504].includes(error.status);
	}
	if (error instanceof ORPCError) {
		return [408, 429, 502, 503, 504].includes(error.status);
	}
	return true;
}

class RepositoryEvidenceHttpError extends Error {
	constructor(readonly status: number) {
		super(`Evidence object upload failed with HTTP ${status}.`);
		this.name = "RepositoryEvidenceHttpError";
	}
}

function withRequestTimeout(
	fetchImplementation: typeof globalThis.fetch,
	timeoutMs: number,
	operationTimeout: AbortSignal | undefined,
): typeof globalThis.fetch {
	return (input, init) => {
		const timeout = AbortSignal.timeout(timeoutMs);
		const signals = [timeout];
		if (operationTimeout) signals.push(operationTimeout);
		if (init?.signal) signals.push(init.signal);
		const signal = AbortSignal.any(signals);
		return fetchImplementation(input, { ...init, signal });
	};
}

function buildObject(
	bytes: Uint8Array,
	kind: RepositoryEvidenceObjectDescriptor["kind"],
	mediaType: string,
	filterVersion: number,
): RepositoryEvidenceBytes {
	const sha256 = createHash("sha256").update(bytes).digest("hex");
	return {
		bytes,
		descriptor: {
			byteLength: bytes.byteLength,
			contentEncoding: "identity",
			filterVersion,
			kind,
			mediaType,
			objectId: `sha256:${sha256}`,
			sha256,
		},
	};
}

function extractObservedSkills(
	session: Pick<IngestSessionInput, "content" | "subagents">,
): readonly string[] {
	const contents = [
		session.content,
		...(session.subagents ?? []).map((subagent) => subagent.content),
	];
	const skills = new Set<string>();
	for (const content of contents) {
		for (const line of content.split("\n")) {
			if (!line.trim()) continue;
			try {
				collectObservedSkills(JSON.parse(line), skills);
			} catch {
				// A malformed record makes negative skill-use conclusions unsafe. The
				// manifest therefore always declares partial usage evidence.
			}
		}
	}
	return [...skills].sort();
}

function collectObservedSkills(value: unknown, skills: Set<string>): void {
	if (Array.isArray(value)) {
		for (const item of value) collectObservedSkills(item, skills);
		return;
	}
	if (!isRecord(value)) return;
	const name = typeof value.name === "string" ? value.name : undefined;
	const input = isRecord(value.input) ? value.input : undefined;
	if (name?.split(/\.|__/u).at(-1)?.toLowerCase() === "skill") {
		const skill = input?.skill;
		if (typeof skill === "string" && skill.trim()) skills.add(skill.trim());
	}
	const path = input?.file_path ?? input?.path;
	if (typeof path === "string") {
		const match = /(?:^|\/)([^/]+)\/SKILL(?:\.md)?$/iu.exec(
			path.replaceAll("\\", "/"),
		);
		if (match?.[1]) skills.add(match[1]);
	}
	for (const nested of Object.values(value))
		collectObservedSkills(nested, skills);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function buildCoverage(bundle: LocalContextBundle) {
	const facets = bundle.manifest.contextIndex.facets;
	return [
		coverage(
			"git-state",
			bundle.manifest.git.status === "available"
				? null
				: "Git state unavailable",
		),
		coverageFromFacets(
			"effective-instructions",
			facets.filter((facet) =>
				["agents-instructions", "claude-instructions"].includes(facet.kind),
			),
		),
		coverageFromFacets(
			"available-skills",
			[],
			bundle.manifest.roots.some(
				(root) => root.scope === "skills" && root.status !== "collected",
			)
				? "One or more skill roots were unavailable or truncated"
				: null,
		),
		coverageFromFacets(
			"package-configuration",
			facets.filter((facet) => facet.kind === "package-context"),
		),
		coverage(
			"task-delta",
			bundle.manifest.git.status === "available"
				? null
				: "Git diff unavailable",
		),
		coverage(
			"referenced-evidence",
			bundle.manifest.coverage.errors.length === 0
				? null
				: "Some explicitly referenced evidence could not be captured",
		),
		coverage("transcript-watermark", null),
	];
}

function coverageFromFacets(
	area: RepositoryEvidenceCoverageArea,
	facets: readonly LocalContextBundle["manifest"]["contextIndex"]["facets"][number][],
	overrideReason: string | null = null,
) {
	const incomplete = facets.find((facet) => facet.coverage !== "complete");
	return coverage(
		area,
		overrideReason ??
			(incomplete
				? `${incomplete.kind} coverage is ${incomplete.coverage}`
				: null),
	);
}

function coverage(area: RepositoryEvidenceCoverageArea, reason: string | null) {
	return reason === null
		? ({ area, reason: null, status: "complete" } as const)
		: ({ area, reason, status: "partial" } as const);
}
