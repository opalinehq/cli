import { createHash, randomUUID } from "node:crypto";
import { createORPCClient, ORPCError } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ContractRouterClient } from "@orpc/contract";
import type { IngestSessionInput } from "../contracts/index.js";
import {
	type contract,
	createRepositoryEvidenceInitInputSchema,
	parseSafeApiEndpoint,
	REPOSITORY_EVIDENCE_MAX_AGGREGATE_BYTES,
	REPOSITORY_EVIDENCE_PROTOCOL,
	type RepositoryEvidenceCapture,
	type RepositoryEvidenceCommitOutput,
	type RepositoryEvidenceCoverageArea,
	type RepositoryEvidenceInitInput,
	RepositoryEvidenceInitInputSchema,
	type RepositoryEvidenceObjectDescriptor,
} from "../contracts/index.js";
import {
	assessContextSkillUse,
	type GitDiff,
	type GitRepositorySnapshot,
	type LocalContextBundle,
} from "../internal/local-context-source/index.js";
import { filterContextMetadata } from "../internal/local-context-source/metadata-filter.js";
import { FILTER_VERSION } from "../internal/secret-filter/index.js";
import type { RepositoryContext } from "./repo-context.js";
import {
	continueSessionAttribution,
	type SessionAttributionManifest,
} from "./session-attribution.js";
import type {
	TranscriptDeliveryState,
	TranscriptRevisionPlan,
} from "./transcript-revision.js";
import { extractObservedSkills } from "./transcript-skills.js";
import { describeUploadEndpointRejection } from "./upload-endpoint.js";

export interface RepositoryEvidenceBytes {
	readonly bytes: Uint8Array;
	readonly descriptor: RepositoryEvidenceObjectDescriptor;
}

export interface BuiltRepositoryEvidenceUpload {
	readonly input: RepositoryEvidenceInitInput;
	readonly objects: ReadonlyMap<string, RepositoryEvidenceBytes>;
}

const MANIFEST_HEADROOM_BYTES = 1024 * 1024;

interface RepositoryEvidenceDeliveryLimits {
	readonly maxAggregateBytes?: number;
	readonly manifestHeadroomBytes?: number;
}

