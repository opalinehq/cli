import { stat } from "node:fs/promises";
import { basename } from "node:path";
import * as p from "@clack/prompts";
import { buildCommand } from "@stricli/core";
import {
	claudeCodeAdapter,
	type FileBackedUploadRequest,
	getAdapter,
	MissingTranscriptTimestampError,
	type SessionFile,
} from "../internal/agent-adapters/index.js";
import {
	type AnalysisSupport,
	type AnalysisUploadEnvironment,
	checkAnalysisUploadSupport,
	getAnalysisDestination,
	isSameAnalysisDestination,
} from "../lib/analysis-upload.js";
import type { BatchUploadItem } from "../lib/batch-upload.js";
import { renderBatchSummary, runBatchUpload } from "../lib/batch-upload-ui.js";
import { classifySessionFile } from "../lib/classifier.js";
import { type Credentials, loadCredentials } from "../lib/credentials.js";
import {
	type FailedUpload,
	isRetryCandidate,
	loadFailedUploads,
	recordFailedUpload,
	recordPendingUpload,
	removeFailedUpload,
} from "../lib/failed-uploads.js";
import { getGitInfo } from "../lib/git-info.js";
import { reconcilePendingUploads } from "../lib/pending-upload-reconcile.js";
import { getProjectOrgId } from "../lib/project-config.js";
import { retryPendingSessionEvidence } from "../lib/session-evidence.js";
import { resolveSession } from "../lib/session-resolver.js";
import {
	DEFAULT_ENDPOINT,
	SESSION_TAGS,
	type SessionTag,
} from "../lib/types.js";
import { allowsInsecureEndpoint } from "../lib/upload-endpoint.js";
import { formatRedactionSummary, uploadSession } from "../lib/uploader.js";
import { runAnalysisImport } from "./import-analysis.js";

// `--retry` checks every pending server job it can; hooks check only a few.
const RETRY_RECONCILE_MAX_ENTRIES = 200;

interface UploadFlags {
	tag?: SessionTag;
	endpoint?: string;
	allowInsecureEndpoint: boolean;
	classify: boolean;
	dryRun: boolean;
	org?: string;
	retry: boolean;
	yes: boolean;
	concurrency: number;
	forceReplace: boolean;
	analysis?: string;
	related: boolean;
	json: boolean;
}

interface ResolvedUploadFlags extends UploadFlags {
	endpoint: string;
}

