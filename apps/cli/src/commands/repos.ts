import { buildCommand, buildRouteMap } from "@stricli/core";
import { CliConnectionSecretSchema } from "../contracts/index.js";
import { allowsPlaintext, resolveApiBase } from "../lib/api-base.js";
import { getDefaultApiBase } from "../lib/api-target.js";
import { connectBrowser } from "../lib/cli-connection.js";
import { loadCredentials } from "../lib/credentials.js";
import { createGuidedUpload, type GuidedUpload } from "../lib/guided-upload.js";
import type { UploadCompletion } from "../lib/upload-completion.js";
import { getUploadAdapters } from "../lib/upload-manager-repositories.js";
import {
	reviewUploadSelection,
	type UploadManagerState,
} from "../lib/upload-manager-state.js";
import {
	prepareUploadSave,
	resolveDestinations,
	scanUploadRepositories,
	type UploadRun,
	UploadSaveError,
	type UploadSaveProgress,
} from "../lib/upload-save.js";

type ReposEvent =
	| { type: "authorize"; url: string }
	| { type: "progress"; phase: "scan" }
	| ({ type: "progress" } & UploadSaveProgress)
	| {
			type: "done";
			uploaded: number;
			failed: number;
			skipped: number;
			changes: number;
			completion:
				| { kind: "setup"; url: string }
				| { kind: "sessions"; dashboards: Array<{ url: string }> }
				| null;
	  }
	| {
			type: "error";
			code?: string;
			message: string;
			organizations?: Array<{ id: string; name: string }>;
	  };

class ReposError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
	}
}

let silenced = false;

function emit(event: ReposEvent): void {
	if (!silenced) writeJson(event);
}

function writeJson(value: unknown): void {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}

function emitError(error: unknown): Error {
	const event: ReposEvent = {
		type: "error",
		message: error instanceof Error ? error.message : String(error),
	};
	if (error instanceof ReposError) event.code = error.code;
	if (error instanceof UploadSaveError) {
		event.code = error.code;
		if (error.organizations) event.organizations = error.organizations;
	}
	emit(event);
	return error instanceof Error ? error : new Error(String(error));
}

function createState(guided?: GuidedUpload): UploadManagerState {
	return {
		query: "",
		cursor: 0,
		selectionVisible: false,
		desired: new Map(),
		message: "",
		singleRun: Boolean(guided),
	};
}

function requireJson(json: boolean): Error | undefined {
	if (!json)
		return new Error(
			"Run this command with --json for machine-readable output.",
		);
}

async function runList(flags: { json: boolean }): Promise<undefined | Error> {
	const missing = requireJson(flags.json);
	if (missing) return missing;
	try {
		const state = createState();
		const repositories = await scanUploadRepositories(
			state,
			() => {},
			new AbortController().signal,
			{ adapters: getUploadAdapters() },
		);
		if (state.message) process.stderr.write(`${state.message}\n`);
		writeJson({
			signedIn: loadCredentials() !== null,
			repositories: repositories.map((repository) => ({
				key: repository.key,
				name: repository.name,
				paths: repository.paths,
				sources: repository.sources,
				sessionCount: repository.sessionCount,
				uploadedCount: repository.uploadedCount ?? null,
				enabled: repository.enabled,
				current: repository.current,
				problem: repository.problem ?? null,
			})),
		});
	} catch (error) {
		return emitError(error);
	}
}

interface ApplyFlags {
	json: boolean;
	code?: string;
	enable?: string[];
	disable?: string[];
	organization?: string;
	apiBase?: string;
	allowInsecureApiBase: boolean;
}

async function runApply(flags: ApplyFlags): Promise<undefined | Error> {
	const missing = requireJson(flags.json);
	if (missing) return missing;
	const code = flags.code ?? (process.env.OPALINE_CONNECTION_CODE || undefined);
	delete process.env.OPALINE_CONNECTION_CODE;
	let guided: GuidedUpload | undefined;
	let failure: Error | undefined;
	let stopped = false;
	const controller = new AbortController();
	const abort = () => controller.abort();
	process.on("SIGINT", abort);
	process.on("SIGTERM", abort);
	const cancelled = new Promise<"cancelled">((resolve) =>
		controller.signal.addEventListener("abort", () => resolve("cancelled"), {
			once: true,
		}),
	);
	const work = (async () => {
		if (code !== undefined) {
			if (!CliConnectionSecretSchema.safeParse(code).success)
				throw new ReposError(
					"invalid_code",
					"Invalid connection code. Copy the command again from Opaline.",
				);
			const resolved = resolveApiBase(
				flags.apiBase ?? getDefaultApiBase(),
				allowsPlaintext(flags.allowInsecureApiBase),
			);
			if (!resolved.ok)
				throw new ReposError(
					"invalid_api_base",
					"Invalid API address. Use an HTTPS address or a local development server.",
				);
			const connection = await connectBrowser(
				resolved.url,
				code,
				controller.signal,
			);
			guided = createGuidedUpload(connection, {
				apiBase: resolved.url,
				allowInsecureApiBase: flags.allowInsecureApiBase,
				noBrowser: true,
				onVerificationUrl: (url) => emit({ type: "authorize", url }),
				signal: controller.signal,
			});
		}
		await applySelection(flags, guided, controller.signal);
	})();
	try {
		if ((await Promise.race([work, cancelled])) === "cancelled") {
			stopped = true;
			silenced = true;
			await Promise.race([work.catch(() => {}), wait(300)]);
		}
	} catch (error) {
		stopped = controller.signal.aborted;
		failure = error instanceof Error ? error : new Error(String(error));
	} finally {
		process.off("SIGINT", abort);
		process.off("SIGTERM", abort);
		try {
			await Promise.race([
				guided?.close(stopped ? undefined : failure),
				wait(2_000),
			]);
		} catch (error) {
			failure ??= error instanceof Error ? error : new Error(String(error));
		}
	}
	if (stopped) {
		setTimeout(() => process.exit(), 1_000).unref();
		silenced = false;
		return emitError(new ReposError("cancelled", "Stopped before finishing."));
	}
	if (failure) return emitError(failure);
}

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms).unref());
}

