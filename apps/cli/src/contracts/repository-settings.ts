import { oc } from "@orpc/contract";
import { z } from "zod";

const UploadStateSchema = z.enum(["enabled", "disabled", "needs_attention"]);
const RepositoryUploadSettingSchema = z.object({
	key: z.string().min(1).max(2048),
	name: z.string().min(1).max(256),
	aliases: z.array(z.string().min(1).max(2048)).max(1000).optional(),
	state: UploadStateSchema,
});
const RepositoryUploadSettingsSchema = z
	.array(RepositoryUploadSettingSchema)
	.max(10000)
	.refine(
		(repositories) =>
			new Set(repositories.map((repo) => repo.key)).size ===
			repositories.length,
		"Duplicate repository",
	);
export const RepositoryUploadReportSchema = z
	.object({
		installationId: z.string().uuid(),
		workspaces: z
			.array(
				z.object({
					organizationId: z.string().min(1).max(256),
					repositories: RepositoryUploadSettingsSchema,
				}),
			)
			.max(100),
	})
	.refine(
		(input) =>
			input.workspaces.reduce(
				(sum, workspace) => sum + workspace.repositories.length,
				0,
			) <= 10000,
		"Too many repositories",
	);

export type RepositoryUploadReport = z.infer<
	typeof RepositoryUploadReportSchema
>;
export const repositorySettingsContract = {
	report: oc
		.input(RepositoryUploadReportSchema)
		.output(z.object({ success: z.literal(true) })),
};
