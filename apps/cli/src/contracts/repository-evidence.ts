import { z } from "zod";
import { SourceSchema } from "./source.js";

export const REPOSITORY_EVIDENCE_PROTOCOL = "repository_evidence_v1" as const;
export const REPOSITORY_EVIDENCE_PART_SIZE_BYTES = 8 * 1024 * 1024;
export const REPOSITORY_EVIDENCE_MAX_OBJECT_BYTES = 64 * 1024 * 1024;
export const REPOSITORY_EVIDENCE_MAX_AGGREGATE_BYTES = 128 * 1024 * 1024;
export const REPOSITORY_EVIDENCE_MAX_OBJECTS = 4_096;

const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/u;
const CONTENT_OBJECT_ID_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const LOCAL_REPOSITORY_ID_PATTERN = /^local-repository:[a-f0-9]{64}$/u;
const LOCAL_WORKTREE_ID_PATTERN = /^local-worktree:[a-f0-9]{64}$/u;
const GIT_COMMIT_SHA_PATTERN = /^[a-f0-9]{40}$/u;

const BoundedIdentitySchema = z.string().trim().min(1).max(200);
const EvidenceTimestampSchema = z.string().datetime({ offset: true });

export const RepositoryEvidenceObjectIdSchema = z
	.string()
	.regex(CONTENT_OBJECT_ID_PATTERN);

export const RepositoryEvidenceLocalIdentitySchema = z.object({
	installationId: z.string().uuid(),
	repositoryId: z.string().regex(LOCAL_REPOSITORY_ID_PATTERN),
	worktreeId: z.string().regex(LOCAL_WORKTREE_ID_PATTERN),
});

export const RepositoryEvidenceProviderIdentitySchema = z.object({
	host: z
		.string()
		.trim()
		.min(1)
		.max(253)
		.transform((host) => host.toLowerCase()),
	name: z.string().trim().min(1).max(100),
	nodeId: z.string().trim().min(1).max(200),
	owner: z.string().trim().min(1).max(100),
	provider: z.literal("github"),
	repositoryId: z.string().regex(/^[1-9][0-9]*$/u),
});

export const RepositoryEvidenceRemoteHintSchema = z.object({
	host: z
		.string()
		.trim()
		.min(1)
		.max(253)
		.transform((host) => host.toLowerCase()),
	name: z.string().trim().min(1).max(100),
	owner: z.string().trim().min(1).max(100),
	provider: z.literal("github"),
});

export const RepositoryEvidenceRepositoryIdentitySchema = z.object({
	local: RepositoryEvidenceLocalIdentitySchema,
	provider: RepositoryEvidenceProviderIdentitySchema.nullable(),
	remoteHint: RepositoryEvidenceRemoteHintSchema.nullable().default(null),
});

export const RepositoryEvidenceSessionIdentitySchema = z.object({
	agentId: BoundedIdentitySchema.nullable(),
	parentAgentId: BoundedIdentitySchema.nullable(),
	runId: BoundedIdentitySchema,
	segmentId: BoundedIdentitySchema,
	sessionId: BoundedIdentitySchema,
	source: SourceSchema,
});

export const RepositoryEvidenceTranscriptWatermarkSchema = z.object({
	byteOffset: z.number().int().nonnegative(),
	eventOrdinal: z.number().int().nonnegative(),
	lastEventAt: EvidenceTimestampSchema.nullable(),
});

export const RepositoryEvidenceCaptureTimingSchema = z
	.object({
		captureCompletedAt: EvidenceTimestampSchema,
		captureStartedAt: EvidenceTimestampSchema,
		firstActionAt: EvidenceTimestampSchema.nullable(),
		firstActionBasis: z.enum([
			"native-hook",
			"transcript-watermark",
			"unavailable",
		]),
		firstActionRelationship: z.enum([
			"before-first-action",
			"after-first-action",
			"unknown",
		]),
		lifecycle: z.enum(["start", "resume", "checkpoint", "end"]),
	})
	.superRefine((timing, context) => {
		const startedAt = Date.parse(timing.captureStartedAt);
		const completedAt = Date.parse(timing.captureCompletedAt);
		if (completedAt < startedAt) {
			context.addIssue({
				code: "custom",
				message: "Capture completion cannot precede capture start",
				path: ["captureCompletedAt"],
			});
		}
		if (
			timing.firstActionRelationship === "after-first-action" &&
			timing.firstActionAt === null
		) {
			context.addIssue({
				code: "custom",
				message:
					"An after-first-action relationship requires a first-action timestamp",
				path: ["firstActionAt"],
			});
		}
		if (
			timing.firstActionRelationship === "before-first-action" &&
			timing.firstActionAt === null &&
			timing.firstActionBasis !== "native-hook"
		) {
			context.addIssue({
				code: "custom",
				message:
					"Before-first-action timing without a timestamp requires a native hook",
				path: ["firstActionBasis"],
			});
		}
		if (
			timing.firstActionRelationship === "unknown" &&
			timing.firstActionBasis !== "unavailable"
		) {
			context.addIssue({
				code: "custom",
				message:
					"Unknown first-action timing must declare an unavailable basis",
				path: ["firstActionBasis"],
			});
		}
	});

