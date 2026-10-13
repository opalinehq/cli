import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import {
	lstat,
	open,
	readdir,
	readFile,
	realpath,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { getLogger } from "@logtape/logtape";
import { ORPCError } from "@orpc/client";
import type { ContractRouterClient } from "@orpc/contract";
import { ZodError } from "zod";
import {
	type contract,
	LIVE_SESSION_MAX_LINES_PER_STREAM,
	LIVE_SESSION_MAX_REQUEST_LINE_BYTES,
	LIVE_SESSION_MAX_STREAMS_PER_REQUEST,
	LIVE_SESSION_PROTOCOL,
	LIVE_SESSIONS_DISABLED_CODE,
	type LiveSessionAppendInput,
	LiveSessionAppendOutputSchema,
	LiveSessionStateOutputSchema,
	parseSafeApiEndpoint,
	SESSION_OWNERSHIP_CONFLICT_CODE,
} from "../contracts/index.js";
import {
	claudeCodeAdapter,
	isContainedPath,
	SUBAGENT_FILENAME_PATTERN,
} from "../internal/agent-adapters/index.js";
import {
	getRedactionBudgetAnomaly,
	MAX_REDACTION_RATIO,
	type RedactionCounts,
} from "../internal/secret-filter/index.js";
import { createRpcClient } from "./api-client.js";
import { getApiBaseOverride } from "./api-target.js";
import { isRepositoryAutoUploadAllowed } from "./auto-upload-config.js";
import { loadCredentials } from "./credentials.js";
import {
	DEFAULT_FILE_LEASE_OPTIONS,
	type FileLease,
	isProcessAlive,
	tryAcquireFileLease,
} from "./file-lease.js";
import { getGitInfo } from "./git-info.js";
import type { LiveSessionFollowerTarget } from "./live-session-launch.js";
import {
	createLineReadBuffer,
	type LiveSessionLine,
	processLiveSessionLine,
	type RawLiveSessionLine,
	readCompleteLines,
	readTail,
} from "./live-session-lines.js";
import {
	getLiveSessionsDirectory,
	isLiveSessionPaused,
	pauseLiveSessions,
} from "./live-session-pause.js";
import { getConfigDir } from "./local-state.js";
import {
	getLegacyRepositoryKeys,
	resolveUploadRepositoryIdentity,
} from "./repository-discovery.js";
import {
	createTranscriptSlimmer,
	type TranscriptSlimmer,
} from "./transcript-slim.js";
import { allowsInsecureEndpointFromEnv } from "./upload-endpoint.js";

const MIB = 1024 * 1024;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,200}$/u;
const MAX_STREAMS = 512;
/** Stop reading new lines while this much is waiting to be sent. */
const READ_PAUSE_PENDING_BYTES = 4 * MIB;
/** Hard ceiling for lines held in memory; beyond it the follower stops. */
const MAX_PENDING_BYTES = 16 * MIB;
/** Redaction ratio is judged only after this much input. */
const REDACTION_RATIO_MIN_INPUT_BYTES = 256 * 1024;
const MAX_IGNORED_SUBAGENT_ENTRIES = 4_096;
const MAX_OUT_OF_SYNC_RETRIES = 3;

export interface LiveSessionFollowerTiming {
	readonly tickMs: number;
	readonly debounceMs: number;
	readonly sendThresholdBytes: number;
	readonly startTimeCheckMs: number;
	readonly settingsCheckMs: number;
	readonly leaseWaitMs: number;
	readonly transcriptWaitMs: number;
	readonly maxRuntimeMs: number;
	readonly finalReadDelayMs: number;
	readonly finalFlushMs: number;
	readonly backoffInitialMs: number;
	readonly backoffMaxMs: number;
	readonly rateLimitBackoffMs: number;
	readonly capabilityTimeoutMs: number;
	readonly requestTimeoutMs: number;
}

export const DEFAULT_LIVE_SESSION_FOLLOWER_TIMING: LiveSessionFollowerTiming = {
	tickMs: 1_000,
	debounceMs: 1_500,
	sendThresholdBytes: MIB,
	startTimeCheckMs: 30_000,
	settingsCheckMs: 60_000,
	leaseWaitMs: 30_000,
	transcriptWaitMs: 10 * 60_000,
	maxRuntimeMs: 7 * 24 * 60 * 60_000,
	finalReadDelayMs: 300,
	finalFlushMs: 60_000,
	backoffInitialMs: 1_000,
	backoffMaxMs: 30_000,
	rateLimitBackoffMs: 60_000,
	capabilityTimeoutMs: 10_000,
	requestTimeoutMs: 30_000,
};

