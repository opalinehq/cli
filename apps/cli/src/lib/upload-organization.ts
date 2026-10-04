import { loadAutoUploadConfig } from "./auto-upload-config.js";
import type { Credentials } from "./credentials.js";
import { getDefaultProjectOrgId, getProjectOrgId } from "./project-config.js";

/**
 * The workspace for an import or retry, in order: an explicit --org, the
 * session's own (recorded with the failure, or mapped for its folder), the
 * default chosen with `opaline set-org`, the default chosen for automatic
 * uploads, and the only workspace of an account that belongs to exactly one.
 * Undefined otherwise: the server then uses the personal or only workspace
 * and refuses to guess between several (reported as retryable).
 */
export async function resolveUploadOrganizationId(input: {
	readonly explicit: string | undefined;
	readonly recorded: string | undefined;
	readonly projectPath: string;
	readonly credentials: Pick<Credentials, "organizations"> | null;
}): Promise<string | undefined> {
	const mapped =
		input.explicit ??
		input.recorded ??
		(await getProjectOrgId(input.projectPath)) ??
		getDefaultProjectOrgId() ??
		readAutoUploadDefault();
	if (mapped !== undefined) return mapped;
	const organizations = input.credentials?.organizations ?? [];
	return organizations.length === 1 ? organizations[0]?.id : undefined;
}

function readAutoUploadDefault(): string | undefined {
	try {
		return loadAutoUploadConfig()?.defaultOrganizationId;
	} catch {
		return undefined;
	}
}
