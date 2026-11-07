import { z } from "zod";

export const CLI_DATA_PLAN_MAX_SESSIONS = 5000;
export const CLI_DATA_TABLE_MAX_SESSIONS = 200;

export const CLI_DATA_TABLES = [
	"records",
	"runs",
	"calls",
	"git",
	"edges",
	"ci_jobs",
	"setup_files",
	"setup_texts",
	"github_prs",
	"github_pr_commits",
	"github_ci_run_prs",
	"github_ci_runs",
	"github_sha_candidates",
	"github_repositories",
] as const;

export const CliDataTableSchema = z.enum(CLI_DATA_TABLES);

export const CliDataFormatSchema = z.enum(["jsonl", "csv"]);

const WorkspaceSchema = z.string().min(1).max(200).optional();

export const DataChunkSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("lines"), text: z.string() }),
	z.object({
		type: z.literal("done"),
		rows: z.number().int().nonnegative(),
		bytes: z.number().int().nonnegative(),
		columns: z.array(z.string()),
		notices: z.array(z.string()),
	}),
]);

export const CliDataSqlInputSchema = z.object({
	workspace: WorkspaceSchema,
	query: z.string().min(1),
	format: CliDataFormatSchema,
});

export const CliDataPullPlanInputSchema = z.object({
	workspace: WorkspaceSchema,
	repository: z.string().min(1).optional(),
	from: z.string().optional(),
	to: z.string().optional(),
	sessions: z
		.array(z.string().min(1).max(200))
		.max(CLI_DATA_PLAN_MAX_SESSIONS)
		.optional(),
	pattern: z.string().min(1).optional(),
});

export const CliDataPullPlanSessionSchema = z.object({
	sessionId: z.string(),
	source: z.string(),
	startedAt: z.string(),
	records: z.number().int().nonnegative(),
	bytes: z.number().int().nonnegative(),
});

export const CliDataPullPlanOutputSchema = z.object({
	workspace: z.object({ id: z.string(), slug: z.string() }),
	scope: z.object({
		repository: z.string().nullish(),
		from: z.string().nullish(),
		to: z.string().nullish(),
	}),
	sessions: z.array(CliDataPullPlanSessionSchema),
	pattern: z.unknown().nullable(),
	notices: z.array(z.string()),
});

export const CliDataPullTableInputSchema = z.object({
	workspace: WorkspaceSchema,
	table: CliDataTableSchema,
	sessions: z
		.array(z.string().min(1).max(200))
		.min(1)
		.max(CLI_DATA_TABLE_MAX_SESSIONS),
});

export type CliDataTable = z.infer<typeof CliDataTableSchema>;
export type CliDataFormat = z.infer<typeof CliDataFormatSchema>;
export type DataChunk = z.infer<typeof DataChunkSchema>;
export type DataDone = Extract<DataChunk, { type: "done" }>;
export type CliDataSqlInput = z.input<typeof CliDataSqlInputSchema>;
export type CliDataPullPlanInput = z.input<typeof CliDataPullPlanInputSchema>;
export type CliDataPullPlan = z.infer<typeof CliDataPullPlanOutputSchema>;
export type CliDataPullPlanSession = z.infer<
	typeof CliDataPullPlanSessionSchema
>;
export type CliDataPullTableInput = z.input<typeof CliDataPullTableInputSchema>;
