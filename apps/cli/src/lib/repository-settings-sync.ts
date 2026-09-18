import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ContractRouterClient } from "@orpc/contract";
import {
	parseSafeApiEndpoint,
	resolveRepoIdentity,
} from "../contracts/index.js";
import type {
	RepositoryUploadReport,
	repositorySettingsContract,
} from "../contracts/repository-settings.js";
import {
	type AutoUploadConfig,
	loadAutoUploadConfig,
} from "./auto-upload-config.js";
import { getConfigDir } from "./local-state.js";
import type { UploadRepository } from "./upload-manager-repositories.js";
import type { UploadConfig } from "./uploader.js";

// Settings sync must never prevent saving local choices or uploading sessions.
// The table refreshes when the browser regains focus after the CLI finishes.
export async function syncRepositorySettings(
	rows: Pick<UploadRepository, "key" | "problem">[],
	credentials: UploadConfig,
	signal?: AbortSignal,
): Promise<string | undefined> {
	try {
		const config = loadAutoUploadConfig();
		if (!config) return;
		const endpoint = parseSafeApiEndpoint(credentials.endpoint, {
			allowPlaintext: credentials.allowInsecureEndpoint,
		});
		if (!endpoint.ok) throw new Error("Invalid settings API endpoint");
		const input = buildRepositoryUploadReport(
			config,
			rows,
			await getInstallationId(),
		);
		const client: ContractRouterClient<typeof repositorySettingsContract> =
			createORPCClient(
				new RPCLink({
					url: `${endpoint.url.replace(/\/+$/u, "")}/repositorySettings`,
					headers:
						credentials.authType === "api-key"
							? { "x-api-key": credentials.token }
							: { Authorization: `Bearer ${credentials.token}` },
				}),
			);
		await client.report(input, {
			signal: signal
				? AbortSignal.any([signal, AbortSignal.timeout(3000)])
				: AbortSignal.timeout(3000),
		});
	} catch {
		return "Upload settings are saved locally. The web status could not sync; reopen opaline upload to retry.";
	}
}

export function buildRepositoryUploadReport(
	config: AutoUploadConfig,
	rows: Pick<UploadRepository, "key" | "problem">[],
	installationId: string,
): RepositoryUploadReport {
	const problems = new Set(
		rows.filter((row) => row.problem).map((row) => row.key),
	);
	const workspaces = new Map<
		string,
		RepositoryUploadReport["workspaces"][number]
	>();
	// Report saved choices only. Discovering an unrelated repository is not consent
	// to publish its name, path, or sessions to a workspace.
	for (const [key, setting] of Object.entries(config.repositories)) {
		const organizationId =
			setting.organizationId ?? config.defaultOrganizationId;
		if (!organizationId) continue;
		const workspace = workspaces.get(organizationId) ?? {
			organizationId,
			repositories: [],
		};
		// Worktree paths are already bound to this saved repository. Send only their
		// legacy identity, never the local paths of unrelated repositories.
		const aliases = [
			...new Set(
				setting.paths.flatMap((projectPath) => {
					const identity = resolveRepoIdentity({
						projectPath,
						gitRemote: null,
						packageName: null,
					});
					return identity.worktree && identity.repoKey !== key
						? [identity.repoKey]
						: [];
				}),
			),
		];
		workspace.repositories.push({
			key,
			name: setting.name,
			...(aliases.length ? { aliases } : {}),
			state: !setting.enabled
				? "disabled"
				: problems.has(key)
					? "needs_attention"
					: "enabled",
		});
		workspaces.set(organizationId, workspace);
	}
	return { installationId, workspaces: [...workspaces.values()] };
}

async function getInstallationId() {
	const directory = getConfigDir();
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const path = join(directory, "upload-installation-id");
	try {
		await writeFile(path, randomUUID(), { flag: "wx", mode: 0o600 });
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "EEXIST"))
			throw error;
	}
	return (await readFile(path, "utf8")).trim();
}
