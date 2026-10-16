import { randomUUID } from "node:crypto";
import {
	lstat,
	mkdir,
	readdir,
	readFile,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
	claudeCodeAdapter,
	decodeProjectPath,
} from "../internal/agent-adapters/index.js";
import { readSessionDiscoveryMetadata } from "../internal/agent-adapters/utils.js";
import {
	SESSION_TASK_OUTPUT_MAX_FILE_BYTES,
	SESSION_TASK_OUTPUT_MAX_TOTAL_BYTES,
} from "../internal/local-context-source/capture-policy.js";
import { findAnalysisMarkers } from "./analysis-markers.js";
import { getApiBaseOverride } from "./api-target.js";
import {
	isRepositoryAutoUploadAllowed,
	isRepositoryAutoUploadDisabled,
} from "./auto-upload-config.js";
import { getClaudeTemporaryRoot, getUid } from "./claude-task-outputs.js";
import type { Credentials } from "./credentials.js";
import { tryAcquireFileLease } from "./file-lease.js";
import { getGitInfo } from "./git-info.js";
import { getConfigDir } from "./local-state.js";
import { getOrCreateCliInstallationId } from "./product-analytics.js";
import { getProjectOrgId } from "./project-config.js";
import {
	getLegacyRepositoryKeys,
	resolveUploadRepositoryIdentity,
} from "./repository-discovery.js";
import { readRepositoryEvidencePauseUntil } from "./repository-evidence-pause.js";
import {
	getRepositoryEvidenceLeaseDirectory,
	normalizeRepositoryEvidenceEndpoint,
} from "./repository-evidence-pending.js";
import type { captureAndUploadSessionEvidence } from "./session-evidence.js";
import {
	inferSessionRepository,
	withSessionRepository,
} from "./session-repository.js";
import { readTranscriptRevision } from "./transcript-revision-store.js";

/**
 * One-time capture of background task outputs that Claude Code sessions
 * delivered before this CLI captured them. Their transcripts were delivered
 * already, so each session gets one `checkpoint` capture that continues its
 * delivered transcript revision (no transcript byte is sent again) and adds
 * the `claude-task-outputs` root. Outputs live in a temporary directory that
 * is cleared on reboot, so only the sessions whose directory still exists are
 * found. Sessions modified in the last half hour are left to their own
 * SessionEnd hook.
 *
 * It runs from the background evidence deliverer. Each session is recorded in
 * the marker before it is captured, so an interrupted run never captures a
 * session twice; a run cut by its bounds continues in the next one, and after
 * TASK_OUTPUT_SWEEP_MAX_RUNS runs the sweep is complete whatever remains.
 */
export const TASK_OUTPUT_SWEEP_MARKER = "claude-task-output-sweep.json";
export const TASK_OUTPUT_SWEEP_MAX_RUNS = 3;
export const TASK_OUTPUT_SWEEP_BUDGET_MS = 5 * 60_000;
export const TASK_OUTPUT_SWEEP_MAX_SESSIONS = 40;
/** Task-output bytes one run may capture, counted as the capture keeps them. */
export const TASK_OUTPUT_SWEEP_MAX_BYTES = 64 * 1024 * 1024;
const ACTIVE_SESSION_MS = 30 * 60_000;
const MAX_CONSECUTIVE_FAILURES = 3;
const MAX_SCANNED_SESSIONS = 2000;

type CaptureSessionEvidence = typeof captureAndUploadSessionEvidence;

/**
 * A capture that would send delivered transcript bytes again (no delivered
 * revision, or one the transcript no longer continues) was discarded, as
 * `requireDeliveredTranscript` asked.
 */
export class TranscriptNotDeliveredError extends Error {
	constructor(sessionId: string) {
		super(
			`Session ${sessionId} has no delivered transcript revision this capture continues.`,
		);
		this.name = "TranscriptNotDeliveredError";
	}
}

interface SweepState {
	readonly version: 1;
	readonly runs: number;
	readonly completedAt: string | null;
	/** Sessions already attempted, as `<project dir>/<session id>`. */
	readonly attempted: readonly string[];
}

