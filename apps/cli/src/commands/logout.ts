import * as p from "@clack/prompts";
import { buildCommand } from "@stricli/core";
import { describeLogoutApiBaseRisk } from "../lib/api-base.js";
import { createApiClient } from "../lib/api-client.js";
import { clearCredentials, loadCredentials } from "../lib/credentials.js";
import { resetCliProductAnalyticsIdentity } from "../lib/product-analytics.js";

async function runLogout(flags: {
	localOnly: boolean;
}): Promise<undefined | Error> {
	const credentials = loadCredentials();
	if (!credentials) {
		p.log.info("Not logged in.");
		return;
	}

	if (credentials.authType === "api-key" && !flags.localOnly) {
		// Before createApiClient, which sends the key to the stored base.
		const storedApiBaseRisk = describeLogoutApiBaseRisk(credentials.apiBaseUrl);
		if (storedApiBaseRisk) {
			p.log.warn(storedApiBaseRisk);
		}

		try {
			const client = createApiClient(credentials);
			await client.cli.revokeToken();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return new Error(
				`Failed to revoke token on server: ${message}. Credentials were kept; retry or run \`opaline logout --local-only\`.`,
			);
		}
	}

	clearCredentials();
	resetCliProductAnalyticsIdentity();
	p.log.success(
		flags.localOnly
			? "Logged out locally. Server token was not revoked."
			: "Logged out successfully.",
	);
}

export const logoutCommand = buildCommand({
	loader: async () => ({ default: runLogout }),
	parameters: {
		flags: {
			localOnly: {
				kind: "boolean",
				brief: "Clear local credentials without revoking the server token",
				default: false,
			},
		},
	},
	docs: {
		brief: "Log out and remove stored credentials",
	},
});