export interface LiveSessionFollowerOptions extends LiveSessionFollowerTarget {
	readonly configDir?: string;
	readonly timing?: Partial<LiveSessionFollowerTiming>;
}

export interface LiveSessionFollowerResult {
	readonly reason: string;
	readonly requests: number;
	readonly linesSent: number;
	readonly bytesSent: number;
	readonly streams: number;
}

interface Stream {
	readonly agentId: string | null;
	readonly path: string;
	slimmer: TranscriptSlimmer;
	/** Byte offset after the last complete line read into `pending`. */
	rawOffset: number;
	/** File size up to which everything readable was read; -1 = read again. */
	scannedTo: number;
	inode: number | undefined;
	committedLines: number;
	committedSha: string | null;
	pending: LiveSessionLine[];
	pendingBytes: number;
	firstPendingAt: number | undefined;
	needsReset: boolean;
	outOfSync: number;
}

interface StreamCursor {
	readonly committedLines: number;
	readonly lastLineSha256: string | null;
}

type Client = ContractRouterClient<typeof contract>;

class StopFollowing extends Error {
	constructor(readonly reason: string) {
		super(reason);
	}
}

const logger = getLogger(["opaline", "cli", "hook", "live"]);

/**
 * Follows one Claude Code session while its agent process runs and appends
 * new complete transcript lines (main transcript and subagents) to the live
 * session endpoints. Never throws: every failure ends the follower, and the
 * session still arrives through the upload at session end.
 */
export async function runLiveSessionFollower(
	options: LiveSessionFollowerOptions,
): Promise<LiveSessionFollowerResult> {
	const follower = new LiveSessionFollower(options);
	let reason: string;
	try {
		reason = await follower.run();
	} catch (error) {
		reason = error instanceof StopFollowing ? error.reason : "failed";
		if (!(error instanceof StopFollowing))
			logger.warn("Live session updates for {sessionId} failed: {error}", {
				error: describeError(error),
				sessionId: options.sessionId,
			});
	} finally {
		await follower.dispose();
	}
	const result = follower.result(reason);
	if (!follower.started)
		logger.debug("Live session updates for {sessionId} not started: {reason}", {
			reason,
			sessionId: options.sessionId,
		});
	else
		logger.info(
			"Live session updates for {sessionId} stopped: {reason} ({requests} requests, {linesSent} lines, {bytesSent} bytes, {streams} streams)",
			{ ...result, sessionId: options.sessionId },
		);
	return result;
}

class LiveSessionFollower {
	private readonly timing: LiveSessionFollowerTiming;
	private readonly configDir: string;
	private readonly startedAtMonotonic = performance.now();
	private readonly streams = new Map<string, Stream>();
	private readonly ignoredSubagentEntries = new Set<string>();
	private readonly redactionCounts: Record<string, number> = {};
	private readonly readBuffer = createLineReadBuffer();
	private client: Client | undefined;
	private lease: FileLease | null = null;
	private markerPath: string | undefined;
	private serverStreams: Map<string, StreamCursor> | undefined;
	private serverHadStreams = false;
	private agentStartTime: string | undefined;
	private repository: { repoKey: string; legacyKeys: string[] } | undefined;
	private gitRemote: string | undefined;
	private gitBranch: string | undefined;
	private subagentDirectory: string | undefined;
	private pendingBytes = 0;
	private pendingLines = 0;
	private inputBytes = 0;
	private redactedBytes = 0;
	private backoffUntil = 0;
	private backoffMs = 0;
	private streamLimitLogged = false;
	private requests = 0;
	private linesSent = 0;
	private bytesSent = 0;
	started = false;

	constructor(private readonly options: LiveSessionFollowerOptions) {
		this.timing = {
			...DEFAULT_LIVE_SESSION_FOLLOWER_TIMING,
			...options.timing,
		};
		this.configDir = options.configDir ?? getConfigDir();
	}

	result(reason: string): LiveSessionFollowerResult {
		return {
			bytesSent: this.bytesSent,
			linesSent: this.linesSent,
			reason,
			requests: this.requests,
			streams: this.streams.size,
		};
	}

	async run(): Promise<string> {
		const preflight = await this.preflight();
		if (preflight !== undefined) return preflight;
		this.lease = await this.acquireLease();
		if (!this.lease) return "already-following";
		this.started = true;
		logger.info(
			"Live session updates for {sessionId} started ({source}, agent process {agentPid})",
			{
				agentPid: this.options.agentPid,
				sessionId: this.options.sessionId,
				source: this.options.source ?? "unknown",
			},
		);
		await this.writeAgentMarker();
		return await this.follow();
	}

	async dispose(): Promise<void> {
		await this.removeAgentMarker().catch(() => undefined);
		await this.lease?.release().catch(() => undefined);
		this.lease = null;
	}