export interface TaskOutputSweepResult {
	readonly status: "complete" | "partial" | "not-due" | "busy" | "paused";
	readonly captured: number;
	readonly skipped: number;
	readonly failed: number;
}

interface Candidate {
	readonly key: string;
	readonly projectDirectory: string;
	readonly sessionId: string;
	readonly transcriptPath: string;
	readonly modifiedAtMs: number;
	readonly taskOutputBytes: number;
}

/** Whether the sweep has yet to run, or to finish, on this machine. */
export async function isClaudeTaskOutputSweepDue(
	configDir = getConfigDir(),
): Promise<boolean> {
	return isDue(await readSweepState(configDir));
}

function isDue(state: SweepState | null): boolean {
	return (
		state === null ||
		(state.completedAt === null && state.runs < TASK_OUTPUT_SWEEP_MAX_RUNS)
	);
}

export async function sweepClaudeTaskOutputs(input: {
	readonly credentials: Credentials;
	readonly capture: CaptureSessionEvidence;
	readonly configDir?: string;
	readonly budgetMs?: number;
	readonly env?: NodeJS.ProcessEnv;
	/** `~/.claude/projects`. */
	readonly projectsDirectory?: string;
	readonly uid?: number | null;
	readonly onWarning?: (message: string) => void;
}): Promise<TaskOutputSweepResult> {
	const configDir = input.configDir ?? getConfigDir();
	const result = { captured: 0, skipped: 0, failed: 0 };
	const user = input.credentials.user;
	if (!user) return { status: "not-due", ...result };
	if (readRepositoryEvidencePauseUntil(configDir) !== undefined)
		return { status: "paused", ...result };
	if (!(await isClaudeTaskOutputSweepDue(configDir)))
		return { status: "not-due", ...result };
	const lease = await tryAcquireFileLease(
		join(
			getRepositoryEvidenceLeaseDirectory(configDir),
			"task-output-sweep.lease",
		),
	);
	if (lease === null) return { status: "busy", ...result };
	try {
		// Another process may have finished the sweep before the lease.
		const previous = await readSweepState(configDir);
		if (!isDue(previous)) return { status: "not-due", ...result };
		const attempted = [...(previous?.attempted ?? [])];
		const runs = (previous?.runs ?? 0) + 1;
		// The run counts before any work, so a crashing run still ends the
		// sweep after TASK_OUTPUT_SWEEP_MAX_RUNS attempts.
		await writeSweepState(configDir, {
			version: 1,
			runs,
			completedAt: null,
			attempted,
		});
		const deadlineAt =
			Date.now() + (input.budgetMs ?? TASK_OUTPUT_SWEEP_BUDGET_MS);
		const uid = getUid(input.uid);
		const candidates =
			uid === null
				? []
				: await findSweepCandidates(
						await getClaudeTemporaryRoot(input.env ?? process.env, uid),
						input.projectsDirectory ?? claudeCodeAdapter.getSessionsBaseDir(),
						uid,
						new Set(attempted),
						Date.now() - ACTIVE_SESSION_MS,
					);
		const endpoint = normalizeRepositoryEvidenceEndpoint(
			`${getApiBaseOverride() ?? input.credentials.apiBaseUrl}/rpc`,
		);
		let exhausted = true;
		let bytes = 0;
		let consecutiveFailures = 0;
		for (const [index, candidate] of candidates.entries()) {
			if (
				Date.now() >= deadlineAt ||
				index >= TASK_OUTPUT_SWEEP_MAX_SESSIONS ||
				bytes + candidate.taskOutputBytes > TASK_OUTPUT_SWEEP_MAX_BYTES ||
				consecutiveFailures >= MAX_CONSECUTIVE_FAILURES ||
				readRepositoryEvidencePauseUntil(configDir) !== undefined
			) {
				exhausted = false;
				break;
			}
			attempted.push(candidate.key);
			await writeSweepState(configDir, {
				version: 1,
				runs,
				completedAt: null,
				attempted,
			});
			try {
				const outcome = await sweepSession(candidate, {
					...input,
					actorId: user.id,
					configDir,
					endpoint,
				});
				result[outcome] += 1;
				if (outcome === "captured") bytes += candidate.taskOutputBytes;
				consecutiveFailures = 0;
			} catch (error) {
				result.failed += 1;
				consecutiveFailures += 1;
				input.onWarning?.(
					`Task outputs of session ${candidate.sessionId} not captured: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
		const complete = exhausted || runs >= TASK_OUTPUT_SWEEP_MAX_RUNS;
		await writeSweepState(configDir, {
			version: 1,
			runs,
			completedAt: complete ? new Date().toISOString() : null,
			attempted,
		});
		return { status: complete ? "complete" : "partial", ...result };
	} finally {
		await lease.release();
	}
}

/**
 * Captures one earlier session with the gates of its SessionEnd hook: not
 * linked to an analysis, automatic upload allowed for its repository, a
 * workspace bound to it, and a delivered transcript revision to continue.
 */
async function sweepSession(
	candidate: Candidate,
	input: {
		readonly actorId: string;
		readonly capture: CaptureSessionEvidence;
		readonly configDir: string;
		readonly credentials: Credentials;
		readonly endpoint: string;
		readonly onWarning?: (message: string) => void;
	},
): Promise<"captured" | "skipped"> {
	const { sessionId, transcriptPath } = candidate;
	if ((await findAnalysisMarkers("claude_code", sessionId)).length > 0)
		return "skipped";
	const metadata = await readSessionDiscoveryMetadata(transcriptPath);
	const projectPath =
		metadata.cwd && isAbsolute(metadata.cwd)
			? metadata.cwd
			: await decodeProjectPath(candidate.projectDirectory);
	if (
		!(await lstat(projectPath).then(
			(details) => details.isDirectory(),
			() => false,
		))
	)
		return "skipped";
	const gitInfo = await getGitInfo(projectPath);
	const repository = resolveUploadRepositoryIdentity(projectPath, gitInfo);
	if (
		!isRepositoryAutoUploadAllowed(
			repository.repoKey,
			claudeCodeAdapter.source,
			getLegacyRepositoryKeys(projectPath, gitInfo),
			input.configDir,
		)
	)
		return "skipped";
	const organizationId = await getProjectOrgId(projectPath);
	if (!organizationId) return "skipped";
	const previous = await readTranscriptRevision(
		{
			endpoint: input.endpoint,
			organizationId,
			transcriptScope: {
				actorId: input.actorId,
				provider: "claude_code",
				providerInstanceId: getOrCreateCliInstallationId(),
				sessionId,
			},
		},
		input.configDir,
	);
	if (previous === undefined) return "skipped";
	const built = await claudeCodeAdapter.buildUploadRequest(
		{ sessionId, transcriptPath, projectPath },
		{ gitInfo, organizationId, uploadMode: "hook" },
	);
	const inferred = await inferSessionRepository(built);
	if (
		inferred &&
		isRepositoryAutoUploadDisabled(
			inferred.repository.repoKey,
			claudeCodeAdapter.source,
			inferred.legacyKeys,
			input.configDir,
		)
	)
		return "skipped";
	try {
		await input.capture({
			backgroundDelivery: "none",
			captureReason: "task-output-sweep",
			credentials: input.credentials,
			hookReceivedAt: new Date().toISOString(),
			lifecycle: "checkpoint",
			onWarning: input.onWarning,
			organizationId,
			request: inferred
				? withSessionRepository(built, inferred.gitInfo)
				: built,
			requireDeliveredTranscript: true,
			terminalTranscript: previous.terminal,
		});
	} catch (error) {
		if (error instanceof TranscriptNotDeliveredError) return "skipped";
		throw error;
	}
	return "captured";
}

/**
 * Sessions whose `tasks` directory still holds a regular output file and
 * whose transcript is in `projectsDirectory`, not modified since
 * `activeAfterMs` and not attempted yet, newest first.
 */
export async function findSweepCandidates(
	temporaryRoot: string,
	projectsDirectory: string,
	uid: number,
	attempted: ReadonlySet<string>,
	activeAfterMs: number,
): Promise<readonly Candidate[]> {
	const root = await lstat(temporaryRoot).catch(() => null);
	if (root === null || !root.isDirectory() || root.uid !== uid) return [];
	const candidates: Candidate[] = [];
	let scanned = 0;
	for (const projectDirectory of await listDirectories(temporaryRoot)) {
		for (const sessionId of await listDirectories(
			join(temporaryRoot, projectDirectory),
		)) {
			scanned += 1;
			if (scanned > MAX_SCANNED_SESSIONS) return sortCandidates(candidates);
			const key = `${projectDirectory}/${sessionId}`;
			if (attempted.has(key)) continue;
			const taskOutputBytes = await getTaskOutputBytes(
				join(temporaryRoot, projectDirectory, sessionId, "tasks"),
			);
			if (taskOutputBytes === null) continue;
			const transcriptPath = join(
				projectsDirectory,
				projectDirectory,
				`${sessionId}.jsonl`,
			);
			const transcript = await lstat(transcriptPath).catch(() => null);
			if (transcript === null || !transcript.isFile()) continue;
			if (transcript.mtimeMs >= activeAfterMs) continue;
			candidates.push({
				key,
				projectDirectory,
				sessionId,
				transcriptPath,
				modifiedAtMs: transcript.mtimeMs,
				taskOutputBytes,
			});
		}
	}
	return sortCandidates(candidates);
}

function sortCandidates(candidates: Candidate[]): readonly Candidate[] {
	return candidates.sort(
		(left, right) =>
			right.modifiedAtMs - left.modifiedAtMs ||
			left.key.localeCompare(right.key),
	);
}

/**
 * The bytes a capture keeps of a tasks directory's regular files (symlinks,
 * the async agents' outputs, are not counted), or null when it has none.
 */
async function getTaskOutputBytes(directory: string): Promise<number | null> {
	const details = await lstat(directory).catch(() => null);
	if (details === null || !details.isDirectory()) return null;
	let files = 0;
	let bytes = 0;
	const visit = async (path: string, depth: number) => {
		const entries = await readdir(path, { withFileTypes: true }).catch(
			() => [],
		);
		for (const entry of entries) {
			if (entry.isDirectory() && depth === 0)
				await visit(join(path, entry.name), 1);
			if (!entry.isFile()) continue;
			const size = await lstat(join(path, entry.name)).then(
				(file) => file.size,
				() => null,
			);
			if (size === null) continue;
			files += 1;
			bytes += Math.min(size, SESSION_TASK_OUTPUT_MAX_FILE_BYTES);
		}
	};
	await visit(directory, 0);
	return files === 0
		? null
		: Math.min(bytes, SESSION_TASK_OUTPUT_MAX_TOTAL_BYTES);
}

async function listDirectories(path: string): Promise<readonly string[]> {
	const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
	return entries
		.filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
		.map((entry) => entry.name)
		.sort();
}

async function readSweepState(configDir: string): Promise<SweepState | null> {
	let text: string;
	try {
		text = await readFile(join(configDir, TASK_OUTPUT_SWEEP_MARKER), "utf8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT")
			return null;
		throw error;
	}
	try {
		const value: unknown = JSON.parse(text);
		if (
			typeof value === "object" &&
			value !== null &&
			"version" in value &&
			value.version === 1 &&
			"runs" in value &&
			typeof value.runs === "number" &&
			"completedAt" in value &&
			(value.completedAt === null || typeof value.completedAt === "string") &&
			"attempted" in value &&
			Array.isArray(value.attempted) &&
			value.attempted.every((item) => typeof item === "string")
		)
			return {
				version: 1,
				runs: value.runs,
				completedAt: value.completedAt,
				attempted: value.attempted,
			};
	} catch {
		// Unreadable below.
	}
	// An unreadable marker never makes the sweep run again.
	return {
		version: 1,
		runs: TASK_OUTPUT_SWEEP_MAX_RUNS,
		completedAt: null,
		attempted: [],
	};
}

async function writeSweepState(
	configDir: string,
	state: SweepState,
): Promise<void> {
	await mkdir(configDir, { mode: 0o700, recursive: true });
	const path = join(configDir, TASK_OUTPUT_SWEEP_MARKER);
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporary, `${JSON.stringify(state)}\n`, {
			flag: "wx",
			mode: 0o600,
		});
		await rename(temporary, path);
	} finally {
		await rm(temporary, { force: true });
	}
}