export const RepositoryEvidenceCoverageAreaSchema = z.enum([
	"git-state",
	"effective-instructions",
	"available-skills",
	"package-configuration",
	"task-delta",
	"referenced-evidence",
	"transcript-watermark",
]);

export const RepositoryEvidenceCoverageItemSchema = z
	.object({
		area: RepositoryEvidenceCoverageAreaSchema,
		reason: z.string().trim().min(1).max(500).nullable(),
		status: z.enum(["complete", "partial", "unavailable"]),
	})
	.superRefine((coverage, context) => {
		if (coverage.status === "complete" && coverage.reason !== null) {
			context.addIssue({
				code: "custom",
				message: "Complete coverage cannot include a missing-coverage reason",
				path: ["reason"],
			});
		}
		if (coverage.status !== "complete" && coverage.reason === null) {
			context.addIssue({
				code: "custom",
				message: "Incomplete coverage requires an explicit reason",
				path: ["reason"],
			});
		}
	});

export const RepositoryEvidenceObjectKindSchema = z.enum([
	"context-manifest",
	"source-blob",
	"git-diff",
	"transcript-chunk",
	"ci-metadata",
	"ci-log",
]);

export const RepositoryEvidenceObjectDescriptorSchema = z
	.object({
		byteLength: z
			.number()
			.int()
			.positive()
			.max(REPOSITORY_EVIDENCE_MAX_OBJECT_BYTES),
		contentEncoding: z.enum(["identity", "gzip"]),
		filterVersion: z.number().int().nonnegative().max(65_535).nullable(),
		kind: RepositoryEvidenceObjectKindSchema,
		mediaType: z.string().trim().min(1).max(200),
		objectId: RepositoryEvidenceObjectIdSchema,
		sha256: z.string().regex(SHA256_HEX_PATTERN),
	})
	.superRefine((object, context) => {
		if (object.objectId !== `sha256:${object.sha256}`) {
			context.addIssue({
				code: "custom",
				message: "Object ID must contain the declared SHA-256 digest",
				path: ["objectId"],
			});
		}
	});

export const RepositoryEvidenceCaptureSchema = z.object({
	baseGitCommit: z.string().regex(GIT_COMMIT_SHA_PATTERN).nullable(),
	contextId: z.string().uuid(),
	headGitCommit: z.string().regex(GIT_COMMIT_SHA_PATTERN).nullable(),
	parentContextId: z.string().uuid().nullable(),
	timing: RepositoryEvidenceCaptureTimingSchema,
	transcriptWatermark: RepositoryEvidenceTranscriptWatermarkSchema.nullable(),
});

export function createRepositoryEvidenceInitInputSchema(
	maxAggregateBytes = REPOSITORY_EVIDENCE_MAX_AGGREGATE_BYTES,
) {
	return z
		.object({
			capture: RepositoryEvidenceCaptureSchema,
			coverage: z
				.array(RepositoryEvidenceCoverageItemSchema)
				.min(1)
				.max(RepositoryEvidenceCoverageAreaSchema.options.length),
			manifestObjectId: RepositoryEvidenceObjectIdSchema,
			objects: z
				.array(RepositoryEvidenceObjectDescriptorSchema)
				.min(1)
				.max(REPOSITORY_EVIDENCE_MAX_OBJECTS),
			operationId: z.string().uuid(),
			organizationId: BoundedIdentitySchema,
			protocol: z.literal(REPOSITORY_EVIDENCE_PROTOCOL),
			repository: RepositoryEvidenceRepositoryIdentitySchema,
			session: RepositoryEvidenceSessionIdentitySchema,
		})
		.superRefine((input, context) => {
			const objectIds = input.objects.map((object) => object.objectId);
			if (new Set(objectIds).size !== objectIds.length) {
				context.addIssue({
					code: "custom",
					message: "Evidence object IDs must be unique",
					path: ["objects"],
				});
			}
			const manifest = input.objects.find(
				(object) => object.objectId === input.manifestObjectId,
			);
			if (manifest?.kind !== "context-manifest") {
				context.addIssue({
					code: "custom",
					message:
						"Manifest object ID must reference a context-manifest descriptor",
					path: ["manifestObjectId"],
				});
			}
			const coverageAreas = input.coverage.map((item) => item.area);
			if (new Set(coverageAreas).size !== coverageAreas.length) {
				context.addIssue({
					code: "custom",
					message: "Evidence coverage areas must be unique",
					path: ["coverage"],
				});
			}
			const aggregateBytes = input.objects.reduce(
				(total, object) => total + object.byteLength,
				0,
			);
			if (aggregateBytes > maxAggregateBytes) {
				context.addIssue({
					code: "custom",
					message: `Aggregate evidence exceeds ${maxAggregateBytes} bytes`,
					path: ["objects"],
				});
			}
		});
}

export const RepositoryEvidenceInitInputSchema =
	createRepositoryEvidenceInitInputSchema();