async function runSingleUpload(
	flags: ResolvedUploadFlags,
	session: string,
	allowPlaintextEndpoint: boolean,
	credentials: Credentials | null,
): Promise<undefined | Error> {
	const write = (msg: string) => {
		process.stdout.write(`${msg}\n`);
	};

	write(`Resolving session: ${session}`);
	let sessionInfo: Awaited<ReturnType<typeof resolveSession>>;
	try {
		sessionInfo = await resolveSession(session);
	} catch (error) {
		return error instanceof Error ? error : new Error(String(error));
	}
	write(`Found session at: ${sessionInfo.transcriptPath}`);

	const gitInfo = await getGitInfo(sessionInfo.projectPath);
	const displayName =
		gitInfo.gitRemote ||
		gitInfo.packageName ||
		basename(sessionInfo.projectPath);
	if (displayName) write(`Repository: ${displayName}`);
	if (gitInfo.branch) write(`Branch: ${gitInfo.branch}`);

	const organizationId =
		flags.org ?? (await getProjectOrgId(sessionInfo.projectPath));
	if (organizationId) write(`Organization: ${organizationId}`);

	write("Building upload request...");
	const sessionFile: SessionFile = {
		sessionId: sessionInfo.sessionId,
		transcriptPath: sessionInfo.transcriptPath,
		projectPath: sessionInfo.projectPath,
		gitBranch: sessionInfo.gitBranch,
		gitSha: sessionInfo.gitSha,
	};

	let request: FileBackedUploadRequest;
	try {
		request = await getAdapter(sessionInfo.source).buildUploadRequest(
			sessionFile,
			{
				tag: flags.tag,
				gitInfo,
				organizationId,
				uploadMode: "manual",
			},
		);
	} catch (error) {
		if (error instanceof MissingTranscriptTimestampError) {
			return new Error(
				"This transcript has no timestamped user/assistant messages, so it cannot be uploaded.",
			);
		}
		throw error;
	}

	const transcriptBytes = (await stat(request.transcriptPath)).size;
	write(`Transcript: ${transcriptBytes} bytes`);
	if (request.subagents.length > 0) {
		write(`Subagents: ${request.subagents.length} file(s)`);
	}

	if (flags.forceReplace) request.metadata.force_replace = true;

	if (flags.dryRun) {
		const subagents = await Promise.all(
			request.subagents.map(async (subagent) => ({
				agentId: subagent.agentId,
				content: `[${(await stat(subagent.path)).size} bytes]`,
			})),
		);
		const preview = {
			...request.metadata,
			content: `[${transcriptBytes} bytes]`,
			subagents: subagents.length > 0 ? subagents : undefined,
		};
		write("Dry run - would upload:");
		write(JSON.stringify(preview, null, 2));
		return;
	}

	if (!credentials) {
		return new Error("Not authenticated. Run `opaline login` first.");
	}

	if (!flags.tag && flags.classify) {
		write("Classifying session...");
		const classified = await classifySessionFile(request.transcriptPath);
		if (classified) {
			request.metadata.tag = classified;
			write(`Classified as: ${classified}`);
		}
	}

	write("Uploading...");
	const result = await uploadSession(request, {
		endpoint: flags.endpoint,
		token: credentials.token,
		allowInsecureEndpoint: allowPlaintextEndpoint,
		authType: credentials.authType,
	});

	if (result.pendingJobId !== undefined) {
		await recordPendingUpload({
			sessionId: request.metadata.sessionId,
			transcriptPath: request.transcriptPath,
			projectPath: sessionInfo.projectPath,
			source: sessionInfo.source,
			organizationId,
			error: result.error ?? "Still processing on the server",
			jobId: result.pendingJobId,
			uploadBytes: result.uploadBytes,
		});
		write(
			"Upload accepted; Opaline is still processing it. Run `opaline upload --retry` later to confirm.",
		);
		return;
	}
	if (result.success) {
		write("Upload successful!");
		await removeFailedUpload(request.metadata.sessionId);
		const redactionSummary = formatRedactionSummary(
			result.redacted,
			result.redactedBytes,
		);
		if (redactionSummary) {
			write(redactionSummary);
		}
	} else {
		return new Error(`Upload failed: ${result.error}`);
	}
}

