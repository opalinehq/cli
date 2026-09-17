import { runLogin } from "../commands/login.js";
import type { connectBrowser } from "./cli-connection.js";
import { getConnectionSelection } from "./cli-connection-selection.js";
import { type Credentials, loadCredentials } from "./credentials.js";
import type { UploadCompletion } from "./upload-completion.js";
import {
	getUploadAdapters,
	type UploadRepository,
} from "./upload-manager-repositories.js";
import type { UploadManagerState } from "./upload-manager-state.js";

export type GuidedUpload = ReturnType<typeof createGuidedUpload>;

export function createGuidedUpload(
	connection: Awaited<ReturnType<typeof connectBrowser>>,
	flags: {
		apiBase: string;
		allowInsecureApiBase: boolean;
		noBrowser: boolean;
	},
) {
	let finished = false;
	let started = false;
	let authorization:
		| {
				organizationId: string;
				organizations: NonNullable<Credentials["organizations"]>;
				credentials: Credentials;
		  }
		| undefined;
	let hasPreviousUploads = false;
	return {
		get credentials() {
			return authorization?.credentials;
		},
		get hasPreviousUploads() {
			return hasPreviousUploads;
		},
		apiBase: flags.apiBase,
		allowInsecureApiBase: flags.allowInsecureApiBase,
		async authorize(
			repositories: UploadRepository[],
			state: UploadManagerState,
			showPrompt?: () => void,
		) {
			if (authorization) return authorization;
			await connection.update({
				kind: "selection",
				repositories: getConnectionSelection(
					repositories,
					state,
					getUploadAdapters().map((adapter) => adapter.source),
				),
			});
			// A paired browser may belong to a different account than saved CLI
			// credentials. Always obtain fresh authorization for this connection.
			showPrompt?.();
			const error = await runLogin(flags, {
				id: connection.id,
				browserOrigin: connection.browserOrigin,
				registerDevice: (deviceCode) =>
					connection.update({ kind: "device", deviceCode }),
				readUploadHistory: (value) => {
					hasPreviousUploads = value;
				},
			});
			if (error) throw error;
			const credentials = loadCredentials();
			if (!credentials)
				throw new Error("Login did not complete. Please try again.");
			const approved = await connection.update(
				{ kind: "heartbeat" },
				credentials,
			);
			const organizationId = approved.organizationId;
			const organizations = credentials.organizations ?? [];
			if (
				!organizationId ||
				!organizations.some((org) => org.id === organizationId)
			)
				throw new Error(
					"The workspace approved in your browser is unavailable. Start setup again.",
				);
			await connection.update({ kind: "bind", organizationId }, credentials);
			authorization = { organizationId, organizations, credentials };
			return authorization;
		},
		async start() {
			if (started || finished) return;
			await connection.update({ kind: "status", state: "uploading" });
			started = true;
		},
		async complete(totals: {
			uploaded: number;
			skipped: number;
			failed: number;
		}) {
			// A retry uses the same approved workspace; the original pairing is terminal.
			if (finished) return;
			await connection.update({
				kind: "status",
				state: "completed",
				totals,
			});
			finished = true;
			connection.stop();
		},
		completionLink(completion: UploadCompletion): UploadCompletion {
			if (completion.kind === "sessions") return completion;
			const url = new URL("/welcome", connection.browserOrigin);
			url.searchParams.set("connect", connection.id);
			return { kind: "setup", url: url.toString() };
		},
		async close(error?: Error) {
			connection.stop();
			if (finished) return;
			await connection.update({
				kind: "status",
				state: error ? "failed" : "cancelled",
				failureReason: error ? "connection_failed" : null,
			});
			finished = true;
		},
	};
}
