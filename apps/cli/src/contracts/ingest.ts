import { z } from "zod";
import {
	ProductAnalyticsClientSurfaceSchema,
	ProductAnalyticsPlatformOsSchema,
	ProductAnalyticsUploadModeSchema,
} from "./product-analytics.js";
import { SourceSchema } from "./source.js";

/** Per-session limit on the slimmed, filtered upload (main plus subagents). */
export const INGEST_AGGREGATE_CONTENT_MAX_BYTES = 256 * 1024 * 1024;
/**
 * The largest session the direct `ingestSession` request carries (the API caps
 * request bodies at 160 MiB), and the per-session limit servers enforced
 * before 256 MiB. Larger sessions upload only through R2.
 */
export const INGEST_DIRECT_CONTENT_MAX_BYTES = 128 * 1024 * 1024;
export const INGEST_MAX_SUBAGENT_COUNT = 512;
export const INGEST_LIMIT_REASONS = {
	requestLimit: "request_limit",
	byteLimit: "byte_limit",
	sessionLimit: "session_limit",
	transcriptTooLarge: "transcript_too_large",
} as const;

const INGEST_CONTENT_MAX_CODE_UNITS = 160 * 1024 * 1024;

export const SessionTagSchema = z.enum([
	"research",
	"new_feature",
	"bug_fix",
	"refactoring",
	"documentation",
	"tests",
	"other",
]);

export const SubagentFileSchema = z.object({
	agentId: z.string().max(200),
	content: z.string().max(INGEST_CONTENT_MAX_CODE_UNITS),
});

export const IngestSessionInputSchema = z.object({
	source: SourceSchema.default("claude_code"),
	sessionId: z.string().max(200),
	projectPath: z
		.string()
		.max(200)
		.transform((path) => path.replace(/\\/g, "/")),
	gitRemote: z.string().max(200).optional(),
	packageName: z.string().max(200).optional(),
	packageType: z.string().max(200).optional(),
	gitBranch: z.string().max(200).optional(),
	gitSha: z.string().max(200).optional(),
	tag: SessionTagSchema.optional(),
	content: z.string().max(INGEST_CONTENT_MAX_CODE_UNITS),
	subagents: z
		.array(SubagentFileSchema)
		.max(INGEST_MAX_SUBAGENT_COUNT)
		.refine(
			(subagents) =>
				new Set(subagents.map((subagent) => subagent.agentId)).size ===
				subagents.length,
			{ message: "Subagent agentId values must be unique" },
		)
		.optional(),
	organizationId: z.string().max(200).optional(),
	client_surface: ProductAnalyticsClientSurfaceSchema.optional(),
	upload_mode: ProductAnalyticsUploadModeSchema.optional(),
	cli_version: z.string().max(200).optional(),
	platform_os: ProductAnalyticsPlatformOsSchema.optional(),
	filter_version: z.number().int().min(0).max(65_535).optional(),
	force_replace: z.boolean().optional(),
});

export const IngestSessionOutputSchema = z.object({
	success: z.literal(true),
	sessionId: z.string(),
	redacted: z.record(z.string(), z.number().int().nonnegative()).default({}),
	redactedBytes: z.number().int().nonnegative().optional(),
	usageChecksum: z
		.string()
		.regex(/^[a-f0-9]{64}$/u)
		.optional(),
});

export const REDACTION_BUDGET_EXCEEDED_CODE = "REDACTION_BUDGET_EXCEEDED";
export const REDACTION_BUDGET_EXCEEDED_MESSAGE =
	"Known-pattern redaction exceeded the transcript safety budget.";
export const REDACTION_DID_NOT_CONVERGE_CODE = "REDACTION_DID_NOT_CONVERGE";
export const REDACTION_DID_NOT_CONVERGE_MESSAGE =
	"Known-pattern redaction did not converge within the safety limit.";
export const SECRET_FILTER_JSON_INTEGRITY_CODE = "SECRET_FILTER_JSON_INTEGRITY";
export const SECRET_FILTER_JSON_INTEGRITY_MESSAGE =
	"Secret filtering could not preserve transcript JSON integrity.";
export const SESSION_OWNERSHIP_CONFLICT_CODE = "SESSION_OWNERSHIP_CONFLICT";
export const SESSION_OWNERSHIP_CONFLICT_MESSAGE =
	"This session belongs to another organization member and cannot be replaced.";
export const SESSION_UPLOAD_SHRINK_REJECTED_CODE =
	"SESSION_UPLOAD_SHRINK_REJECTED";
export const SESSION_UPLOAD_SHRINK_REJECTED_MESSAGE =
	"This upload is smaller than the stored session and was refused to protect existing data.";

export type IngestSessionInput = z.infer<typeof IngestSessionInputSchema>;