async function runRetryUpload(
	flags: ResolvedUploadFlags,
	allowPlaintextEndpoint: boolean,
	credentials: Credentials | null,
): Promise<undefined | Error> {
	p.intro("opaline upload --retry");
	let evidenceRetryError: Error | undefined;
	if (!flags.dryRun) {
		if (!credentials)
			return new Error("Not authenticated. Run `opaline login` first.");
		if (credentials.user) {
			try {
				const evidenceCount = await retryPendingSessionEvidence(credentials, {
					allowInsecureEndpoint: allowPlaintextEndpoint,
					endpoint: flags.endpoint,
					onWarning: (message) => p.log.warn(message),
				});
				if (evidenceCount > 0)
					p.log.success(
						`Retried ${evidenceCount} pending repository evidence capture(s).`,
					);
			} catch (error) {
				evidenceRetryError = new Error(
					`Repository evidence retry failed: ${error instanceof Error ? error.message : String(error)}`,
				);
				p.log.warn(
					`${evidenceRetryError.message} Raw upload retries will continue.`,
				);
			}
		}
	}

	if (!flags.dryRun && credentials) {
		const reconciled = await reconcilePendingUploads(
			{ maxEntries: RETRY_RECONCILE_MAX_ENTRIES },
			{
				allowInsecureEndpoint: allowPlaintextEndpoint,
				authType: credentials.authType,
				endpoint: flags.endpoint,
				token: credentials.token,
			},
		);
		for (const failure of reconciled.linkFailures)
			p.log.warn(`Analysis upload failed for ${failure}`);
		if (reconciled.checked > 0)
			p.log.info(
				`Checked ${reconciled.checked} upload(s) still processing on the server: ${reconciled.completed} completed, ${reconciled.stillPending} still processing, ${reconciled.requeued} to upload again, ${reconciled.failed} failed.`,
			);
	}

	const failures = await loadFailedUploads();
	const pendingUploads = failures.filter(
		(failure) => failure.status === "pending",
	);
	if (failures.length === pendingUploads.length) {
		p.outro(
			pendingUploads.length > 0
				? `No failed uploads to retry. ${pendingUploads.length} upload(s) are still processing on the server.`
				: "No failed uploads to retry.",
		);
		return evidenceRetryError;
	}

	const retryableFailures = failures.filter((failure) =>
		isRetryCandidate(failure, flags.forceReplace),
	);
	const permanentFailures = failures.filter(
		(failure) => failure.status === "permanent",
	);
	const failedUploads = failures.filter(
		(failure) => failure.status !== "pending",
	);
	p.log.info(
		`Found ${failedUploads.length} failed upload(s): ${retryableFailures.length} retryable, ${permanentFailures.length} permanent${pendingUploads.length > 0 ? ` (${pendingUploads.length} still processing on the server)` : ""}`,
	);
	for (const f of failedUploads.slice(0, 10)) {
		p.log.warn(`  [${f.status}] ${f.sessionId}: ${f.error} (${f.failedAt})`);
	}
	if (failedUploads.length > 10) {
		p.log.warn(`  ...and ${failedUploads.length - 10} more`);
	}
	if (permanentFailures.length > 0) {
		p.log.warn(
			flags.forceReplace
				? "Permanent shrink rejections are promoted by --force-replace; other permanent failures remain recorded."
				: "Permanent failures are retained for visibility and are not retried automatically.",
		);
	}
	if (retryableFailures.length === 0) {
		p.outro("No retryable uploads. Permanent failures remain recorded.");
		return evidenceRetryError;
	}

	if (flags.dryRun) {
		p.outro(
			`Dry run complete — ${retryableFailures.length} retryable upload(s) were not sent.`,
		);
		return;
	}

	if (!credentials) {
		return new Error("Not authenticated. Run `opaline login` first.");
	}

	if (!flags.yes) {
		const shouldRetry = await p.confirm({
			message: `Retry ${retryableFailures.length} retryable upload(s)?`,
			initialValue: true,
		});

		if (p.isCancel(shouldRetry) || !shouldRetry) {
			p.cancel("Retry cancelled.");
			return evidenceRetryError;
		}
	}

	type RetryItem = BatchUploadItem & {
		failure: (typeof failures)[number];
	};

	const sendable = await filterAnalysisRetries(retryableFailures, {
		allowInsecureEndpoint: allowPlaintextEndpoint,
		credentials,
		endpoint: flags.endpoint,
	});
	const items: RetryItem[] = sendable.map((f) => ({
		sessionId: f.sessionId,
		label: f.sessionId,
		transcriptPath: f.transcriptPath,
		projectPath: f.projectPath,
		source: f.source,
		organizationId: f.analysisId === undefined ? f.organizationId : undefined,
		analysisId: f.analysisId,
		analysisDestination: f.analysisDestination,
		uploadBytes: f.uploadBytes,
		failure: f,
	}));

	const { token, authType } = credentials;
	const summary = await runBatchUpload({
		items,
		label: "Retrying uploads...",
		concurrency: flags.concurrency,
		upload: async (item, onRetry) => {
			const adapter = item.failure.source
				? getAdapter(item.failure.source)
				: claudeCodeAdapter;
			const sessionFile: SessionFile = {
				sessionId: item.failure.sessionId,
				transcriptPath: item.failure.transcriptPath,
				projectPath: item.failure.projectPath,
			};
			const gitInfo = await getGitInfo(item.failure.projectPath);
			// Analysis uploads go to the analysis's workspace, never an org.
			const organizationId =
				item.analysisId === undefined
					? (flags.org ??
						item.failure.organizationId ??
						(await getProjectOrgId(item.failure.projectPath)))
					: undefined;

			const request = await adapter.buildUploadRequest(sessionFile, {
				tag: flags.tag,
				gitInfo,
				organizationId,
				uploadMode: "retry",
			});
			if (flags.forceReplace) request.metadata.force_replace = true;
			if (item.analysisId !== undefined)
				request.metadata.analysisId = item.analysisId;

			return uploadSession(request, {
				endpoint: flags.endpoint,
				token,
				allowInsecureEndpoint: allowPlaintextEndpoint,
				authType,
				onRetry,
			});
		},
	});

	renderBatchSummary(summary);

	p.outro("Done!");

	if (summary.failed > 0) {
		if (evidenceRetryError)
			return new AggregateError(
				[evidenceRetryError, new Error(`${summary.failed} upload(s) failed.`)],
				`Repository evidence retry failed and ${summary.failed} raw upload(s) failed.`,
			);
		return new Error(`${summary.failed} upload(s) failed.`);
	}
	return evidenceRetryError;
}

