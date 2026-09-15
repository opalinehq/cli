import { buildCommand } from "@stricli/core";
import { CliConnectionSecretSchema } from "../contracts/index.js";
import { allowsPlaintext, resolveApiBase } from "../lib/api-base.js";
import { getDefaultApiBase } from "../lib/api-target.js";
import { connectBrowser } from "../lib/cli-connection.js";
import { createGuidedUpload } from "../lib/guided-upload.js";
import { runUpload } from "./upload.js";

async function runConnect(flags: {
	code: string;
	apiBase: string;
	allowInsecureApiBase: boolean;
	noBrowser: boolean;
}): Promise<undefined | Error> {
	if (!CliConnectionSecretSchema.safeParse(flags.code).success)
		return new Error(
			"Invalid connection code. Copy the command again from Opaline.",
		);
	if (!process.stdin.isTTY || !process.stdout.isTTY)
		return new Error(
			"Run this command in an interactive terminal to select repositories.",
		);
	const resolved = resolveApiBase(
		flags.apiBase,
		allowsPlaintext(flags.allowInsecureApiBase),
	);
	if (!resolved.ok)
		return new Error(
			"Invalid API address. Use an HTTPS address or a local development server.",
		);
	let guided: ReturnType<typeof createGuidedUpload> | undefined;
	let failure: Error | undefined;
	try {
		const connection = await connectBrowser(resolved.url, flags.code);
		guided = createGuidedUpload(connection, {
			...flags,
			apiBase: resolved.url,
		});
		failure = await runUpload(guided);
	} catch (error) {
		failure = error instanceof Error ? error : new Error(String(error));
	} finally {
		try {
			await guided?.close(failure);
		} catch (error) {
			failure ??= error instanceof Error ? error : new Error(String(error));
		}
	}
	return failure;
}

export const connectCommand = buildCommand({
	loader: async () => ({ default: runConnect }),
	parameters: {
		flags: {
			code: {
				kind: "parsed",
				parse: String,
				brief: "One-time code copied from Opaline",
			},
			apiBase: {
				kind: "parsed",
				parse: String,
				default: getDefaultApiBase(),
				brief: "API server base URL",
			},
			allowInsecureApiBase: {
				kind: "boolean",
				default: false,
				brief: "Allow a plaintext self-hosted server",
			},
			noBrowser: {
				kind: "boolean",
				default: false,
				brief: "Print the setup link without opening a browser",
			},
		},
	},
	docs: { brief: "Connect your selected repositories to browser setup" },
});
