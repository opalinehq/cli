import { createHash, randomUUID } from "node:crypto";
import {
	chmod,
	lstat,
	mkdir,
	readdir,
	readFile,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import {
	claudeCodeAdapter,
	codexAdapter,
} from "../internal/agent-adapters/index.js";
import { findAnalysisMarkers } from "./analysis-markers.js";
import { getApiBaseOverride } from "./api-target.js";
import {
	isRepositoryAutoUploadAllowed,
	isRepositoryAutoUploadDisabled,
} from "./auto-upload-config.js";
import { TranscriptNotDeliveredError } from "./claude-task-output-sweep.js";
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
	readPendingRepositoryEvidence,
} from "./repository-evidence-pending.js";
import type { captureAndUploadSessionEvidence } from "./session-evidence.js";
import {
	inferSessionRepository,
	withSessionRepository,
} from "./session-repository.js";
import { readTranscriptRevision } from "./transcript-revision-store.js";

/**
 * Sessions whose last capture had more images than its image budget. Once
 * that capture is delivered, the background evidence deliverer takes another
 * `checkpoint` capture of the session (reason `image-backlog`) that continues
 * its delivered transcript revision, so no transcript byte is sent again,
 * and delivers the next images; images delivered before are only referenced.
 * Claude Code captures a session at its start and end only, so without this
 * the images left by its SessionEnd capture would never be delivered.
 *
 * Each capture rewrites or removes its session's item. Bounded per session
 * (IMAGE_BACKLOG_MAX_FOLLOW_UPS captures, 1 GiB of images at 64 MiB each)
 * and per run.
 */
export const IMAGE_BACKLOG_MAX_FOLLOW_UPS = 16;
export const IMAGE_BACKLOG_MAX_ITEMS = 200;
export const IMAGE_BACKLOG_RUN_BUDGET_MS = 5 * 60_000;
export const IMAGE_BACKLOG_MAX_CAPTURES_PER_RUN = 20;
/** Items not updated for this long (another login's, say) are dropped. */
export const IMAGE_BACKLOG_MAX_AGE_MS = 14 * 24 * 60 * 60_000;
const MAX_CONSECUTIVE_FAILURES = 3;

type CaptureSessionEvidence = typeof captureAndUploadSessionEvidence;

export interface ImageBacklogItem {
	readonly version: 1;
	readonly endpoint: string;
	readonly organizationId: string;
	readonly actorId: string;
	readonly source: "claude_code" | "codex";
	readonly sessionId: string;
	readonly transcriptPath: string;
	readonly projectPath: string;
	/** Image-backlog captures taken for this session so far. */
	readonly followUps: number;
	/** Images the last capture deferred. */
	readonly deferred: number;
	readonly updatedAt: string;
}

export async function readImageBacklogItem(
	configDir: string,
	key: ImageBacklogKey,
): Promise<ImageBacklogItem | undefined> {
	return readItem(getItemPath(configDir, key));
}

export type ImageBacklogKey = Pick<
	ImageBacklogItem,
	"endpoint" | "organizationId" | "source" | "sessionId"
>;

export async function writeImageBacklogItem(
	configDir: string,
	item: ImageBacklogItem,
): Promise<void> {
	const directory = getBacklogDirectory(configDir);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	if (process.platform !== "win32") await chmod(directory, 0o700);
	const path = getItemPath(configDir, item);
	const exists = await lstat(path).then(
		() => true,
		() => false,
	);
	if (
		!exists &&
		(await listItemNames(configDir)).length >= IMAGE_BACKLOG_MAX_ITEMS
	)
		throw new Error(
			`Image backlog holds ${IMAGE_BACKLOG_MAX_ITEMS} sessions already.`,
		);
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporary, `${JSON.stringify(item)}\n`, {
			encoding: "utf8",
			flag: "wx",
			mode: 0o600,
		});
		await rename(temporary, path);
	} finally {
		await rm(temporary, { force: true });
	}
}

export async function removeImageBacklogItem(
	configDir: string,
	key: ImageBacklogKey,
): Promise<void> {
	await rm(getItemPath(configDir, key), { force: true });
}