/**
 * Analysis uploads are retried only to the endpoint and account their import
 * approved, and only once the server confirms it links analyses. Others are
 * recorded as permanent (destination changed, server unsupported) or kept for
 * later (server unreachable).
 */
async function filterAnalysisRetries(
	failures: readonly FailedUpload[],
	environment: AnalysisUploadEnvironment,
): Promise<FailedUpload[]> {
	const destination = getAnalysisDestination(environment);
	let support: AnalysisSupport | undefined;
	const sendable: FailedUpload[] = [];
	for (const failure of failures) {
		if (failure.analysisId === undefined) {
			sendable.push(failure);
			continue;
		}
		if (
			!failure.analysisDestination ||
			!isSameAnalysisDestination(failure.analysisDestination, destination)
		) {
			const error =
				"Not retried: the Opaline server or account changed since `opaline import --analysis`. Run that command again to link this chat.";
			p.log.warn(`  ${failure.sessionId}: ${error}`);
			await recordFailedUpload({ ...failure, error, status: "permanent" });
			continue;
		}
		support ??= await checkAnalysisUploadSupport(environment);
		if (support.supported) {
			sendable.push(failure);
			continue;
		}
		p.log.warn(`  ${failure.sessionId}: not retried: ${support.reason}`);
		if (support.kind === "unsupported")
			await recordFailedUpload({
				...failure,
				error: support.reason,
				status: "permanent",
			});
	}
	return sendable;
}