export function getTranscriptDeliveryBudget(
	bundle: LocalContextBundle,
	limits: RepositoryEvidenceDeliveryLimits = {},
): number {
	const encoder = new TextEncoder();
	const contextBytes =
		encoder.encode(JSON.stringify(bundle.manifest)).byteLength +
		bundle.blobs.reduce(
			(total, blob) => total + encoder.encode(blob.content).byteLength,
			0,
		);
	return Math.max(
		0,
		(limits.maxAggregateBytes ?? REPOSITORY_EVIDENCE_MAX_AGGREGATE_BYTES) -
			contextBytes -
			(limits.manifestHeadroomBytes ?? MANIFEST_HEADROOM_BYTES),
	);
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

export function buildRepositoryEvidenceUpload(
	input: {
		readonly attribution?: SessionAttributionManifest;
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
	},
	limits: RepositoryEvidenceDeliveryLimits = {},
): BuiltRepositoryEvidenceUpload {
	const observedSkills = filterContextMetadata(
		extractObservedSkills(input.session),
	);
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
	const manifestValue = filterContextMetadata({
		attribution: input.attribution,
		contextIndex: {
			facets: input.bundle.manifest.contextIndex.facets,
			skills: skillAssessments,
		},
		localContext: input.bundle.manifest,
		protocol: REPOSITORY_EVIDENCE_PROTOCOL,
		transcriptRevision: input.transcriptRevision.manifest,
	});
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
	const diffBlobIds = new Set(
		input.bundle.manifest.git.status === "available"
			? input.bundle.manifest.git.diffs.map((diff) => diff.blobId)
			: [],
	);
	for (const blob of input.bundle.blobs) {
		const bytes = new TextEncoder().encode(blob.content);
		if (bytes.byteLength === 0) continue;
		const object = buildObject(
			bytes,
			diffBlobIds.has(blob.id) ? "git-diff" : "source-blob",
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
	const built = {
		input: {
			capture,
			coverage: buildCoverage(input.bundle, input.transcriptRevision.delivery),
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
	createRepositoryEvidenceInitInputSchema(limits.maxAggregateBytes).parse(
		built.input,
	);
	return built;
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

export function buildRepositoryEvidenceContinuation(
	previous: BuiltRepositoryEvidenceUpload,
	plan: TranscriptRevisionPlan,
): BuiltRepositoryEvidenceUpload {
	const oldManifest = previous.objects.get(previous.input.manifestObjectId);
	if (!oldManifest) throw new Error("Missing continuation context manifest");
	const manifest: unknown = JSON.parse(
		new TextDecoder().decode(oldManifest.bytes),
	);
	if (
		typeof manifest !== "object" ||
		manifest === null ||
		!("localContext" in manifest) ||
		typeof manifest.localContext !== "object" ||
		manifest.localContext === null
	)
		throw new Error("Invalid continuation context manifest");
	const identity = createHash("sha256")
		.update(previous.input.operationId)
		.update(plan.manifest.revisionId)
		.digest("hex");
	const operationId = `${identity.slice(0, 8)}-${identity.slice(8, 12)}-4${identity.slice(13, 16)}-8${identity.slice(17, 20)}-${identity.slice(20, 32)}`;
	const nextManifest = buildObject(
		new TextEncoder().encode(
			JSON.stringify({
				...manifest,
				...("attribution" in manifest && manifest.attribution
					? {
							attribution: continueSessionAttribution(
								manifest.attribution as SessionAttributionManifest,
								operationId,
								plan.manifest,
							),
						}
					: {}),
				localContext: {
					...manifest.localContext,
					captureId: operationId,
					parentCaptureId: previous.input.capture.contextId,
				},
				transcriptRevision: plan.manifest,
			}),
		),
		"context-manifest",
		"application/json",
		FILTER_VERSION,
	);
	const objects = new Map(
		[...previous.objects].filter(
			([, object]) => object.descriptor.kind === "source-blob",
		),
	);
	objects.set(nextManifest.descriptor.objectId, nextManifest);
	for (const chunk of plan.newChunks) {
		const object = buildObject(
			chunk.bytes,
			"transcript-chunk",
			"application/x-ndjson",
			FILTER_VERSION,
		);
		objects.set(object.descriptor.objectId, object);
	}
	const input = RepositoryEvidenceInitInputSchema.parse({
		...previous.input,
		capture: {
			...previous.input.capture,
			contextId: operationId,
			parentContextId: previous.input.capture.contextId,
			transcriptWatermark: buildLegacyTranscriptWatermark(
				plan,
				previous.input.capture.transcriptWatermark?.lastEventAt ?? null,
			),
		},
		coverage: previous.input.coverage.map((item) =>
			item.area === "transcript-watermark"
				? buildTranscriptCoverage(plan.delivery)
				: item,
		),
		manifestObjectId: nextManifest.descriptor.objectId,
		objects: [...objects.values()].map((object) => object.descriptor),
		operationId,
	});
	return { input, objects };
}

export function requireRepositoryEvidenceApiKey(
	authType: RepositoryEvidenceUploadConfig["authType"],
): void {
	if (authType !== "api-key") {
		throw new Error(
			"Repository evidence requires an ingest API key; run `opaline login` to refresh your credentials.",
		);
	}
}

export async function uploadRepositoryEvidence(
	upload: BuiltRepositoryEvidenceUpload,
	config: RepositoryEvidenceUploadConfig,
): Promise<RepositoryEvidenceCommitOutput> {
	requireRepositoryEvidenceApiKey(config.authType);
	const endpoint = parseSafeApiEndpoint(config.endpoint, {
		allowPlaintext: config.allowInsecureEndpoint,
	});
	if (!endpoint.ok) {
		throw new Error(
			`Evidence upload endpoint refused: ${describeUploadEndpointRejection(endpoint)}`,
		);
	}
	const authHeaders = { "x-api-key": config.token };
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

type CoverageItem = RepositoryEvidenceInitInput["coverage"][number];
type CoverageStatus = CoverageItem["status"];

const DIFF_COMMAND_NAMES: Readonly<Record<GitDiff["kind"], string>> = {
	staged: "staged-diff",
	"working-tree": "working-diff",
};
const DIFF_LABELS: Readonly<Record<GitDiff["kind"], string>> = {
	staged: "Staged diff",
	"working-tree": "Working-tree diff",
};

function buildCoverage(
	bundle: LocalContextBundle,
	transcriptDelivery: TranscriptDeliveryState,
): RepositoryEvidenceInitInput["coverage"] {
	const facets = bundle.manifest.contextIndex.facets;
	return [
		buildGitStateCoverage(bundle),
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
		buildTaskDeltaCoverage(bundle),
		coverage(
			"referenced-evidence",
			bundle.manifest.coverage.errors.length === 0
				? null
				: "Some explicitly referenced evidence could not be captured",
		),
		buildTranscriptCoverage(transcriptDelivery),
	];
}

function buildGitStateCoverage(bundle: LocalContextBundle): CoverageItem {
	const snapshot = bundle.manifest.git;
	if (snapshot.status !== "available") {
		return incompleteCoverage("git-state", "unavailable", [
			`Git state unavailable: ${snapshot.detail}`,
		]);
	}
	const diffCommands = new Set(Object.values(DIFF_COMMAND_NAMES));
	const failedCommands = snapshot.errors
		.map(getGitErrorCommand)
		.filter((name) => !diffCommands.has(name));
	const truncatedSections = snapshot.truncatedSections.filter(
		(name) => !diffCommands.has(name),
	);
	return incompleteCoverage("git-state", "partial", [
		...(failedCommands.length > 0
			? [`Git commands failed: ${failedCommands.join(", ")}`]
			: []),
		...(truncatedSections.length > 0
			? [`Git output truncated: ${truncatedSections.join(", ")}`]
			: []),
		...getConsistencyReasons(bundle),
	]);
}

function buildTaskDeltaCoverage(bundle: LocalContextBundle): CoverageItem {
	const snapshot = bundle.manifest.git;
	if (snapshot.status !== "available") {
		return incompleteCoverage("task-delta", "unavailable", [
			`Git diff unavailable: ${snapshot.detail}`,
		]);
	}
	const outcomes = snapshot.diffs.map((diff) =>
		describeDiffOutcome(diff, snapshot),
	);
	const missing = outcomes.filter((outcome) => outcome.kind === "missing");
	const reasons = outcomes.flatMap((outcome) =>
		outcome.kind === "ok" ? [] : [outcome.reason],
	);
	const status: CoverageStatus =
		missing.length > 0 && missing.length === outcomes.length
			? "unavailable"
			: "partial";
	return incompleteCoverage("task-delta", status, [
		...reasons,
		...getConsistencyReasons(bundle),
	]);
}

type DiffOutcome =
	| { readonly kind: "ok" }
	| { readonly kind: "partial"; readonly reason: string }
	| { readonly kind: "missing"; readonly reason: string };

function describeDiffOutcome(
	diff: GitDiff,
	snapshot: GitRepositorySnapshot,
): DiffOutcome {
	const label = DIFF_LABELS[diff.kind];
	const command = DIFF_COMMAND_NAMES[diff.kind];
	if (diff.omissionReason === "empty") return { kind: "ok" };
	const failure = snapshot.errors.find(
		(error) => getGitErrorCommand(error) === command,
	);
	if (failure !== undefined) {
		return {
			kind: "missing",
			reason: `${label} unavailable: ${failure}`,
		};
	}
	if (
		diff.truncated ||
		diff.omissionReason === "truncated" ||
		snapshot.truncatedSections.includes(command)
	) {
		return {
			kind: "missing",
			reason: `${label} exceeded the capture output limit and was omitted`,
		};
	}
	if (diff.blobId === null) {
		return {
			kind: "missing",
			reason: `${label} omitted: ${diff.omissionReason ?? "unknown reason"}`,
		};
	}
	if (diff.containsBinaryChanges) {
		return {
			kind: "partial",
			reason: `${label} includes binary changes whose content is not captured`,
		};
	}
	return { kind: "ok" };
}

function getConsistencyReasons(bundle: LocalContextBundle): readonly string[] {
	switch (bundle.manifest.consistency.status) {
		case "stable":
			return [];
		case "concurrent-change":
			return ["Repository changed while it was being captured"];
		case "unavailable":
			return ["Capture consistency could not be verified"];
	}
}

function buildTranscriptCoverage(
	delivery: TranscriptDeliveryState,
): CoverageItem {
	switch (delivery.status) {
		case "complete":
			return coverage("transcript-watermark", null);
		case "deferred":
			return incompleteCoverage("transcript-watermark", "partial", [
				`Transcript delivery is bounded; ${delivery.remainingBytes} bytes remain for later captures`,
			]);
		case "blocked":
			return incompleteCoverage("transcript-watermark", "unavailable", [
				`Transcript record at byte ${delivery.recordStartByte} (${delivery.recordBytes} bytes) exceeds the delivery byte budget`,
			]);
	}
}

function getGitErrorCommand(error: string): string {
	const separator = error.indexOf(":");
	return separator < 0 ? error : error.slice(0, separator);
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

function coverage(
	area: RepositoryEvidenceCoverageArea,
	reason: string | null,
): CoverageItem {
	return reason === null
		? { area, reason: null, status: "complete" }
		: incompleteCoverage(area, "partial", [reason]);
}

function incompleteCoverage(
	area: RepositoryEvidenceCoverageArea,
	status: Exclude<CoverageStatus, "complete">,
	reasons: readonly string[],
): CoverageItem {
	if (reasons.length === 0) return { area, reason: null, status: "complete" };
	return { area, reason: reasons.join("; ").slice(0, 500), status };
}