export async function hasImageBacklog(
	configDir = getConfigDir(),
): Promise<boolean> {
	return (await listItemNames(configDir)).length > 0;
}

export interface ImageBacklogResult {
	readonly status: "done" | "busy" | "paused";
	readonly captured: number;
	readonly removed: number;
	readonly waiting: number;
	readonly failed: number;
}

/**
 * Takes the follow-up captures of the backlog's sessions whose earlier
 * capture is delivered (a session with a pending capture waits for it, so
 * its images are known delivered first).
 */
export async function deliverImageBacklog(input: {
	readonly credentials: Credentials;
	readonly capture: CaptureSessionEvidence;
	readonly configDir?: string;
	readonly budgetMs?: number;
	readonly onWarning?: (message: string) => void;
}): Promise<ImageBacklogResult> {
	const configDir = input.configDir ?? getConfigDir();
	const result = { captured: 0, removed: 0, waiting: 0, failed: 0 };
	const user = input.credentials.user;
	if (!user) return { status: "done", ...result };
	if (readRepositoryEvidencePauseUntil(configDir) !== undefined)
		return { status: "paused", ...result };
	if (!(await hasImageBacklog(configDir))) return { status: "done", ...result };
	const lease = await tryAcquireFileLease(
		join(getRepositoryEvidenceLeaseDirectory(configDir), "image-backlog.lease"),
	);
	if (lease === null) return { status: "busy", ...result };
	try {
		const endpoint = normalizeRepositoryEvidenceEndpoint(
			`${getApiBaseOverride() ?? input.credentials.apiBaseUrl}/rpc`,
		);
		const deadlineAt =
			Date.now() + (input.budgetMs ?? IMAGE_BACKLOG_RUN_BUDGET_MS);
		const items: ImageBacklogItem[] = [];
		for (const name of await listItemNames(configDir)) {
			const item = await readItem(join(getBacklogDirectory(configDir), name));
			if (
				item === undefined ||
				!(Date.now() - Date.parse(item.updatedAt) < IMAGE_BACKLOG_MAX_AGE_MS)
			) {
				await rm(join(getBacklogDirectory(configDir), name), { force: true });
				result.removed += 1;
			} else if (item.actorId === user.id && item.endpoint === endpoint)
				items.push(item);
		}
		items.sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
		let consecutiveFailures = 0;
		for (const item of items) {
			if (
				Date.now() >= deadlineAt ||
				result.captured >= IMAGE_BACKLOG_MAX_CAPTURES_PER_RUN ||
				consecutiveFailures >= MAX_CONSECUTIVE_FAILURES ||
				readRepositoryEvidencePauseUntil(configDir) !== undefined
			)
				break;
			try {
				const outcome = await followUp(item, {
					...input,
					actorId: user.id,
					configDir,
				});
				if (outcome === "captured") result.captured += 1;
				if (outcome === "waiting") result.waiting += 1;
				if (outcome === "removed") {
					await removeImageBacklogItem(configDir, item);
					result.removed += 1;
				}
				consecutiveFailures = 0;
			} catch (error) {
				result.failed += 1;
				consecutiveFailures += 1;
				input.onWarning?.(
					`Images of session ${item.sessionId} not delivered yet: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
		return { status: "done", ...result };
	} finally {
		await lease.release();
	}
}

/**
 * One follow-up capture with the gates of the session's own hooks: not linked
 * to an analysis, automatic upload allowed for its repository, the same
 * workspace bound to it, and a delivered transcript revision to continue.
 */
async function followUp(
	item: ImageBacklogItem,
	input: {
		readonly actorId: string;
		readonly capture: CaptureSessionEvidence;
		readonly configDir: string;
		readonly credentials: Credentials;
		readonly onWarning?: (message: string) => void;
	},
): Promise<"captured" | "waiting" | "removed"> {
	if (item.followUps >= IMAGE_BACKLOG_MAX_FOLLOW_UPS) {
		input.onWarning?.(
			`Session ${item.sessionId} still has ${item.deferred} image(s) after ${item.followUps} follow-up captures; they stay listed as deferred.`,
		);
		return "removed";
	}
	const pending = await readPendingRepositoryEvidence(input.configDir, {
		actorId: input.actorId,
		endpoint: item.endpoint,
		maxItems: 1,
		sessionId: item.sessionId,
	});
	if (pending.length > 0) return "waiting";
	const adapter = item.source === "codex" ? codexAdapter : claudeCodeAdapter;
	if ((await findAnalysisMarkers(item.source, item.sessionId)).length > 0)
		return "removed";
	const transcript = await lstat(item.transcriptPath).catch(() => null);
	const project = await lstat(item.projectPath).catch(() => null);
	if (!transcript?.isFile() || !project?.isDirectory()) return "removed";
	const gitInfo = await getGitInfo(item.projectPath);
	const repository = resolveUploadRepositoryIdentity(item.projectPath, gitInfo);
	if (
		!isRepositoryAutoUploadAllowed(
			repository.repoKey,
			item.source,
			getLegacyRepositoryKeys(item.projectPath, gitInfo),
			input.configDir,
		) ||
		(await getProjectOrgId(item.projectPath)) !== item.organizationId
	)
		return "removed";
	const previous = await readTranscriptRevision(
		{
			endpoint: item.endpoint,
			organizationId: item.organizationId,
			transcriptScope: {
				actorId: input.actorId,
				provider: item.source,
				providerInstanceId: getOrCreateCliInstallationId(),
				sessionId: item.sessionId,
			},
		},
		input.configDir,
	);
	if (previous === undefined) return "removed";
	const built = await adapter.buildUploadRequest(
		{
			sessionId: item.sessionId,
			transcriptPath: item.transcriptPath,
			projectPath: item.projectPath,
		},
		{ gitInfo, organizationId: item.organizationId, uploadMode: "hook" },
	);
	const inferred = await inferSessionRepository(built);
	if (
		inferred &&
		isRepositoryAutoUploadDisabled(
			inferred.repository.repoKey,
			item.source,
			inferred.legacyKeys,
			input.configDir,
		)
	)
		return "removed";
	try {
		await input.capture({
			backgroundDelivery: "none",
			captureReason: "image-backlog",
			credentials: input.credentials,
			hookReceivedAt: new Date().toISOString(),
			lifecycle: "checkpoint",
			onWarning: input.onWarning,
			organizationId: item.organizationId,
			request: inferred
				? withSessionRepository(built, inferred.gitInfo)
				: built,
			requireDeliveredTranscript: true,
			terminalTranscript: previous.terminal,
		});
	} catch (error) {
		if (error instanceof TranscriptNotDeliveredError) return "removed";
		throw error;
	}
	return "captured";
}

async function readItem(path: string): Promise<ImageBacklogItem | undefined> {
	let value: unknown;
	try {
		value = JSON.parse(await readFile(path, "utf8"));
	} catch {
		return undefined;
	}
	if (typeof value !== "object" || value === null) return undefined;
	const item = value as Record<string, unknown>;
	const strings = [
		"endpoint",
		"organizationId",
		"actorId",
		"sessionId",
		"transcriptPath",
		"projectPath",
		"updatedAt",
	];
	if (
		item.version !== 1 ||
		(item.source !== "claude_code" && item.source !== "codex") ||
		!strings.every((key) => typeof item[key] === "string") ||
		!Number.isSafeInteger(item.followUps) ||
		!Number.isSafeInteger(item.deferred)
	)
		return undefined;
	return value as ImageBacklogItem;
}

async function listItemNames(configDir: string): Promise<readonly string[]> {
	const names = await readdir(getBacklogDirectory(configDir)).catch(() => []);
	return names.filter((name) => /^[a-f0-9]{64}\.json$/u.test(name)).sort();
}

function getBacklogDirectory(configDir: string): string {
	return join(configDir, "repository-evidence-image-backlog");
}

function getItemPath(configDir: string, key: ImageBacklogKey): string {
	const name = createHash("sha256")
		.update(
			[key.endpoint, key.organizationId, key.source, key.sessionId].join(
				"\u0000",
			),
			"utf8",
		)
		.digest("hex");
	return join(getBacklogDirectory(configDir), `${name}.json`);
}