	// Startup ----------------------------------------------------------------

	private async preflight(): Promise<string | undefined> {
		const { options } = this;
		if (
			!SESSION_ID_PATTERN.test(options.sessionId) ||
			options.organizationId.length === 0 ||
			options.organizationId.length > 200 ||
			options.cwd.length > 4096 ||
			!Number.isSafeInteger(options.agentPid) ||
			options.agentPid <= 1
		)
			return "invalid-arguments";
		if (isLiveSessionPaused(this.configDir, options.organizationId))
			return "paused";
		if (!isProcessAlive(options.agentPid)) return "agent-exited";
		this.agentStartTime = await readProcessStartTime(options.agentPid);
		if (this.agentStartTime === "") return "agent-exited";
		const credentials = readCredentials(this.configDir);
		if (!credentials) return "not-authenticated";
		if (credentials.authType !== "api-key") return "api-key-required";
		const apiBase = (getApiBaseOverride() ?? credentials.apiBaseUrl).replace(
			/\/+$/u,
			"",
		);
		const endpoint = parseSafeApiEndpoint(`${apiBase}/rpc`, {
			allowPlaintext: allowsInsecureEndpointFromEnv(),
		});
		if (!endpoint.ok) return "endpoint-refused";
		const client = createRpcClient({
			authType: "api-key",
			rpcUrl: endpoint.url,
			token: credentials.token,
		});
		try {
			const status = await client.cli.authStatus(undefined, {
				signal: AbortSignal.timeout(this.timing.capabilityTimeoutMs),
			});
			if (status.capabilities?.liveSessions !== true) return "unsupported";
		} catch {
			return "capability-check-failed";
		}
		this.client = client;
		const gitInfo = await getGitInfo(options.cwd);
		const identity = resolveUploadRepositoryIdentity(options.cwd, gitInfo);
		this.repository = {
			legacyKeys: getLegacyRepositoryKeys(options.cwd, gitInfo),
			repoKey: identity.repoKey,
		};
		if (gitInfo.gitRemote && gitInfo.gitRemote.length <= 2048)
			this.gitRemote = gitInfo.gitRemote;
		if (gitInfo.branch && gitInfo.branch.length <= 1024)
			this.gitBranch = gitInfo.branch;
		return this.settingsStopReason();
	}

	private async acquireLease(): Promise<FileLease | null> {
		const path = join(
			getLiveSessionsDirectory(this.configDir),
			`${createHash("sha256").update(this.options.sessionId).digest("hex")}.lease`,
		);
		// The previous agent process's follower may still be finishing.
		const waitUntil = performance.now() + this.timing.leaseWaitMs;
		while (true) {
			const lease = await tryAcquireFileLease(path, DEFAULT_FILE_LEASE_OPTIONS);
			if (lease || performance.now() >= waitUntil) return lease;
			await sleep(this.timing.tickMs);
		}
	}

	/**
	 * One agent process runs one session at a time: a later SessionStart in the
	 * same process (`/clear`, `/resume`) ends this follower's session.
	 */
	private async writeAgentMarker(): Promise<void> {
		const path = join(
			getLiveSessionsDirectory(this.configDir),
			`agent-${this.options.agentPid}.json`,
		);
		const current = await readAgentMarker(path);
		if (current && current.startedAt > this.options.startedAt) return;
		const temporary = `${path}.${randomUUID()}.tmp`;
		try {
			await writeFile(
				temporary,
				JSON.stringify({
					sessionId: this.options.sessionId,
					startedAt: this.options.startedAt,
				}),
				{ flag: "wx", mode: 0o600 },
			);
			await rename(temporary, path);
			this.markerPath = path;
		} catch {
			await rm(temporary, { force: true }).catch(() => undefined);
		}
	}

	private async removeAgentMarker(): Promise<void> {
		if (!this.markerPath) return;
		const current = await readAgentMarker(this.markerPath);
		if (
			current?.sessionId === this.options.sessionId &&
			current.startedAt === this.options.startedAt
		)
			await rm(this.markerPath, { force: true });
	}

	private async isReplacedInAgent(): Promise<boolean> {
		const marker = await readAgentMarker(
			join(
				getLiveSessionsDirectory(this.configDir),
				`agent-${this.options.agentPid}.json`,
			),
		);
		return (
			marker !== undefined &&
			marker.sessionId !== this.options.sessionId &&
			marker.startedAt > this.options.startedAt
		);
	}

