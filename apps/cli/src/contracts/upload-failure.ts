import { z } from "zod";
import { SourceSchema } from "./source.js";

// Diagnostics only: transcripts and upload credentials never belong here.
export const UploadFailureSchema = z.object({
	sessionId: z.string().min(1).max(200),
	source: SourceSchema,
	repository: z.string().max(200),
	projectPath: z.string().max(200),
	gitRemote: z.string().max(200).optional(),
	gitBranch: z.string().max(200).optional(),
	gitSha: z.string().max(200).optional(),
	packageName: z.string().max(200).optional(),
	cliVersion: z.string().max(200).optional(),
	sessionDate: z.string().datetime().nullable(),
	totalBytes: z
		.number()
		.int()
		.nonnegative()
		.max(Number.MAX_SAFE_INTEGER)
		.nullable(),
	uploadedBytes: z
		.number()
		.int()
		.nonnegative()
		.max(Number.MAX_SAFE_INTEGER)
		.nullable(),
	maxBytes: z.number().int().nonnegative().optional(),
	stage: z.enum(["preparing", "uploading", "processing"]),
	error: z.string().min(1).max(4000),
	retryable: z.boolean(),
	attempts: z.number().int().nonnegative().max(1000),
});
export type UploadFailure = z.infer<typeof UploadFailureSchema>;
export const ReportUploadFailuresInputSchema = z.object({
	organizationId: z.string().min(1).max(200),
	failures: z.array(UploadFailureSchema).min(1).max(64),
});
