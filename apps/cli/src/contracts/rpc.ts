import { oc } from "@orpc/contract";
import { z } from "zod";
import {
	IngestSessionInputSchema,
	IngestSessionOutputSchema,
	REDACTION_BUDGET_EXCEEDED_CODE,
	REDACTION_BUDGET_EXCEEDED_MESSAGE,
	REDACTION_DID_NOT_CONVERGE_CODE,
	REDACTION_DID_NOT_CONVERGE_MESSAGE,
	SECRET_FILTER_JSON_INTEGRITY_CODE,
	SECRET_FILTER_JSON_INTEGRITY_MESSAGE,
	SESSION_OWNERSHIP_CONFLICT_CODE,
	SESSION_OWNERSHIP_CONFLICT_MESSAGE,
	SESSION_UPLOAD_SHRINK_REJECTED_CODE,
	SESSION_UPLOAD_SHRINK_REJECTED_MESSAGE,
} from "./ingest.js";
import { ReportUploadFailuresInputSchema } from "./upload-failure.js";

const UserSchema = z.object({
	id: z.string(),
	email: z.string(),
	name: z.string(),
	image: z.string().nullable(),
	activeOrganizationId: z.string().nullable(),
});
const CliUserSchema = z.object({
	id: z.string(),
	email: z.string(),
	name: z.string(),
});
// Keep UUID-sized batches below common reverse-proxy URI limits.
export const CLI_SESSION_UPLOAD_STATUS_MAX_IDS = 64;

const CliSessionUploadStatusInputSchema = z.object({
	organizationId: z.string().max(200).optional(),
	sessionIds: z
		.array(z.string().min(1).max(200))
		.min(1)
		.max(CLI_SESSION_UPLOAD_STATUS_MAX_IDS)
		.refine((sessionIds) => new Set(sessionIds).size === sessionIds.length, {
			message: "Session IDs must be unique",
		}),
});

export const CliSessionUploadStatusOutputSchema = z.object({
	organizationId: z.string(),
	uploadedSessionIds: z.array(z.string()),
});
const OrganizationSchema = z.object({
	id: z.string(),
	name: z.string(),
	slug: z.string(),
	logo: z.string().nullable(),
});

export const contract = {
	me: oc.output(UserSchema),
	cli: {
		reportUploadFailures: oc
			.input(ReportUploadFailuresInputSchema)
			.output(z.object({ success: z.literal(true) })),
		authStatus: oc.output(CliUserSchema),
		setupStatus: oc.output(
			z.object({
				hasCliLogin: z.boolean(),
				hasUploadedSessions: z.boolean().optional(),
			}),
		),
		revokeToken: oc.output(z.object({ success: z.literal(true) })),
		sessionUploadStatus: oc
			.input(CliSessionUploadStatusInputSchema)
			.output(CliSessionUploadStatusOutputSchema),
	},
	listMyOrganizations: oc.output(z.array(OrganizationSchema)),
	ingestSession: oc
		.input(IngestSessionInputSchema)
		.output(IngestSessionOutputSchema)
		.errors({
			[REDACTION_BUDGET_EXCEEDED_CODE]: {
				status: 422,
				message: REDACTION_BUDGET_EXCEEDED_MESSAGE,
				data: z.object({
					inputBytes: z.number().int().nonnegative(),
					redactedBytes: z.number().int().nonnegative(),
					ruleIds: z.array(z.string()),
				}),
			},
			[REDACTION_DID_NOT_CONVERGE_CODE]: {
				status: 422,
				message: REDACTION_DID_NOT_CONVERGE_MESSAGE,
				data: z.object({ maxPasses: z.number().int().positive() }),
			},
			[SECRET_FILTER_JSON_INTEGRITY_CODE]: {
				status: 422,
				message: SECRET_FILTER_JSON_INTEGRITY_MESSAGE,
			},
			[SESSION_OWNERSHIP_CONFLICT_CODE]: {
				status: 409,
				message: SESSION_OWNERSHIP_CONFLICT_MESSAGE,
			},
			[SESSION_UPLOAD_SHRINK_REJECTED_CODE]: {
				status: 409,
				message: SESSION_UPLOAD_SHRINK_REJECTED_MESSAGE,
				data: z.object({
					currentAssistantLineCount: z.number().int().nonnegative(),
					currentContentBytes: z.number().int().nonnegative(),
					previousAssistantLineCount: z.number().int().nonnegative(),
					previousContentBytes: z.number().int().nonnegative(),
				}),
			},
		}),
};
