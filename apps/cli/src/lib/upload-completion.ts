import {
	getSessionsDashboardUrl,
	getSetupContinueUrl,
} from "./dashboard-url.js";

export type UploadCompletion =
	| { kind: "setup"; url: string }
	| {
			kind: "sessions";
			dashboards: Array<{ organizationId: string; url: string }>;
	  };

export function getUploadCompletion(
	endpoint: string,
	hasPreviousUploads: boolean,
	workspaces: Array<{ id: string; slug: string }>,
): UploadCompletion {
	if (!hasPreviousUploads)
		return { kind: "setup", url: getSetupContinueUrl(endpoint) };
	return {
		kind: "sessions",
		dashboards: workspaces.map((workspace) => ({
			organizationId: workspace.id,
			url: getSessionsDashboardUrl(endpoint, workspace.slug),
		})),
	};
}