	private settingsStopReason(): string | undefined {
		const credentials = readCredentials(this.configDir);
		if (!credentials) return "not-authenticated";
		if (credentials.authType !== "api-key") return "api-key-required";
		const repository = this.repository;
		if (
			repository &&
			!isRepositoryAutoUploadAllowed(
				repository.repoKey,
				claudeCodeAdapter.source,
				repository.legacyKeys,
				this.configDir,
			)
		)
			return "repository-disabled";
		return undefined;
	}

	// Main loop --------------------------------------------------------------

	private async follow(): Promise<string> {
		const { timing } = this;
		let nextTickChecks = 0;
		let nextStartTimeCheck = this.startedAtMonotonic + timing.startTimeCheckMs;
		let nextSettingsCheck = this.startedAtMonotonic + timing.settingsCheckMs;
		while (true) {
			let now = performance.now();
			if (now - this.startedAtMonotonic >= timing.maxRuntimeMs)
				return "max-runtime";
			if (now >= nextTickChecks) {
				nextTickChecks = now + timing.tickMs;
				if (!isProcessAlive(this.options.agentPid))
					return await this.finish("agent-exited");
				if (now >= nextStartTimeCheck) {
					nextStartTimeCheck = now + timing.startTimeCheckMs;
					if (await this.agentProcessWasReplaced())
						return await this.finish("agent-exited");
				}
				if (await this.isReplacedInAgent())
					return await this.finish("session-replaced");
				if (now >= nextSettingsCheck) {
					nextSettingsCheck = now + timing.settingsCheckMs;
					const reason = this.settingsStopReason();
					if (reason) return reason;
				}
			}
			now = performance.now();
			if (!this.serverStreams) {
				if (now >= this.backoffUntil) await this.loadServerState();
			} else {
				await this.discoverStreams();
				if (
					!this.streams.has("") &&
					now - this.startedAtMonotonic >= timing.transcriptWaitMs
				)
					return "transcript-missing";
				const backlog = await this.readStreams(false);
				this.checkLimits();
				now = performance.now();
				if (now >= this.backoffUntil && this.shouldSend(now, backlog)) {
					await this.sendOnce(false);
					// Catching up: keep reading and sending without waiting.
					if (
						performance.now() >= this.backoffUntil &&
						(backlog || this.hasFullBatch())
					)
						continue;
				}
			}
			await sleep(this.nextDelay(nextTickChecks));
		}
	}

	private nextDelay(nextTickChecks: number): number {
		const now = performance.now();
		let wakeAt = nextTickChecks;
		const firstPending = this.oldestPendingAt();
		if (firstPending !== undefined)
			wakeAt = Math.min(
				wakeAt,
				Math.max(firstPending + this.timing.debounceMs, this.backoffUntil),
			);
		return Math.max(0, Math.min(this.timing.tickMs, wakeAt - now));
	}

	private shouldSend(now: number, backlog: boolean): boolean {
		if (this.pendingLines === 0 && !this.hasEmptyReset()) return false;
		if (backlog || this.hasFullBatch()) return true;
		const firstPending = this.oldestPendingAt();
		return (
			firstPending === undefined || now - firstPending >= this.timing.debounceMs
		);
	}

	private hasFullBatch(): boolean {
		return this.pendingBytes >= this.timing.sendThresholdBytes;
	}

	private hasEmptyReset(): boolean {
		for (const stream of this.streams.values())
			if (stream.needsReset && stream.pending.length === 0) return true;
		return false;
	}

	private oldestPendingAt(): number | undefined {
		let oldest: number | undefined;
		for (const stream of this.streams.values())
			if (
				stream.firstPendingAt !== undefined &&
				(oldest === undefined || stream.firstPendingAt < oldest)
			)
				oldest = stream.firstPendingAt;
		return oldest;
	}

	private checkLimits(): void {
		if (this.pendingBytes > MAX_PENDING_BYTES)
			throw new StopFollowing("pending-limit");
		if (this.inputBytes < REDACTION_RATIO_MIN_INPUT_BYTES) return;
		const anomaly = getRedactionBudgetAnomaly(
			this.redactedBytes,
			this.inputBytes,
			this.redactionCounts,
		);
		if (anomaly) {
			logger.warn(
				"Live session updates for {sessionId} stopped: known-pattern redaction exceeded {ratio} of the input ({redactedBytes} of {inputBytes} bytes)",
				{
					inputBytes: anomaly.inputBytes,
					ratio: MAX_REDACTION_RATIO,
					redactedBytes: anomaly.redactedBytes,
					sessionId: this.options.sessionId,
				},
			);
			throw new StopFollowing("redaction-budget");
		}
	}

	private async agentProcessWasReplaced(): Promise<boolean> {
		if (this.agentStartTime === undefined) return false;
		const current = await readProcessStartTime(this.options.agentPid);
		return current !== undefined && current !== this.agentStartTime;
	}