async function runUpload(
	flags: UploadFlags,
	...sessions: string[]
): Promise<undefined | Error> {
	const credentials = loadCredentials();
	if (!credentials && !flags.dryRun) {
		return new Error("Not authenticated. Run `opaline login` first.");
	}
	const apiBaseUrl = credentials?.apiBaseUrl.replace(/\/+$/u, "");
	const resolvedFlags: ResolvedUploadFlags = {
		...flags,
		endpoint:
			flags.endpoint ??
			(apiBaseUrl === undefined ? DEFAULT_ENDPOINT : `${apiBaseUrl}/rpc`),
	};
	const allowPlaintextEndpoint = allowsInsecureEndpoint(
		resolvedFlags.allowInsecureEndpoint,
	);
	if (resolvedFlags.analysis !== undefined) {
		const analysisId = resolvedFlags.analysis.trim();
		const session = sessions[0];
		if (!analysisId) return new Error("--analysis needs an analysis id.");
		if (!session || sessions.length > 1)
			return new Error(
				"Pass exactly one session or Codex thread id with --analysis.",
			);
		if (resolvedFlags.retry || resolvedFlags.org !== undefined)
			return new Error(
				"--analysis cannot be combined with --retry or --org; the analysis decides the workspace.",
			);
		return runAnalysisImport(
			{
				analysisId,
				dryRun: resolvedFlags.dryRun,
				json: resolvedFlags.json,
				related: resolvedFlags.related,
				session,
			},
			{
				allowInsecureEndpoint: allowPlaintextEndpoint,
				credentials,
				endpoint: resolvedFlags.endpoint,
			},
		);
	}
	if (resolvedFlags.retry) {
		return runRetryUpload(resolvedFlags, allowPlaintextEndpoint, credentials);
	}
	const [first] = sessions;
	if (first === undefined)
		return new Error(
			"Use `opaline upload` to select repositories, or pass a session file or --retry.",
		);
	if (sessions.length === 1)
		return runSingleUpload(
			resolvedFlags,
			first,
			allowPlaintextEndpoint,
			credentials,
		);
	// Every given session is uploaded, in order; one failure does not stop
	// the others.
	const failures: Error[] = [];
	for (const session of sessions) {
		const error = await runSingleUpload(
			resolvedFlags,
			session,
			allowPlaintextEndpoint,
			credentials,
		);
		if (error === undefined) continue;
		failures.push(error);
		process.stderr.write(`Upload of ${session} failed: ${error.message}\n`);
	}
	if (failures.length === 0) return undefined;
	return new AggregateError(
		failures,
		`${failures.length} of ${sessions.length} session uploads failed.`,
	);
}

export const importCommand = buildCommand({
	loader: async () => ({ default: runUpload }),
	parameters: {
		positional: {
			kind: "array",
			parameter: {
				brief: "Session ID or path to a session .jsonl file",
				parse: String,
				placeholder: "session",
			},
		},
		flags: {
			tag: {
				kind: "enum",
				values: [...SESSION_TAGS],
				brief: "Session tag/category",
				optional: true,
			},
			endpoint: {
				kind: "parsed",
				parse: String,
				brief: "Override the upload endpoint URL",
				optional: true,
			},
			allowInsecureEndpoint: {
				kind: "boolean",
				brief: "Allow plaintext uploads to a non-loopback endpoint",
				default: false,
			},
			classify: {
				kind: "boolean",
				brief: "Auto-classify session tag using Claude CLI",
				default: false,
			},
			dryRun: {
				kind: "boolean",
				brief: "Preview what would be uploaded without sending",
				default: false,
			},
			org: {
				kind: "parsed",
				parse: String,
				brief: "Override the organization ID to upload to",
				optional: true,
			},
			retry: {
				kind: "boolean",
				brief: "Retry previously failed uploads",
				default: false,
			},
			yes: {
				kind: "boolean",
				brief: "Skip the confirmation prompt for --retry",
				default: false,
			},
			concurrency: {
				kind: "parsed",
				parse: Number,
				brief: "Max concurrent uploads",
				default: "5",
			},
			forceReplace: {
				kind: "boolean",
				brief: "Intentionally replace a stored session with smaller content",
				default: false,
			},
			analysis: {
				kind: "parsed",
				parse: String,
				brief:
					"Link the chat to an Opaline analysis (uploads into the analysis's workspace; later turns re-upload via hooks)",
				optional: true,
			},
			related: {
				kind: "boolean",
				brief:
					"With --analysis, include the Codex thread's parent chain and spawned subagent threads",
				default: true,
			},
			json: {
				kind: "boolean",
				brief: "With --analysis, print one JSON object instead of a line",
				default: false,
			},
		},
		aliases: {
			t: "tag",
			c: "classify",
			n: "dryRun",
			o: "org",
			r: "retry",
			y: "yes",
			j: "concurrency",
		},
	},
	docs: {
		brief: "Upload a session file or retry failed uploads.",
	},
});
