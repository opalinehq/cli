import { expect, test } from "bun:test";
import { getSessionsDashboardUrl } from "../lib/dashboard-url.js";
import { getUploadCompletion } from "../lib/upload-completion.js";

test("sessions links use the selected workspace slug across production and custom origins", () => {
	expect(
		getSessionsDashboardUrl("https://opaline.so/rpc", "design-studio"),
	).toBe("https://opaline.so/design-studio/sessions");
	expect(getSessionsDashboardUrl("https://app.rudel.ai/rpc", "my-team")).toBe(
		"https://opaline.so/my-team/sessions",
	);
	expect(
		getSessionsDashboardUrl("https://rudel.numia.workers.dev/rpc", "my-team"),
	).toBe("https://opaline.so/my-team/sessions");
	expect(getSessionsDashboardUrl("http://localhost:4010/rpc", "my-team")).toBe(
		"http://localhost:4010/my-team/sessions",
	);
	expect(
		getSessionsDashboardUrl("https://sessions.example/api/rpc", "team/one"),
	).toBe("https://sessions.example/team%2Fone/sessions");
});

test("first-time uploads continue browser setup and returning users see their actual workspaces", () => {
	const workspaces = [
		{ id: "org-a", slug: "design-studio" },
		{ id: "org-b", slug: "engineering" },
	];
	expect(
		getUploadCompletion("https://app.rudel.ai/rpc", false, workspaces),
	).toEqual({
		kind: "setup",
		url: "https://opaline.so/welcome",
	});
	expect(
		getUploadCompletion("http://localhost:4010/rpc", false, workspaces),
	).toEqual({
		kind: "setup",
		url: "http://localhost:4010/welcome",
	});
	expect(
		getUploadCompletion("https://opaline.so/rpc", true, workspaces),
	).toEqual({
		kind: "sessions",
		dashboards: [
			{
				organizationId: "org-a",
				url: "https://opaline.so/design-studio/sessions",
			},
			{
				organizationId: "org-b",
				url: "https://opaline.so/engineering/sessions",
			},
		],
	});
});
