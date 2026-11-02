import type { Credentials } from "../credentials.js";
import { resolveUploadOrganizationId } from "../upload-organization.js";

interface Organization {
	readonly id: string;
	readonly slug: string;
}

export async function resolveBridgeOrganizationId(input: {
	readonly slug: string | undefined;
	readonly credentials: Credentials;
	readonly listOrganizations: () => Promise<readonly Organization[]>;
}): Promise<string> {
	if (input.slug !== undefined)
		return findBySlug(input.slug, await organizationsOf(input));
	const organizationId = await resolveUploadOrganizationId({
		explicit: undefined,
		recorded: undefined,
		projectPath: process.cwd(),
		credentials: input.credentials,
	});
	if (organizationId) return organizationId;
	throw new Error(
		"Choose a workspace with --workspace <slug> or `opaline set-org`.",
	);
}

async function organizationsOf(input: {
	readonly credentials: Credentials;
	readonly listOrganizations: () => Promise<readonly Organization[]>;
}): Promise<readonly Organization[]> {
	return input.credentials.authType === "api-key"
		? (input.credentials.organizations ?? [])
		: await input.listOrganizations();
}

function findBySlug(
	slug: string,
	organizations: readonly Organization[],
): string {
	const match = organizations.find(
		(organization) => organization.slug === slug,
	);
	if (match) return match.id;
	const known = organizations
		.map((organization) => organization.slug)
		.join(", ");
	throw new Error(
		`No workspace "${slug}" for this login.${known ? ` Yours: ${known}.` : ""}`,
	);
}