	/** The agent is gone: send everything, including a final JSON tail, then `ended`. */
	private async finish(reason: string): Promise<string> {
		await sleep(this.timing.finalReadDelayMs);
		const deadline = performance.now() + this.timing.finalFlushMs;
		while (!this.serverStreams) {
			if (performance.now() >= deadline) return `${reason}-unflushed`;
			await this.waitForBackoff(deadline);
			await this.loadServerState();
		}
		await this.discoverStreams();
		while (true) {
			const backlog = await this.readStreams(true);
			this.checkLimits();
			const more = backlog || this.pendingLines > 0 || this.hasEmptyReset();
			if (!more && !this.hasSentOrKnown()) return reason;
			if (performance.now() >= deadline) return `${reason}-unflushed`;
			await this.waitForBackoff(deadline);
			if (performance.now() >= deadline) return `${reason}-unflushed`;
			const finished = await this.sendOnce(!backlog);
			if (finished) return reason;
		}
	}

	private hasSentOrKnown(): boolean {
		return this.linesSent > 0 || this.serverHadStreams;
	}

	private async waitForBackoff(deadline: number): Promise<void> {
		const wait = Math.min(this.backoffUntil, deadline) - performance.now();
		if (wait > 0) await sleep(wait);
	}

	// Server state -----------------------------------------------------------

	private target() {
		return {
			organizationId: this.options.organizationId,
			protocol: LIVE_SESSION_PROTOCOL,
			sessionId: this.options.sessionId,
			source: "claude_code",
		} as const;
	}

	private async loadServerState(): Promise<void> {
		const client = this.requireClient();
		try {
			this.requests += 1;
			const state = LiveSessionStateOutputSchema.parse(
				await client.liveSession.state(this.target(), {
					signal: AbortSignal.timeout(this.timing.requestTimeoutMs),
				}),
			);
			this.serverStreams = new Map(
				state.streams.map((stream) => [
					stream.agentId ?? "",
					{
						committedLines: stream.committedLines,
						lastLineSha256: stream.lastLineSha256,
					},
				]),
			);
			this.serverHadStreams = state.streams.some(
				(stream) => stream.committedLines > 0,
			);
			this.backoffMs = 0;
		} catch (error) {
			await this.handleRequestError(error);
		}
	}

	private requireClient(): Client {
		if (!this.client) throw new StopFollowing("not-started");
		return this.client;
	}

	// Streams ----------------------------------------------------------------

	private async discoverStreams(): Promise<void> {
		if (!this.streams.has("")) {
			try {
				const metadata = await stat(this.options.transcriptPath);
				if (metadata.isFile())
					await this.addStream(null, this.options.transcriptPath);
			} catch {
				// Claude Code creates the transcript with the first record.
			}
		}
		const directory = await this.resolveSubagentDirectory();
		if (!directory) return;
		let names: string[];
		try {
			names = await readdir(directory);
		} catch {
			return;
		}
		for (const name of names) {
			const match = SUBAGENT_FILENAME_PATTERN.exec(name);
			const agentId = match?.[1];
			if (!agentId || this.streams.has(agentId)) continue;
			if (this.ignoredSubagentEntries.has(name)) continue;
			if (this.streams.size >= MAX_STREAMS) {
				if (!this.streamLimitLogged) {
					this.streamLimitLogged = true;
					logger.warn(
						"Live session updates for {sessionId} follow at most {limit} transcripts",
						{ limit: MAX_STREAMS, sessionId: this.options.sessionId },
					);
				}
				return;
			}
			const path = join(directory, name);
			try {
				const metadata = await lstat(path);
				const canonical = metadata.isFile() ? await realpath(path) : undefined;
				if (!canonical || !isContainedPath(directory, canonical)) {
					if (this.ignoredSubagentEntries.size < MAX_IGNORED_SUBAGENT_ENTRIES)
						this.ignoredSubagentEntries.add(name);
					continue;
				}
				await this.addStream(agentId, canonical);
			} catch {
				// Removed or replaced while scanning; seen again next tick.
			}
		}
	}

	/** Only the canonical `<transcript dir>/<session id>/subagents` directory. */
	private async resolveSubagentDirectory(): Promise<string | undefined> {
		if (this.subagentDirectory) return this.subagentDirectory;
		try {
			const parent = await realpath(dirname(this.options.transcriptPath));
			const directory = await realpath(
				join(parent, this.options.sessionId, "subagents"),
			);
			if (isContainedPath(parent, directory)) {
				this.subagentDirectory = directory;
				return directory;
			}
		} catch {
			// Not created until the first subagent runs.
		}
		return undefined;
	}

