export function getSessionsDashboardUrl(
	endpoint: string,
	workspaceSlug: string,
): string {
	const path = `/${encodeURIComponent(workspaceSlug)}/sessions`;
	return getWebUrl(endpoint, path);
}

export function getSetupContinueUrl(endpoint: string): string {
	return getWebUrl(endpoint, "/welcome");
}

function getWebUrl(endpoint: string, path: string): string {
	const url = new URL(endpoint);
	if (
		url.hostname === "app.rudel.ai" ||
		url.hostname === "rudel.numia.workers.dev"
	)
		return new URL(path, "https://opaline.so").href;
	return new URL(path, url.origin).href;
}
