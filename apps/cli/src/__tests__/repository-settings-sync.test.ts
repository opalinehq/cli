import { expect, test } from "bun:test";
import { RepositoryUploadReportSchema } from "../contracts/repository-settings.js";
import { buildRepositoryUploadReport } from "../lib/repository-settings-sync.js";

const installationId = "825785bb-1738-47f0-9f91-d566fd6848e5";

test("reports only saved repositories to their bound workspace, including disabled settings", () => {
	const input = buildRepositoryUploadReport(
		{
			version: 1,
			defaultOrganizationId: "default",
			repositories: {
				"remote:github.com/team/a": {
					name: "team/a",
					enabled: true,
					paths: ["/private/path/a"],
				},
				"remote:github.com/team/b": {
					name: "team/b",
					enabled: false,
					paths: ["/private/path/b"],
					organizationId: "other",
				},
			},
		},
		[{ key: "remote:github.com/private/never-selected" }],
		installationId,
	);
	expect(RepositoryUploadReportSchema.parse(input)).toEqual({
		installationId,
		workspaces: [
			{
				organizationId: "default",
				repositories: [
					{ key: "remote:github.com/team/a", name: "team/a", state: "enabled" },
				],
			},
			{
				organizationId: "other",
				repositories: [
					{
						key: "remote:github.com/team/b",
						name: "team/b",
						state: "disabled",
					},
				],
			},
		],
	});
	expect(JSON.stringify(input)).not.toContain("/private/path");
	expect(JSON.stringify(input)).not.toContain("never-selected");
});

test("broken hooks are not reported as enabled; disabled takes precedence over a stale problem", () => {
	const input = buildRepositoryUploadReport(
		{
			version: 1,
			defaultOrganizationId: "org",
			repositories: {
				a: { name: "a", paths: [], enabled: true },
				b: { name: "b", paths: [], enabled: false },
			},
		},
		[
			{ key: "a", problem: "Missing hook" },
			{ key: "b", problem: "Missing hook" },
		],
		installationId,
	);
	expect(input.workspaces[0]?.repositories.map((repo) => repo.state)).toEqual([
		"needs_attention",
		"disabled",
	]);
});

test("does not guess a workspace for unbound settings", () => {
	const input = buildRepositoryUploadReport(
		{
			version: 1,
			repositories: { a: { name: "a", paths: [], enabled: true } },
		},
		[],
		installationId,
	);
	expect(input.workspaces).toEqual([]);
});

test("reports confirmed worktree identities without sending local checkout paths", () => {
	const report = buildRepositoryUploadReport(
		{
			version: 1,
			repositories: {
				"remote:github.com/team/repo": {
					name: "repo",
					enabled: true,
					organizationId: "org",
					paths: [
						"/private/home/conductor/workspaces/repo/tunis",
						"/private/home/conductor/workspaces/repo/other",
						"/private/home/repo/.worktrees/topic",
					],
				},
			},
		},
		[],
		installationId,
	);
	expect(report.workspaces[0]?.repositories[0]?.aliases).toEqual(["path:repo"]);
	expect(JSON.stringify(report)).not.toContain("/private/home");
});