	private async addStream(agentId: string | null, path: string): Promise<void> {
		const stream: Stream = {
			agentId,
			committedLines: 0,
			committedSha: null,
			firstPendingAt: undefined,
			inode: undefined,
			needsReset: false,
			outOfSync: 0,
			path,
			pending: [],
			pendingBytes: 0,
			rawOffset: 0,
			scannedTo: -1,
			slimmer: createTranscriptSlimmer(),
		};
		const known = this.serverStreams?.get(agentId ?? "");
		if (known && known.committedLines > 0)
			await this.locate(stream, known.committedLines, known.lastLineSha256);
		this.streams.set(agentId ?? "", stream);
	}

	/**
	 * Resumes a stream after the server's last committed line when the local
	 * file still produces that exact line; otherwise the stream starts over.
	 */
	private async locate(
		stream: Stream,
		committedLines: number,
		lastLineSha256: string | null,
	): Promise<void> {
		this.dropPending(stream, stream.pending.length);
		stream.slimmer = createTranscriptSlimmer();
		stream.scannedTo = -1;
		stream.outOfSync = 0;
		let offset: number | undefined;
		if (committedLines > 0 && lastLineSha256 !== null) {
			try {
				offset = await findLineEnd(
					stream.path,
					committedLines - 1,
					lastLineSha256,
					stream.slimmer,
					this.readBuffer,
				);
			} catch {
				offset = undefined;
			}
		}
		if (offset === undefined) {
			this.resetStream(stream);
			return;
		}
		stream.rawOffset = offset;
		stream.committedLines = committedLines;
		stream.committedSha = lastLineSha256;
		stream.needsReset = false;
	}

	private resetStream(stream: Stream): void {
		this.dropPending(stream, stream.pending.length);
		stream.slimmer = createTranscriptSlimmer();
		stream.rawOffset = 0;
		stream.scannedTo = -1;
		stream.committedLines = 0;
		stream.committedSha = null;
		stream.needsReset = true;
		stream.outOfSync = 0;
	}

	private dropPending(stream: Stream, count: number): void {
		if (count <= 0) return;
		const dropped = stream.pending.splice(0, count);
		const bytes = dropped.reduce((total, line) => total + line.bytes, 0);
		stream.pendingBytes -= bytes;
		this.pendingBytes -= bytes;
		this.pendingLines -= dropped.length;
		if (stream.pending.length === 0) stream.firstPendingAt = undefined;
	}

	/**
	 * Reads new complete lines of every stream. Returns true when reading
	 * stopped early because enough is waiting to be sent.
	 */
	private async readStreams(final: boolean): Promise<boolean> {
		for (const stream of this.orderedStreams()) {
			if (this.pendingBytes >= READ_PAUSE_PENDING_BYTES) return true;
			let metadata: Stats;
			try {
				metadata = await stat(stream.path);
			} catch {
				continue;
			}
			if (
				metadata.size < stream.rawOffset ||
				(stream.inode !== undefined && metadata.ino !== stream.inode)
			) {
				this.resetStream(stream);
			}
			stream.inode = metadata.ino;
			if (metadata.size === stream.scannedTo && !final) continue;
			const handle = await open(stream.path, "r");
			try {
				const read = await readCompleteLines(
					handle,
					stream.rawOffset,
					metadata.size,
					(line) => {
						this.enqueue(stream, line);
						return this.pendingBytes < READ_PAUSE_PENDING_BYTES;
					},
					this.readBuffer,
				);
				stream.rawOffset = read.endOffset;
				stream.scannedTo = read.stopped ? -1 : metadata.size;
				if (read.stopped) return true;
				if (final && stream.rawOffset < metadata.size) {
					const tail = await readTail(handle, stream.rawOffset, metadata.size);
					if (tail && isJson(tail)) {
						this.enqueue(stream, { bytes: tail, kind: "line" });
						stream.rawOffset = metadata.size;
					}
				}
			} finally {
				await handle.close();
			}
		}
		return false;
	}

	private enqueue(stream: Stream, raw: RawLiveSessionLine): void {
		const line = processLiveSessionLine(raw, stream.slimmer);
		this.inputBytes += line.inputBytes;
		this.redactedBytes += line.redactedBytes;
		addCounts(this.redactionCounts, line.redactions);
		stream.pending.push({
			bytes: line.bytes,
			sha256: line.sha256,
			text: line.text,
		});
		stream.pendingBytes += line.bytes;
		this.pendingBytes += line.bytes;
		this.pendingLines += 1;
		stream.firstPendingAt ??= performance.now();
	}

