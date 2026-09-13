import { randomUUID } from "node:crypto";
import * as p from "@clack/prompts";
import { buildCommand } from "@stricli/core";
import {
	type CliConnectionRepository,
	CliConnectionSecretSchema,
} from "../contracts/cli-connection.js";
import { sanitizeForTerminalDisplay } from "../contracts/index.js";
import { allowsPlaintext, resolveApiBase } from "../lib/api-base.js";
import { getDefaultApiBase } from "../lib/api-target.js";
import { connectBrowser } from "../lib/cli-connection.js";
import { loadCredentials } from "../lib/credentials.js";
import { getDefaultUploadOrganizationId } from "../lib/upload-organization.js";
import { getRepositorySessionCount } from "../lib/upload-reconciliation.js";
import { selectRepositoriesForUpload } from "../lib/upload-review.js";
import { runLogin } from "./login.js";
import {
	discoverLocalUploadRepositories,
	uploadSelectedRepositories,
} from "./upload.js";

async function runConnect(flags: {
	code?: string;
	apiBase: string;
	allowInsecureApiBase: boolean;
	noBrowser: boolean;
}): Promise<undefined | Error> {
	if (!process.stdin.isTTY)
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
	if (flags.code && !CliConnectionSecretSchema.safeParse(flags.code).success)
		return new Error(
			"Invalid connection code. Copy the command again from the demo.",
		);
	let connection: Awaited<ReturnType<typeof connectBrowser>> | undefined;
	let finished = false;
	try {
		p.intro("Opaline");
		connection = flags.code
			? await connectBrowser(resolved.url, flags.code)
			: undefined;
		const spin = p.spinner();
		spin.start("Finding local Claude Code and Codex sessions...");
		const discovery = await discoverLocalUploadRepositories();
		spin.stop(
			`Found ${discovery.repositories.length} repositories with local sessions`,
		);
		if (discovery.repositories.length === 0) {
			connection?.stop();
			await connection?.update({ kind: "status", state: "cancelled" });
			finished = true;
			p.outro(
				"No sessions could be matched to a repository. Open a Git repository in Claude Code or Codex, then try again.",
			);
			return;
		}
		const savedCredentials = connection ? null : loadCredentials("read-only");
		const savedOrganizationId = getDefaultUploadOrganizationId(
			savedCredentials?.organizations ?? [],
			savedCredentials?.user?.id,
		);
		const destination =
			savedCredentials?.organizations?.find(
				(organization) => organization.id === savedOrganizationId,
			)?.name ??
			(savedCredentials
				? "Choose your workspace after review"
				: "Choose your workspace after browser sign-in");
		const selected = await selectRepositoriesForUpload(
			discovery.repositories.map((repository) => ({
				key: repository.key,
				label: repository.label,
				pickerLabel: `${repository.label} (${getRepositorySessionCount(repository)} sessions)`,
				sessionCount: getRepositorySessionCount(repository),
				destination,
			})),
			{ dryRun: false },
		);
		if (selected === null) {
			connection?.stop();
			await connection?.update({ kind: "status", state: "cancelled" });
			finished = true;
			p.outro("Upload cancelled. Nothing uploaded.");
			return;
		}
		const selectedKeys = new Set(selected);
		const manifest: CliConnectionRepository[] = discovery.repositories.map(
			(repository) => ({
				id: randomUUID(),
				name:
					sanitizeForTerminalDisplay(repository.label).slice(0, 160) ||
					"Repository",
				sessionCount: getRepositorySessionCount(repository),
				enabled: selectedKeys.has(repository.key),
				sources: Array.from(
					new Set(repository.projects.map((project) => project.project.source)),
				),
			}),
		);
		await connection?.update({ kind: "selection", repositories: manifest });

		if (connection || !loadCredentials()) {
			const activeConnection = connection;
			const loginError = await runLogin(
				{ ...flags, apiBase: resolved.url },
				activeConnection
					? {
							id: activeConnection.id,
							browserOrigin: activeConnection.browserOrigin,
							registerDevice: (deviceCode) =>
								activeConnection.update({ kind: "device", deviceCode }),
						}
					: undefined,
			);
			if (loginError) throw loginError;
		}
		const credentials = loadCredentials();
		if (!credentials)
			throw new Error("Login did not complete. Please try again.");
		const organizations = credentials.organizations ?? [];
		const approved = connection
			? await connection.update({ kind: "heartbeat" }, credentials)
			: null;
		let organizationId =
			approved?.organizationId ??
			getDefaultUploadOrganizationId(organizations, credentials.user?.id);
		if (
			connection &&
			(!approved?.organizationId ||
				!organizations.some((org) => org.id === approved.organizationId))
		)
			throw new Error(
				"The workspace approved in your browser is unavailable. Start setup again.",
			);
		if (!organizationId) {
			if (organizations.length === 0)
				throw new Error("No workspace found. Create one in Opaline first.");
			const selectedOrganization = await p.select({
				message: "Choose your upload workspace",
				options: organizations.map((organization) => ({
					value: organization.id,
					label: organization.name,
				})),
			});
			if (p.isCancel(selectedOrganization))
				throw new Error("Workspace selection cancelled.");
			organizationId = selectedOrganization;
		}
		await connection?.update({ kind: "bind", organizationId }, credentials);
		const result = await uploadSelectedRepositories(
			{
				discovery,
				selectedKeys,
				onUploadStarted: async () =>
					connection?.update({ kind: "status", state: "uploading" }),
				onUploadFinished: async ({
					uploaded,
					skipped,
					failed,
					hookFailures,
				}) => {
					connection?.stop();
					await connection?.update({
						kind: "status",
						state: failed > 0 || hookFailures > 0 ? "failed" : "completed",
						totals: { uploaded, skipped, failed },
						failureReason:
							failed > 0
								? "upload_failed"
								: hookFailures > 0
									? "hook_setup_failed"
									: null,
					});
					finished = true;
				},
			},
			credentials,
			organizationId,
			flags.allowInsecureApiBase,
		);
		if (result) throw result;
	} catch (error) {
		connection?.stop();
		if (!finished)
			await connection
				?.update({
					kind: "status",
					state: "failed",
					failureReason: "connection_failed",
				})
				.catch(() => {});
		return error instanceof Error
			? error
			: new Error("Setup failed. Please try again.");
	} finally {
		connection?.stop();
	}
}

export const connectCommand = buildCommand({
	loader: async () => ({ default: runConnect }),
	parameters: {
		flags: {
			code: {
				kind: "parsed",
				parse: String,
				optional: true,
				brief: "One-time code copied from the Opaline demo",
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
				brief: "Print the login link without opening a browser",
			},
		},
	},
	docs: { brief: "Choose local repositories and connect them to Opaline" },
});