async function applySelection(
	flags: ApplyFlags,
	guided: GuidedUpload | undefined,
	signal: AbortSignal,
): Promise<void> {
	const adapters = getUploadAdapters();
	const state = createState(guided);
	emit({ type: "progress", phase: "scan" });
	const repositories = await scanUploadRepositories(state, () => {}, signal, {
		adapters,
		guided,
	});
	if (state.message) process.stderr.write(`${state.message}\n`);
	const keys = new Set(repositories.map((repository) => repository.key));
	const unknown = [...(flags.enable ?? []), ...(flags.disable ?? [])].filter(
		(key) => !keys.has(key),
	);
	if (unknown.length)
		throw new ReposError(
			"unknown_repository",
			`Unknown repository: ${unknown.join(", ")}`,
		);
	for (const key of flags.enable ?? []) state.desired.set(key, true);
	for (const key of flags.disable ?? []) state.desired.set(key, false);
	reviewUploadSelection(state);
	const run: UploadRun = {
		repositories,
		state,
		adapters,
		guided,
		uploadedThisRun: 0,
		uploadedWorkspaces: new Set(),
	};
	let lastUpload = "";
	const onProgress = (progress: UploadSaveProgress) => {
		if (progress.phase === "upload") {
			const key = `${progress.completed}/${progress.total}`;
			if (key === lastUpload) return;
			lastUpload = key;
		}
		emit({ type: "progress", ...progress });
	};
	const prepared = await prepareUploadSave(run, {
		onProgress,
		resolveDestinations: (destinations) =>
			resolveDestinations(destinations, {
				warn: (message) => process.stderr.write(`${message}\n`),
				login: async () => {
					throw new UploadSaveError(
						"not_signed_in",
						"Sign in to Opaline before changing repository uploads.",
					);
				},
				selectOrganization: async (organizations) => {
					if (
						flags.organization &&
						organizations.some((org) => org.id === flags.organization)
					)
						return flags.organization;
					throw new UploadSaveError(
						"organization_required",
						flags.organization
							? `Workspace ${flags.organization} is not available. Choose one of the listed workspaces.`
							: "Choose a workspace for the enabled repositories.",
						organizations.map((org) => ({ id: org.id, name: org.name })),
					);
				},
			}),
	});
	if (prepared.kind === "invalid")
		throw new ReposError("no_repositories_selected", prepared.message);
	if (prepared.kind === "cancelled")
		throw new ReposError("cancelled", "Save cancelled.");
	const result = await prepared.operation(signal);
	if (run.operationError) throw run.operationError;
	if (state.message) process.stderr.write(`${state.message}\n`);
	emit({
		type: "done",
		...result,
		completion: toCompletion(state.completion),
	});
}

function toCompletion(completion: UploadCompletion | undefined) {
	if (!completion) return null;
	if (completion.kind === "setup")
		return { kind: "setup" as const, url: completion.url };
	return {
		kind: "sessions" as const,
		dashboards: completion.dashboards.map((dashboard) => ({
			url: dashboard.url,
		})),
	};
}

const jsonFlag = {
	kind: "boolean",
	default: false,
	brief: "Print machine-readable JSON",
} as const;

const listCommand = buildCommand({
	loader: async () => ({ default: runList }),
	parameters: { flags: { json: jsonFlag } },
	docs: { brief: "List repositories and their upload state" },
});

const applyCommand = buildCommand({
	loader: async () => ({ default: runApply }),
	parameters: {
		flags: {
			json: jsonFlag,
			code: {
				kind: "parsed",
				parse: String,
				optional: true,
				brief: "One-time code from the Opaline setup page",
			},
			enable: {
				kind: "parsed",
				parse: String,
				variadic: true,
				optional: true,
				brief: "Repository key to turn uploads on for",
			},
			disable: {
				kind: "parsed",
				parse: String,
				variadic: true,
				optional: true,
				brief: "Repository key to turn uploads off for",
			},
			organization: {
				kind: "parsed",
				parse: String,
				optional: true,
				brief: "Workspace ID used when a repository has no destination",
			},
			apiBase: {
				kind: "parsed",
				parse: String,
				optional: true,
				brief: "API server base URL for --code",
			},
			allowInsecureApiBase: {
				kind: "boolean",
				default: false,
				brief: "Allow a plaintext self-hosted server",
			},
		},
	},
	docs: { brief: "Apply repository upload changes" },
});

export const reposRouteMap = buildRouteMap({
	routes: { list: listCommand, apply: applyCommand },
	docs: { brief: "Repository upload settings for the desktop app" },
});