	private orderedStreams(): Stream[] {
		const main = this.streams.get("");
		const subagents = [...this.streams.values()]
			.filter((stream) => stream.agentId !== null)
			.sort((left, right) =>
				(left.agentId ?? "") < (right.agentId ?? "") ? -1 : 1,
			);
		return main ? [main, ...subagents] : subagents;
	}

	// Sending ----------------------------------------------------------------

	/**
	 * Sends one append with as many pending lines as the request limits allow.
	 * Returns true when `ended` was requested and everything was committed.
	 */
	private async sendOnce(endedIfComplete: boolean): Promise<boolean> {
		const batch: { stream: Stream; lines: LiveSessionLine[] }[] = [];
		let batchBytes = 0;
		for (const stream of this.orderedStreams()) {
			if (batch.length >= LIVE_SESSION_MAX_STREAMS_PER_REQUEST) break;
			if (stream.pending.length === 0 && !stream.needsReset) continue;
			const lines: LiveSessionLine[] = [];
			for (const line of stream.pending) {
				if (lines.length >= LIVE_SESSION_MAX_LINES_PER_STREAM) break;
				if (batchBytes + line.bytes > LIVE_SESSION_MAX_REQUEST_LINE_BYTES)
					break;
				lines.push(line);
				batchBytes += line.bytes;
			}
			if (lines.length === 0 && stream.pending.length > 0) break;
			batch.push({ lines, stream });
		}
		const complete =
			endedIfComplete &&
			batch.every(
				({ lines, stream }) => lines.length === stream.pending.length,
			) &&
			[...this.streams.values()].every(
				(stream) =>
					(stream.pending.length === 0 && !stream.needsReset) ||
					batch.some((item) => item.stream === stream),
			);
		const input: LiveSessionAppendInput = {
			...this.target(),
			projectPath: this.options.cwd,
			...(this.gitRemote ? { gitRemote: this.gitRemote } : {}),
			...(this.gitBranch ? { gitBranch: this.gitBranch } : {}),
			...(complete ? { ended: true } : {}),
			streams: batch.map(({ lines, stream }) => ({
				agentId: stream.agentId,
				...(stream.needsReset ? { reset: true } : {}),
				lines: lines.map((line) => line.text),
				previousLineSha256: stream.committedSha,
				startLine: stream.committedLines,
			})),
		};
		let output: ReturnType<typeof LiveSessionAppendOutputSchema.parse>;
		try {
			this.requests += 1;
			output = LiveSessionAppendOutputSchema.parse(
				await this.requireClient().liveSession.append(input, {
					signal: AbortSignal.timeout(this.timing.requestTimeoutMs),
				}),
			);
		} catch (error) {
			await this.handleRequestError(error);
			return false;
		}
		this.backoffMs = 0;
		const results = new Map(
			output.streams.map((stream) => [stream.agentId ?? "", stream]),
		);
		let committedAll = true;
		for (const { lines, stream } of batch) {
			const result = results.get(stream.agentId ?? "");
			const expectedLines = stream.committedLines + lines.length;
			const expectedSha = lines.at(-1)?.sha256 ?? stream.committedSha;
			if (
				result &&
				result.status !== "out-of-sync" &&
				result.committedLines === expectedLines &&
				result.lastLineSha256 === expectedSha
			) {
				this.dropPending(stream, lines.length);
				stream.committedLines = expectedLines;
				stream.committedSha = expectedSha;
				stream.needsReset = false;
				stream.outOfSync = 0;
				this.linesSent += lines.length;
				this.bytesSent += lines.reduce((total, line) => total + line.bytes, 0);
				continue;
			}
			committedAll = false;
			if (result) {
				await this.reconcile(
					stream,
					result.committedLines,
					result.lastLineSha256,
				);
			} else {
				// A response without this stream: start it over.
				this.resetStream(stream);
			}
		}
		return complete && committedAll;
	}

	/**
	 * The server's committed state differs from what this follower expected:
	 * adopt it when it is a prefix of the lines sent (a retried chunk whose
	 * response was lost), otherwise look it up in the local file.
	 */
	private async reconcile(
		stream: Stream,
		committedLines: number,
		lastLineSha256: string | null,
	): Promise<void> {
		stream.outOfSync += 1;
		if (stream.outOfSync > MAX_OUT_OF_SYNC_RETRIES) {
			this.resetStream(stream);
			return;
		}
		const base = stream.committedLines;
		const ahead = committedLines - base;
		if (ahead >= 0 && ahead <= stream.pending.length) {
			const sha =
				ahead === 0 ? stream.committedSha : stream.pending[ahead - 1]?.sha256;
			if ((committedLines === 0 ? null : sha) === lastLineSha256) {
				this.dropPending(stream, ahead);
				stream.committedLines = committedLines;
				stream.committedSha = lastLineSha256;
				stream.needsReset = false;
				return;
			}
		}
		await this.locate(stream, committedLines, lastLineSha256);
	}

