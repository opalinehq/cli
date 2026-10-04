import * as p from "@clack/prompts";
import { buildCommand } from "@stricli/core";
import { describeSavedCredentialsApiBaseRisk } from "../lib/api-base.js";
import { verifyAuth } from "../lib/auth.js";
import { loadFailedUploads } from "../lib/failed-uploads.js";

async function runWhoami(): Promise<undefined | Error> {
	const failedUploads = await loadFailedUploads();
	if (failedUploads.length > 0) {
		const count = (status: (typeof failedUploads)[number]["status"]) =>
			failedUploads.filter((failure) => failure.status === status).length;
		const pending = count("pending");
		p.log.warn(
			`Local upload status: ${count("retryable")} retryable failure(s), ${count("permanent")} permanent failure(s)${pending > 0 ? `, ${pending} still processing on the server` : ""}. Run \`opaline upload --retry\` for details.`,
		);
	}

	// Before verifyAuth, which sends the stored token to the stored base.
	const storedApiBaseRisk = describeSavedCredentialsApiBaseRisk();
	if (storedApiBaseRisk) {
		p.log.warn(storedApiBaseRisk);
	}

	const result = await verifyAuth();
	if (!result.authenticated) {
		if (result.reason === "no_credentials") {
			p.log.info("Not logged in. Run `opaline login` to authenticate.");
			return;
		}
		return new Error(result.message);
	}

	p.log.info(`Logged in as ${result.user.name} (${result.user.email})`);
}

export const whoamiCommand = buildCommand({
	loader: async () => ({ default: runWhoami }),
	parameters: {},
	docs: {
		brief: "Show the currently authenticated user",
	},
});
