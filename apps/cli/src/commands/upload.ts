import * as p from "@clack/prompts";
import { buildCommand } from "@stricli/core";
import { sanitizeForTerminalDisplay } from "../contracts/index.js";
import type { AgentAdapter } from "../internal/agent-adapters/index.js";
import { cliMessage } from "../lib/cli-messages.js";
import type { GuidedUpload } from "../lib/guided-upload.js";
import {
	getUploadAdapters,
	type UploadRepository,
} from "../lib/upload-manager-repositories.js";
import {
	getPendingRepositories,
	type UploadManagerState,
} from "../lib/upload-manager-state.js";
import {
	createUploadScreen,
	promptUploadManager,
	type UploadRepositoryScan,
} from "../lib/upload-manager-terminal.js";
import {
	type DestinationPrompts,
	prepareUploadSave,
	resolveDestinations,
	scanUploadRepositories,
	type UploadRun,
} from "../lib/upload-save.js";
import { runLogin } from "./login.js";

export async function runUpload(
	guided?: GuidedUpload,
	env: { adapters?: AgentAdapter[]; cwd?: string } = {},
): Promise<undefined | Error> {
	if (!process.stdin.isTTY || !process.stdout.isTTY) {
		return new Error(
			"Open `opaline upload` in an interactive terminal to toggle repositories.",
		);
	}
	const screen = createUploadScreen();
	try {
		const adapters = env.adapters ?? getUploadAdapters();
		const repositories: UploadRepository[] = [];
		const state: UploadManagerState = {
			query: "",
			cursor: 0,
			selectionVisible: false,
			desired: new Map(),
			message: "",
			singleRun: Boolean(guided),
		};
		let scan: UploadRepositoryScan | undefined = (onRepositories, signal) =>
			scanUploadRepositories(state, onRepositories, signal, {
				adapters,
				cwd: env.cwd,
				guided,
			});
		let operation: ((signal: AbortSignal) => Promise<void>) | undefined;
		const run: UploadRun = {
			repositories,
			state,
			adapters,
			guided,
			uploadedThisRun: 0,
			uploadedWorkspaces: new Set(),
		};
		while (
			(await promptUploadManager(
				repositories,
				state,
				scan,
				operation,
				screen,
			)) === "save"
		) {
			scan = undefined;
			operation = undefined;
			try {
				const prepared = await prepareUploadSave(run, {
					showPrompt: screen.close,
					resolveDestinations: (destinations) =>
						resolveDestinations(destinations, getTerminalPrompts(screen.close)),
				});
				if (prepared.kind === "invalid") {
					state.message = prepared.message;
					continue;
				}
				if (prepared.kind === "cancelled") {
					state.message = "Save cancelled. Your changes are still pending.";
					continue;
				}
				operation = async (signal) => {
					await prepared.operation(signal);
				};
			} catch (error) {
				if (guided) throw error;
				state.error = {
					message: error instanceof Error ? error.message : String(error),
					page: 0,
				};
			}
		}
		screen.close();
		if (run.operationError) return run.operationError;
		if (state.completion) {
			p.log.success(state.message);
			for (const url of state.completion.kind === "setup"
				? [state.completion.url]
				: state.completion.dashboards.map((dashboard) => dashboard.url))
				p.log.info(url);
			return;
		}
		p.outro(
			getPendingRepositories(repositories, state).length
				? cliMessage("discarded")
				: cliMessage("closed"),
		);
	} catch (error) {
		return error instanceof Error ? error : new Error(String(error));
	} finally {
		screen.close();
	}
}

function getTerminalPrompts(showPrompt: () => void): DestinationPrompts {
	return {
		warn(message) {
			showPrompt();
			p.log.warn(message);
		},
		async login(apiBase) {
			showPrompt();
			const error = await runLogin({
				apiBase,
				allowInsecureApiBase: false,
				noBrowser: false,
			});
			if (error) throw error;
		},
		async selectOrganization(organizations) {
			showPrompt();
			const selected = await p.select({
				message: cliMessage("destination"),
				options: organizations.map((org) => ({
					value: org.id,
					label: sanitizeForTerminalDisplay(org.name),
				})),
			});
			return p.isCancel(selected) ? undefined : selected;
		},
	};
}

export const uploadCommand = buildCommand({
	loader: async () => ({ default: () => runUpload() }),
	parameters: {},
	docs: {
		brief: "Turn automatic session uploads on or off for each repository",
	},
});