	private async handleRequestError(error: unknown): Promise<void> {
		if (error instanceof ORPCError) {
			if (error.code === LIVE_SESSIONS_DISABLED_CODE) {
				const data = error.data as
					| { pauseSeconds?: unknown; scope?: unknown }
					| undefined;
				await pauseLiveSessions(
					this.configDir,
					this.options.organizationId,
					data?.scope === "workspace" ? "workspace" : "global",
					typeof data?.pauseSeconds === "number" ? data.pauseSeconds : 3_600,
				).catch((pauseError: unknown) =>
					logger.warn("Could not record the live session pause: {error}", {
						error: describeError(pauseError),
					}),
				);
				throw new StopFollowing("disabled");
			}
			if (error.code === SESSION_OWNERSHIP_CONFLICT_CODE)
				throw new StopFollowing("ownership-conflict");
			if (error.status === 401 || error.status === 403)
				throw new StopFollowing("unauthorized");
			if (error.status === 429) {
				this.backoffUntil = performance.now() + this.timing.rateLimitBackoffMs;
				return;
			}
			if (error.status < 500 && error.status !== 408) {
				logger.warn(
					"Live session updates for {sessionId} were rejected ({status} {code})",
					{
						code: error.code,
						sessionId: this.options.sessionId,
						status: error.status,
					},
				);
				throw new StopFollowing(`rejected-${error.status}`);
			}
		} else if (error instanceof ZodError) {
			throw new StopFollowing("invalid-response");
		}
		this.backoffMs =
			this.backoffMs === 0
				? this.timing.backoffInitialMs
				: Math.min(this.backoffMs * 2, this.timing.backoffMaxMs);
		this.backoffUntil = performance.now() + this.backoffMs;
	}
}

/**
 * Byte offset just after line `lineIndex` when that line, through the live
 * pipeline, hashes to `sha256`; undefined when the file has fewer complete
 * lines or a different line there.
 */
async function findLineEnd(
	path: string,
	lineIndex: number,
	sha256: string,
	slimmer: TranscriptSlimmer,
	buffer: Buffer,
): Promise<number | undefined> {
	const handle = await open(path, "r");
	try {
		const size = (await handle.stat()).size;
		let index = 0;
		let matched = false;
		const read = await readCompleteLines(
			handle,
			0,
			size,
			(line) => {
				if (index < lineIndex) {
					index += 1;
					return true;
				}
				matched = processLiveSessionLine(line, slimmer).sha256 === sha256;
				return false;
			},
			buffer,
		);
		return read.stopped && matched ? read.endOffset : undefined;
	} finally {
		await handle.close();
	}
}

/**
 * The process start time from `ps` (POSIX), to tell a reused PID apart.
 * "" when no such process exists, undefined when it cannot be determined.
 */
function readProcessStartTime(pid: number): Promise<string | undefined> {
	if (process.platform === "win32") return Promise.resolve(undefined);
	return new Promise((resolve) => {
		execFile(
			"ps",
			["-o", "lstart=", "-p", String(pid)],
			{
				env: { ...process.env, LC_ALL: "C" },
				timeout: 5_000,
				windowsHide: true,
			},
			(error, stdout) => {
				if (error)
					resolve(
						typeof error.code === "number" && error.code === 1 && !stdout.trim()
							? ""
							: undefined,
					);
				else resolve(stdout.trim());
			},
		);
	});
}

async function readAgentMarker(
	path: string,
): Promise<{ sessionId: string; startedAt: number } | undefined> {
	try {
		const value: unknown = JSON.parse(await readFile(path, "utf8"));
		if (
			typeof value === "object" &&
			value !== null &&
			"sessionId" in value &&
			typeof value.sessionId === "string" &&
			"startedAt" in value &&
			typeof value.startedAt === "number"
		)
			return { sessionId: value.sessionId, startedAt: value.startedAt };
	} catch {
		// Missing or being replaced.
	}
	return undefined;
}

function readCredentials(configDir: string) {
	try {
		const credentials = loadCredentials("read-only", configDir);
		return credentials?.user ? credentials : null;
	} catch {
		return null;
	}
}

function addCounts(target: Record<string, number>, counts: RedactionCounts) {
	for (const [ruleId, count] of Object.entries(counts))
		target[ruleId] = (target[ruleId] ?? 0) + count;
}

function isJson(bytes: Buffer): boolean {
	try {
		JSON.parse(bytes.toString("utf8"));
		return true;
	} catch {
		return false;
	}
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}
