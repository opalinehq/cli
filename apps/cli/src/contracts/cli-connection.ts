import { z } from "zod";

export const CLI_CONNECTION_PATH = "/api/cli/connections";
export const CLI_CONNECTION_CODE_TTL_MS = 10 * 60_000;
export const CLI_CONNECTION_TTL_MS = 2 * 60 * 60_000;
export const CliConnectionSecretSchema = z
	.string()
	.regex(/^[A-Za-z0-9_-]{43}$/u);
export const CliConnectionIdSchema = z.string().uuid();
const count = z.number().int().min(0).max(10_000_000);
export const CliConnectionRepositorySchema = z
	.object({
		id: z.string().uuid(),
		name: z
			.string()
			.trim()
			.min(1)
			.max(160)
			.refine(
				(name) =>
					Array.from(name).every(
						(character) =>
							character.charCodeAt(0) > 31 && character.charCodeAt(0) !== 127,
					),
				"Control characters are not allowed",
			),
		sessionCount: count,
		enabled: z.boolean(),
		sources: z
			.array(z.enum(["claude_code", "codex"]))
			.min(1)
			.max(2),
	})
	.strict();
export const CliConnectionRepositoriesSchema = z
	.array(CliConnectionRepositorySchema)
	.max(1_000)
	.refine(
		(repositories) =>
			new Set(repositories.map(({ id }) => id)).size === repositories.length,
		"Repository IDs must be unique",
	);
export const CliConnectionTotalsSchema = z
	.object({
		uploaded: count,
		skipped: count,
		failed: count,
	})
	.strict();
export const CliConnectionStateSchema = z.enum([
	"waiting",
	"scanning",
	"awaiting_login",
	"ready",
	"uploading",
	"completed",
	"failed",
	"cancelled",
	"expired",
]);
export const CliConnectionSnapshotSchema = z
	.object({
		id: CliConnectionIdSchema,
		browserOrigin: z.string().url(),
		state: CliConnectionStateSchema,
		revision: z.number().int().nonnegative(),
		createdAt: z.string().datetime(),
		expiresAt: z.string().datetime(),
		lastSeenAt: z.string().datetime(),
		repositories: CliConnectionRepositoriesSchema,
		organizationId: z.string().min(1).nullable(),
		totals: CliConnectionTotalsSchema.nullable(),
		failureReason: z
			.enum([
				"upload_failed",
				"hook_setup_failed",
				"connection_failed",
				"login_failed",
			])
			.nullable(),
	})
	.strict();
export const CliConnectionCreateResponseSchema = z
	.object({
		connection: CliConnectionSnapshotSchema,
		code: CliConnectionSecretSchema,
		codeExpiresAt: z.string().datetime(),
	})
	.strict();
export const CliConnectionRedeemSchema = z
	.object({
		code: CliConnectionSecretSchema,
		writerToken: CliConnectionSecretSchema,
	})
	.strict();
export const CliConnectionUpdateSchema = z
	.object({
		writerToken: CliConnectionSecretSchema,
		sequence: z.number().int().positive(),
		update: z.discriminatedUnion("kind", [
			z
				.object({
					kind: z.literal("selection"),
					repositories: CliConnectionRepositoriesSchema,
				})
				.strict(),
			z
				.object({
					kind: z.literal("device"),
					deviceCode: z.string().min(1).max(256),
				})
				.strict(),
			z
				.object({
					kind: z.literal("bind"),
					organizationId: z.string().min(1).max(128),
				})
				.strict(),
			z.object({ kind: z.literal("heartbeat") }).strict(),
			z
				.object({
					kind: z.literal("status"),
					state: z.enum(["uploading", "completed", "failed", "cancelled"]),
					totals: CliConnectionTotalsSchema.optional(),
					failureReason:
						CliConnectionSnapshotSchema.shape.failureReason.optional(),
				})
				.strict(),
		]),
	})
	.strict();
export const CliConnectionAuthorizeSchema = z
	.object({
		userCode: z.string().min(1).max(256),
		organizationId: z.string().min(1).max(128),
	})
	.strict();
export type CliConnectionSnapshot = z.infer<typeof CliConnectionSnapshotSchema>;
export type CliConnectionRepository = z.infer<
	typeof CliConnectionRepositorySchema
>;
export type CliConnectionUpdate = z.infer<typeof CliConnectionUpdateSchema>;
export function isCliConnectionTerminal(
	state: CliConnectionSnapshot["state"],
): boolean {
	return ["completed", "failed", "cancelled", "expired"].includes(state);
}
