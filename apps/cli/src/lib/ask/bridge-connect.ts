import { ORPCError } from "@orpc/client";
import type { AskBridgeConnection } from "../../contracts/ask.js";
import { createApiClient } from "../api-client.js";
import { getApiBaseOverride } from "../api-target.js";
import type { Credentials } from "../credentials.js";
import { resolveBridgeOrganizationId } from "./bridge-workspace.js";
import { loadDeviceId } from "./device-id.js";

export type BridgeConnect = () => Promise<AskBridgeConnection>;

export function askApiBase(credentials: Credentials): string {
	return getApiBaseOverride() ?? credentials.apiBaseUrl;
}

export async function bridgeConnectFor(input: {
	readonly credentials: Credentials;
	readonly apiBaseUrl: string;
	readonly workspaceSlug?: string;
	readonly organizationId?: string;
}): Promise<BridgeConnect> {
	const api = createApiClient({
		...input.credentials,
		apiBaseUrl: input.apiBaseUrl,
	});
	const organizationId =
		input.organizationId ??
		(await resolveBridgeOrganizationId({
			slug: input.workspaceSlug,
			credentials: input.credentials,
			listOrganizations: () => api.listMyOrganizations(),
		}));
	const deviceId = await loadDeviceId();
	return () => api.ask.bridgeConnect({ organizationId, deviceId });
}

export function isAskUnavailable(error: unknown): boolean {
	return (
		error instanceof ORPCError &&
		(error.code === "FORBIDDEN" || error.code === "PRECONDITION_FAILED")
	);
}

export function describeAskError(error: unknown, apiBaseUrl: string): string {
	if (error instanceof ORPCError && error.code === "FORBIDDEN")
		return "Ask is not turned on for this workspace, or you are not a member of it.";
	if (error instanceof ORPCError && error.code === "PRECONDITION_FAILED")
		return "Ask is not available on this Opaline server yet.";
	if (error instanceof TypeError && error.message === "fetch failed")
		return `Could not reach Opaline at ${apiBaseUrl}.`;
	return error instanceof Error ? error.message : String(error);
}