export const RepositoryEvidenceUploadPartSchema = z.object({
	byteLength: z.number().int().positive(),
	headers: z.object({ "Content-Length": z.string().regex(/^[1-9][0-9]*$/u) }),
	partNumber: z.number().int().min(1).max(10_000),
	uploadUrl: z.string().url(),
});

export const RepositoryEvidenceUploadObjectSchema = z.object({
	byteLength: z.number().int().positive(),
	objectId: RepositoryEvidenceObjectIdSchema,
	objectKey: z.string().trim().min(1).max(1_024),
	parts: z.array(RepositoryEvidenceUploadPartSchema).min(1).max(10_000),
	uploadId: z.string().trim().min(1).max(1_024),
});

export const RepositoryEvidenceInitOutputSchema = z.object({
	expiresAt: EvidenceTimestampSchema,
	missingObjects: z
		.array(RepositoryEvidenceUploadObjectSchema)
		.max(REPOSITORY_EVIDENCE_MAX_OBJECTS),
	partSizeBytes: z.literal(REPOSITORY_EVIDENCE_PART_SIZE_BYTES),
	protocol: z.literal(REPOSITORY_EVIDENCE_PROTOCOL),
	reusedObjectIds: z
		.array(RepositoryEvidenceObjectIdSchema)
		.max(REPOSITORY_EVIDENCE_MAX_OBJECTS),
	uploadReceiptId: z.string().uuid(),
});

export const RepositoryEvidenceCompletedPartSchema = z.object({
	etag: z.string().trim().min(1).max(512),
	partNumber: z.number().int().min(1).max(10_000),
});

export const RepositoryEvidenceCompletedObjectSchema = z.object({
	objectId: RepositoryEvidenceObjectIdSchema,
	objectKey: z.string().trim().min(1).max(1_024),
	parts: z
		.array(RepositoryEvidenceCompletedPartSchema)
		.min(1)
		.max(10_000)
		.refine(
			(parts) =>
				new Set(parts.map((part) => part.partNumber)).size === parts.length,
			{ message: "Completed part numbers must be unique per object" },
		),
	uploadId: z.string().trim().min(1).max(1_024),
});

export const RepositoryEvidenceCommitInputSchema = z
	.object({
		organizationId: BoundedIdentitySchema,
		objects: z
			.array(RepositoryEvidenceCompletedObjectSchema)
			.max(REPOSITORY_EVIDENCE_MAX_OBJECTS),
		uploadReceiptId: z.string().uuid(),
	})
	.superRefine((input, context) => {
		const objectIds = input.objects.map((object) => object.objectId);
		if (new Set(objectIds).size !== objectIds.length) {
			context.addIssue({
				code: "custom",
				message: "Completed evidence object IDs must be unique",
				path: ["objects"],
			});
		}
	});

export const RepositoryEvidenceCommitOutputSchema = z.object({
	acceptedAt: EvidenceTimestampSchema,
	contextId: z.string().uuid(),
	manifestObjectId: RepositoryEvidenceObjectIdSchema,
	protocol: z.literal(REPOSITORY_EVIDENCE_PROTOCOL),
	receiptId: z.string().uuid(),
	status: z.enum(["accepted", "duplicate"]),
	storedObjectIds: z
		.array(RepositoryEvidenceObjectIdSchema)
		.max(REPOSITORY_EVIDENCE_MAX_OBJECTS),
	uploadReceiptId: z.string().uuid(),
});

export type RepositoryEvidenceCapture = z.infer<
	typeof RepositoryEvidenceCaptureSchema
>;
export type RepositoryEvidenceCoverageArea = z.infer<
	typeof RepositoryEvidenceCoverageAreaSchema
>;
export type RepositoryEvidenceCommitInput = z.infer<
	typeof RepositoryEvidenceCommitInputSchema
>;
export type RepositoryEvidenceCommitOutput = z.infer<
	typeof RepositoryEvidenceCommitOutputSchema
>;
export type RepositoryEvidenceInitInput = z.infer<
	typeof RepositoryEvidenceInitInputSchema
>;
export type RepositoryEvidenceInitOutput = z.infer<
	typeof RepositoryEvidenceInitOutputSchema
>;
export type RepositoryEvidenceLocalIdentity = z.infer<
	typeof RepositoryEvidenceLocalIdentitySchema
>;
export type RepositoryEvidenceProviderIdentity = z.infer<
	typeof RepositoryEvidenceProviderIdentitySchema
>;
export type RepositoryEvidenceRemoteHint = z.infer<
	typeof RepositoryEvidenceRemoteHintSchema
>;
export type RepositoryEvidenceObjectDescriptor = z.infer<
	typeof RepositoryEvidenceObjectDescriptorSchema
>;
export type RepositoryEvidenceUploadObject = z.infer<
	typeof RepositoryEvidenceUploadObjectSchema
>;
export type RepositoryEvidenceRepositoryIdentity = z.infer<
	typeof RepositoryEvidenceRepositoryIdentitySchema
>;
export type RepositoryEvidenceSessionIdentity = z.infer<
	typeof RepositoryEvidenceSessionIdentitySchema
>;
