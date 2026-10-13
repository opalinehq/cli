import { type FSWatcher, type Stats, watch } from "node:fs";
import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getLogger } from "@logtape/logtape";
import { ORPCError } from "@orpc/client";
import type { ContractRouterClient } from "@orpc/contract";
import {
	type contract,
	LIVE_SESSION_MAX_LINES_PER_STREAM,
	LIVE_SESSION_MAX_REQUEST_LINE_BYTES,
	LIVE_SESSION_MAX_REQUEST_LINES,
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
	isContainedPath,
	SUBAGENT_FILENAME_PATTERN,
} from "../internal/agent-adapters/index.js";
import {
	getRedactionBudgetAnomaly,
	type RedactionCounts,
} from "../internal/secret-filter/index.js";
import { createRpcClient } from "./api-client.js";
import { getApiBaseOverride } from "./api-target.js";
import { isRepositoryAutoUploadAllowed } from "./auto-upload-config.js";
import { CodexRolloutIndex } from "./codex-live-rollouts.js";
import { type Credentials, loadCredentials } from "./credentials.js";
import { type FileLease, tryAcquireFileLease } from "./file-lease.js";
import { getGitInfo } from "./git-info.js";
import {
	discardFollowerLease,
	getLiveSessionFollowerLeasePath,
	isHealthyFollowerRunning,
	isSandboxedEnvironment,
	LIVE_FOLLOWER_LEASE_OPTIONS,
	writeFollowerMarker,
} from "./live-session-launch.js";
import {
	createLineReadBuffer,
	LIVE_SESSION_MAX_WIRE_BYTES,
	type LiveSessionLine,
	processLiveSessionLine,
	type RawLiveSessionLine,
	readCompleteLines,
	readTail,
} from "./live-session-lines.js";
import {
	getLiveTranscriptRoots,
	isAllowedTranscriptPath,
	type LiveTranscriptRoots,
	openRegularFile,
} from "./live-session-paths.js";
import {
	getLiveSessionsDirectory,
	isLiveSessionPaused,
	pauseLiveSessions,
} from "./live-session-pause.js";
import {
	getLiveSessionKey,
	type LiveSessionSource,
	listLiveSessionRegistrations,
	removeAllLiveSessionRegistrations,
	removeLiveSessionRegistration,
	type StoredLiveSessionRegistration,
} from "./live-session-registry.js";
import { getConfigDir } from "./local-state.js";
import {
	isSameStartIdentity,
	readProcessStartIdentities,
} from "./process-identity.js";
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
const MAX_SESSIONS = 64;
const MAX_STREAMS_PER_SESSION = 512;
/**
 * Lines read ahead of sending, across all sessions. Reading pauses at this
 * budget; the transcript files are the buffer.
 */
const READ_AHEAD_BYTES = 2 * MIB;
/** Redaction ratio is judged only after this much input of a session. */
const REDACTION_RATIO_MIN_INPUT_BYTES = 256 * 1024;
const MAX_IGNORED_ENTRIES = 100_000;
const MAX_OUT_OF_SYNC_RETRIES = 3;
const MAX_WATCHED_DIRECTORIES = 64;
/**
 * Ends the follower and forgets every registration: the server switched
 * live sessions off, or there are no usable credentials.
 */
const FORGET_REGISTRATIONS_REASONS = new Set([
	"api-key-required",
	"disabled",
	"not-authenticated",
	"paused",
	"unsupported",
]);

export interface LiveSessionFollowerTiming {
	readonly tickMs: number;
	/** Pending lines wait this long for more before they are sent. */
	readonly debounceMs: number;
	readonly sendThresholdBytes: number;
	/** How often process start identities are compared (PID reuse guard). */
	readonly identityCheckMs: number;
	/** Credentials, pauses and repository settings (also on file changes). */
	readonly settingsCheckMs: number;
	/** `cli.authStatus` (`liveSessions` capability). */
	readonly capabilityCheckMs: number;
	/** Without a confirmed capability for this long, exit (keeping registrations). */
	readonly capabilityGiveUpMs: number;
	/** Consecutive failed capability checks after which the lease is released. */
	readonly maxCapabilityFailures: number;
	/** Exit after this long without registered sessions. */
	readonly idleExitMs: number;
	readonly leaseWaitMs: number;
	readonly transcriptWaitMs: number;
	readonly maxSessionMs: number;
	readonly finalReadDelayMs: number;
	readonly finalFlushMs: number;
	/** Bounded flush on SIGTERM/SIGINT/SIGHUP. */
	readonly signalFlushMs: number;
	readonly backoffInitialMs: number;
	readonly backoffMaxMs: number;
	readonly rateLimitBackoffMs: number;
	/** After a 401 that the current credentials also get. */
	readonly authBackoffInitialMs: number;
	readonly authBackoffMaxMs: number;
	/** A stream that falls out of sync again after a reset waits this long (doubling). */
	readonly resetBackoffInitialMs: number;
	readonly resetBackoffMaxMs: number;
	/** Consecutive resets of one stream that end the session. */
	readonly maxConsecutiveResets: number;
	readonly capabilityTimeoutMs: number;
	readonly requestTimeoutMs: number;
	readonly sendConcurrency: number;
	/** Subagent directories are listed again when they change, and at least this often. */
	readonly directoryRescanMs: number;
	/** A hook-parent agent process that exits this soon was not the agent. */
	readonly orphanGraceMs: number;
	/** Such a session ends after its transcript is idle this long. */
	readonly orphanIdleMs: number;
	/** A Codex session without a known `codex` process ends after this idle time. */
	readonly codexOrphanIdleMs: number;
	/** A Codex session of a running `codex` process ends after this idle time. */
	readonly codexIdleMs: number;
	/**
	 * A registration whose agent was already gone when first seen is flushed
	 * and ended; when older than this it is only forgotten.
	 */
	readonly staleRegistrationMs: number;
}

export const DEFAULT_LIVE_SESSION_FOLLOWER_TIMING: LiveSessionFollowerTiming = {
	tickMs: 1_000,
	debounceMs: 500,
	sendThresholdBytes: MIB,
	identityCheckMs: 30_000,
	settingsCheckMs: 60_000,
	capabilityCheckMs: 60_000,
	capabilityGiveUpMs: 120_000,
	maxCapabilityFailures: 5,
	idleExitMs: 60_000,
	leaseWaitMs: 2_000,
	transcriptWaitMs: 10 * 60_000,
	maxSessionMs: 7 * 24 * 60 * 60_000,
	finalReadDelayMs: 300,
	finalFlushMs: 60_000,
	signalFlushMs: 3_000,
	backoffInitialMs: 1_000,
	backoffMaxMs: 30_000,
	rateLimitBackoffMs: 60_000,
	authBackoffInitialMs: 60_000,
	authBackoffMaxMs: 10 * 60_000,
	resetBackoffInitialMs: 5_000,
	resetBackoffMaxMs: 10 * 60_000,
	maxConsecutiveResets: 5,
	capabilityTimeoutMs: 10_000,
	requestTimeoutMs: 15_000,
	sendConcurrency: 3,
	directoryRescanMs: 30_000,
	orphanGraceMs: 5_000,
	orphanIdleMs: 10 * 60_000,
	codexOrphanIdleMs: 30 * 60_000,
	codexIdleMs: 6 * 60 * 60_000,
	staleRegistrationMs: 7 * 24 * 60 * 60_000,
};

export interface LiveSessionFollowerOptions {
	readonly configDir?: string;
	readonly timing?: Partial<LiveSessionFollowerTiming>;
	/** Where transcripts may live (defaults from the environment). */
	readonly transcriptRoots?: LiveTranscriptRoots;
	/** Handle SIGTERM/SIGINT/SIGHUP (the detached process does). */
	readonly handleSignals?: boolean;
	/**
	 * Starts a successor when this follower fails unexpectedly while sessions
	 * are still registered (the detached process spawns a new one).
	 */
	readonly respawn?: () => void;
}

export interface LiveSessionFollowerResult {
	readonly reason: string;
	readonly sessions: number;
	readonly requests: number;
	readonly linesSent: number;
	readonly bytesSent: number;
}

interface Stream {
	readonly agentId: string | null;
	readonly path: string;
	slimmer: TranscriptSlimmer;
	/** Byte offset after the last complete line read into `pending`. */
	rawOffset: number;
	/** File size up to which everything readable was read; -1 = read again. */
	scannedTo: number;
	dev: number | undefined;
	inode: number | undefined;
	committedLines: number;
	committedSha: string | null;
	pending: LiveSessionLine[];
	pendingBytes: number;
	firstPendingAt: number | undefined;
	needsReset: boolean;
	outOfSync: number;
	/** Resets since the last in-sync append (circuit breaker). */
	consecutiveResets: number;
	/** Not sent before this time (monotonic). */
	holdUntil: number;
	/** Bumped whenever offsets or pending lines are replaced. */
	epoch: number;
	/** A server position still to be found in the file (an earlier read failed). */
	locate: StreamCursor | undefined;
}

interface StreamCursor {
	readonly committedLines: number;
	readonly lastLineSha256: string | null;
}

interface Ending {
	readonly reason: string;
	/** Monotonic time from which the final read may start. */
	readonly readAt: number;
	readonly deadline: number;
}

interface Session {
	readonly key: string;
	readonly source: LiveSessionSource;
	readonly sessionId: string;
	readonly organizationId: string;
	readonly transcriptPath: string;
	readonly cwd: string;
	/** Monotonic creation time. */
	readonly createdAt: number;
	registrations: StoredLiveSessionRegistration[];
	readonly streams: Map<string, Stream>;
	readonly ignoredEntries: Set<string>;
	readonly watched: Set<string>;
	serverStreams: Map<string, StreamCursor> | undefined;
	serverHadStreams: boolean;
	serverEnded: boolean;
	/** Streams were discovered at least once since the server state arrived. */
	discovered: boolean;
	repository: { repoKey: string; legacyKeys: string[] } | undefined;
	gitRemote: string | undefined;
	gitBranch: string | undefined;
	subagentDirectory: string | undefined;
	subagentDirectoryMtime: number;
	subagentScannedAt: number;
	pendingBytes: number;
	pendingLines: number;
	inputBytes: number;
	redactedBytes: number;
	readonly redactionCounts: Record<string, number>;
	/** Wall time of the last new transcript bytes (or of registration). */
	lastActivityAt: number;
	ending: Ending | undefined;
	/** A request (state or append) of this session is in flight. */
	busy: boolean;
	streamLimitLogged: boolean;
	orphanLogged: boolean;
	linesSent: number;
}

interface Batch {
	readonly items: { stream: Stream; lines: LiveSessionLine[]; epoch: number }[];
	readonly ended: boolean;
}

type Client = ContractRouterClient<typeof contract>;

class StopFollowing extends Error {
	constructor(readonly reason: string) {
		super(reason);
	}
}

class StopSession extends Error {
	constructor(readonly reason: string) {
		super(reason);
	}
}

const logger = getLogger(["opaline", "cli", "hook", "live"]);

/**
 * The machine-wide live session follower. It follows every registered Claude
 * Code and Codex session while its agent process runs, appending new complete
 * transcript lines (main transcript and sub-agents) to the live session
 * endpoints. Never throws: every failure ends a session or the follower, and
 * sessions still arrive through their regular uploads.
 */
export async function runLiveSessionFollower(
	options: LiveSessionFollowerOptions = {},
): Promise<LiveSessionFollowerResult> {
	const follower = new LiveSessionFollower(options);
	const signals = ["SIGTERM", "SIGINT", "SIGHUP"] as const;
	const onSignal = (signal: string) => follower.requestStop(signal);
	if (options.handleSignals)
		for (const signal of signals) process.on(signal, onSignal);
	let reason: string;
	try {
		reason = await follower.run();
	} catch (error) {
		reason = error instanceof StopFollowing ? error.reason : "failed";
		if (!(error instanceof StopFollowing))
			logger.warn("Live session follower failed: {error}", {
				error: describeError(error),
			});
	} finally {
		if (options.handleSignals)
			for (const signal of signals) process.removeListener(signal, onSignal);
	}
	await follower.dispose(reason);
	return follower.result(reason);
}

class LiveSessionFollower {
	private readonly timing: LiveSessionFollowerTiming;
	private readonly configDir: string;
	private readonly roots: LiveTranscriptRoots;
	private readonly startedAt = performance.now();
	private readonly sessions = new Map<string, Session>();
	private readonly readBuffer = createLineReadBuffer();
	private readonly codexRollouts = new CodexRolloutIndex();
	/** Registration file → wall time its agent process was last seen alive. */
	private readonly lastSeenAlive = new Map<string, number>();
	/** Agent pid → start identity first observed by the follower. */
	private readonly observedIdentities = new Map<number, string>();
	/** Agent pid → start identity at the latest check. */
	private readonly currentIdentities = new Map<number, string>();
	/** Pids whose start identity changed since first observed (reused). */
	private readonly replacedIdentities = new Set<number>();
	private readonly identityAttempted = new Set<number>();
	/** Registration files being removed (not to be followed again meanwhile). */
	private readonly removing = new Set<string>();
	private readonly rejectedPaths = new Set<string>();
	private readonly tasks = new Set<Promise<void>>();
	private readonly watchers = new Map<string, FSWatcher>();
	private readonly fingerprints = new Map<string, string>();
	private identityTask: Promise<void> | undefined;
	private capabilityTask: Promise<void> | undefined;
	private lease: FileLease | null = null;
	private started = false;
	private client: Client | undefined;
	private clientKey: string | undefined;
	private capabilityConfirmed = false;
	private stopReason: string | undefined;
	private stopSignal: string | undefined;
	private wakeUp: ((reason: "file" | "task") => void) | undefined;
	private pendingBytes = 0;
	private busyRequests = 0;
	private backoffUntil = 0;
	private backoffMs = 0;
	private authBlockedUntil = 0;
	private authBackoffMs = 0;
	private sessionLimitLogged = false;
	private rotation = 0;
	private requests = 0;
	private linesSent = 0;
	private bytesSent = 0;
	private sessionsFollowed = 0;

	/** Renewed only while the main loop makes progress. */
	private readonly leaseOptions = {
		...LIVE_FOLLOWER_LEASE_OPTIONS,
		shouldRenew: () => performance.now() - this.lastProgressAt < 45_000,
	};
	private lastProgressAt = performance.now();
	private capabilityFailures = 0;
	private readonly respawn: (() => void) | undefined;

	constructor(options: LiveSessionFollowerOptions) {
		this.respawn = options.respawn;
		this.timing = {
			...DEFAULT_LIVE_SESSION_FOLLOWER_TIMING,
			...options.timing,
		};
		this.configDir = options.configDir ?? getConfigDir();
		this.roots = options.transcriptRoots ?? getLiveTranscriptRoots();
	}

	result(reason: string): LiveSessionFollowerResult {
		return {
			bytesSent: this.bytesSent,
			linesSent: this.linesSent,
			reason,
			requests: this.requests,
			sessions: this.sessionsFollowed,
		};
	}

	requestStop(signal: string): void {
		this.stopSignal ??= signal;
		this.wake();
	}

	async run(): Promise<string> {
		// A follower inside an agent's sandbox could hold the machine-wide
		// lease without network or file access.
		if (isSandboxedEnvironment()) return "sandboxed";
		const credentialsProblem = this.loadClient();
		if (credentialsProblem && credentialsProblem !== "credentials-unreadable")
			return credentialsProblem;
		if (isLiveSessionPaused(this.configDir, "")) return "paused";
		// Take the lease only once the server confirmed live sessions, so a
		// follower without network never keeps a working one from running.
		for (
			let attempt = 0;
			attempt < 3 && !this.capabilityConfirmed;
			attempt += 1
		) {
			if (attempt > 0) await sleep(this.timing.backoffInitialMs * attempt);
			this.startCapabilityCheck(true);
			await this.capabilityTask;
			if (this.stopReason) return this.stopReason;
		}
		if (!this.capabilityConfirmed) return "capability-unconfirmed";
		this.lease = await this.acquireLease();
		if (!this.lease) return "already-running";
		this.started = true;
		logger.info("Live session follower started (process {pid})", {
			pid: process.pid,
		});
		return await this.loop();
	}

	async dispose(reason: string): Promise<void> {
		await this.settleTasks(3_000);
		for (const session of [...this.sessions.values()])
			this.dropSession(session, reason, false);
		for (const watcher of this.watchers.values()) watcher.close();
		this.watchers.clear();
		if (FORGET_REGISTRATIONS_REASONS.has(reason))
			await removeAllLiveSessionRegistrations(this.configDir).catch(
				() => undefined,
			);
		await this.lease?.release().catch(() => undefined);
		this.lease = null;
		// Sessions are still registered: a failed follower hands them over.
		if (
			reason === "failed" &&
			this.started &&
			this.respawn &&
			!isSandboxedEnvironment() &&
			(await listLiveSessionRegistrations(this.configDir).catch(() => []))
				.length > 0
		) {
			try {
				this.respawn();
			} catch {
				// Nothing more to do: the next hook starts a follower.
			}
		}
		if (this.started)
			logger.info(
				"Live session follower stopped: {reason} ({sessions} sessions, {requests} requests, {linesSent} lines, {bytesSent} bytes)",
				{ ...this.result(reason) },
			);
		else
			logger.debug("Live session follower not started: {reason}", { reason });
	}

	private async acquireLease(): Promise<FileLease | null> {
		const path = getLiveSessionFollowerLeasePath(this.configDir);
		const waitUntil = performance.now() + this.timing.leaseWaitMs;
		let checked = false;
		while (true) {
			const lease = await tryAcquireFileLease(path, this.leaseOptions).catch(
				() => null,
			);
			if (lease) {
				await writeFollowerMarker(this.configDir).catch(() => undefined);
				return lease;
			}
			// Held, but not by a working follower (for example by an unrelated
			// process that reused the owner's PID): take it over once.
			if (!checked) {
				checked = true;
				if (!(await isHealthyFollowerRunning(this.configDir))) {
					await discardFollowerLease(this.configDir);
					continue;
				}
			}
			if (performance.now() >= waitUntil) return null;
			await sleep(Math.min(250, this.timing.tickMs));
		}
	}

	private async settleTasks(timeoutMs: number): Promise<void> {
		if (this.tasks.size === 0) return;
		await Promise.race([Promise.allSettled([...this.tasks]), sleep(timeoutMs)]);
	}

	// Main loop --------------------------------------------------------------

	private async loop(): Promise<string> {
		const { timing } = this;
		let nextTick = 0;
		let nextSettings = 0;
		let nextCapability = 0;
		let nextIdentity = 0;
		let idleSince: number | undefined;
		let lastIteration = 0;
		while (true) {
			if (this.stopReason) return this.stopReason;
			if (this.stopSignal) return await this.stopOnSignal();
			let now = performance.now();
			this.lastProgressAt = now;
			if (this.capabilityFailures >= timing.maxCapabilityFailures)
				return "unreachable";
			if (await this.settingsFilesChanged()) nextSettings = 0;
			if (now >= nextSettings) {
				nextSettings = now + timing.settingsCheckMs;
				const reason = this.checkSettings();
				if (reason) return reason;
			}
			if (now >= nextCapability) {
				nextCapability = now + timing.capabilityCheckMs;
				this.startCapabilityCheck();
			}
			if (
				!this.capabilityConfirmed &&
				now - this.startedAt >= timing.capabilityGiveUpMs
			)
				return "capability-unconfirmed";
			if (now >= nextTick) {
				nextTick = now + timing.tickMs;
				if (!(await this.ownsLease())) return "lease-lost";
				if (
					!this.capabilityConfirmed &&
					!this.capabilityTask &&
					this.canRequest(now)
				)
					this.startCapabilityCheck();
				const registered = await this.syncRegistrations();
				if (
					!this.identityTask &&
					(now >= nextIdentity || this.hasUnobservedPid()) &&
					this.startIdentityCheck()
				)
					nextIdentity = now + timing.identityCheckMs;
				for (const session of [...this.sessions.values()])
					if (session.ending && now >= session.ending.deadline)
						this.dropSession(
							session,
							`${session.ending.reason}-unflushed`,
							true,
						);
				if (this.sessions.size > 0 || registered) idleSince = undefined;
				else {
					idleSince ??= now;
					if (now - idleSince >= timing.idleExitMs) {
						if (await this.handOver()) return "idle";
						idleSince = undefined;
					}
				}
				if (
					[...this.sessions.values()].some(
						(session) => session.source === "codex",
					)
				)
					await this.codexRollouts.refresh().catch(() => undefined);
				for (const session of this.ordered()) {
					try {
						await this.refreshSession(session);
					} catch (error) {
						this.handleSessionError(session, error);
					}
				}
			}
			const backlog = await this.readAll();
			now = performance.now();
			const started = this.startSends(now, backlog, false);
			lastIteration = now;
			if (this.stopReason) continue;
			// Catching up: keep reading while requests can be started.
			if (
				backlog &&
				started &&
				this.busyRequests < this.timing.sendConcurrency &&
				this.canRequest(performance.now())
			)
				continue;
			const woken = await this.sleepOrWake(this.nextDelay(nextTick));
			// File events can come in bursts: at most ten passes a second for
			// them (a finished request continues at once).
			const sinceLast = performance.now() - lastIteration;
			if (woken === "file" && sinceLast < 100) await sleep(100 - sinceLast);
		}
	}

	/** On SIGTERM/SIGINT/SIGHUP: a bounded final flush, then exit. */
	private async stopOnSignal(): Promise<string> {
		const deadline = performance.now() + this.timing.signalFlushMs;
		await this.syncRegistrations().catch(() => false);
		for (const session of this.sessions.values())
			if (session.ending)
				session.ending = { ...session.ending, readAt: performance.now() };
		while (performance.now() < deadline) {
			const backlog = await this.readAll();
			this.startSends(performance.now(), true, true);
			const idle =
				this.busyRequests === 0 &&
				!backlog &&
				[...this.sessions.values()].every(
					(session) =>
						session.pendingLines === 0 &&
						(!session.ending || !isReadyToFinish(session)),
				);
			if (idle) break;
			await this.sleepOrWake(Math.min(100, deadline - performance.now()));
		}
		return `signal-${(this.stopSignal ?? "").toLowerCase()}`;
	}

	private nextDelay(nextTick: number): number {
		const now = performance.now();
		let wakeAt = nextTick;
		const requestAt = Math.max(this.backoffUntil, this.authBlockedUntil);
		for (const session of this.sessions.values()) {
			if (session.busy) continue;
			for (const stream of session.streams.values()) {
				if (stream.holdUntil > now) wakeAt = Math.min(wakeAt, stream.holdUntil);
				else if (stream.firstPendingAt !== undefined && !session.ending)
					wakeAt = Math.min(
						wakeAt,
						Math.max(stream.firstPendingAt + this.timing.debounceMs, requestAt),
					);
			}
			const ending = session.ending;
			if (ending && now < ending.readAt)
				wakeAt = Math.min(wakeAt, ending.readAt);
			else if (
				ending &&
				this.capabilityConfirmed &&
				(session.pendingLines > 0 || isReadyToFinish(session))
			)
				wakeAt = Math.min(wakeAt, requestAt);
		}
		return Math.max(0, Math.min(this.timing.tickMs, wakeAt - now));
	}

	private wake(reason: "file" | "task" = "task"): void {
		const wakeUp = this.wakeUp;
		this.wakeUp = undefined;
		wakeUp?.(reason);
	}

	private sleepOrWake(ms: number): Promise<"timer" | "file" | "task"> {
		return new Promise((resolve) => {
			const timer = setTimeout(() => done("timer"), Math.max(0, ms));
			const done = (reason: "timer" | "file" | "task") => {
				clearTimeout(timer);
				resolve(reason);
			};
			this.wakeUp = done;
		});
	}

	private ordered(): Session[] {
		const sessions = [...this.sessions.values()];
		if (sessions.length === 0) return sessions;
		const start = this.rotation % sessions.length;
		return [...sessions.slice(start), ...sessions.slice(0, start)];
	}

	private canRequest(now: number): boolean {
		return (
			this.client !== undefined &&
			now >= this.backoffUntil &&
			now >= this.authBlockedUntil
		);
	}

	private async ownsLease(): Promise<boolean> {
		try {
			return (await this.lease?.isOwned()) === true;
		} catch {
			return true;
		}
	}

	/**
	 * No sessions for a while: release the lease, then look once more for
	 * registrations a hook wrote while it saw the lease held. Returns true to
	 * exit.
	 */
	private async handOver(): Promise<boolean> {
		await this.lease?.release().catch(() => undefined);
		this.lease = null;
		const registrations = await listLiveSessionRegistrations(this.configDir);
		if (registrations.length === 0) return true;
		this.lease = await tryAcquireFileLease(
			getLiveSessionFollowerLeasePath(this.configDir),
			this.leaseOptions,
		).catch(() => null);
		if (this.lease)
			await writeFollowerMarker(this.configDir).catch(() => undefined);
		return this.lease === null;
	}

	// Settings ---------------------------------------------------------------

	/**
	 * Cheap per-tick check of the files that can stop live updates
	 * (credentials, repository settings, pauses): a change triggers the
	 * settings check right away instead of within a minute.
	 */
	private async settingsFilesChanged(): Promise<boolean> {
		let changed = false;
		for (const path of [
			join(this.configDir, "credentials.json"),
			join(this.configDir, "auto-upload.json"),
			join(getLiveSessionsDirectory(this.configDir), "paused.json"),
		]) {
			let fingerprint = "absent";
			try {
				const metadata = await stat(path);
				fingerprint = `${metadata.mtimeMs}:${metadata.size}:${metadata.ino}`;
			} catch {
				// Missing.
			}
			const previous = this.fingerprints.get(path);
			this.fingerprints.set(path, fingerprint);
			if (previous !== undefined && previous !== fingerprint) changed = true;
		}
		return changed;
	}

	private checkSettings(): string | undefined {
		const reason = this.loadClient();
		if (reason === "credentials-unreadable") return undefined;
		if (reason) return reason;
		if (isLiveSessionPaused(this.configDir, "")) return "paused";
		for (const session of [...this.sessions.values()]) {
			if (isLiveSessionPaused(this.configDir, session.organizationId))
				this.dropSession(session, "paused", true);
			else if (!this.isRepositoryAllowed(session))
				this.dropSession(session, "repository-disabled", true);
		}
		return undefined;
	}

	/** (Re)reads credentials; a new token or endpoint gets a new client. */
	private loadClient(): string | undefined {
		const credentials = readCredentials(this.configDir);
		if (credentials === "missing") return "not-authenticated";
		// Unreadable for a moment (for example being rewritten): keep the
		// current client.
		if (credentials === "invalid") return "credentials-unreadable";
		if (credentials.authType !== "api-key") return "api-key-required";
		const apiBase = (getApiBaseOverride() ?? credentials.apiBaseUrl).replace(
			/\/+$/u,
			"",
		);
		const endpoint = parseSafeApiEndpoint(`${apiBase}/rpc`, {
			allowPlaintext: allowsInsecureEndpointFromEnv(),
		});
		if (!endpoint.ok) return "endpoint-refused";
		const clientKey = `${endpoint.url}\u0000${credentials.token}`;
		if (clientKey !== this.clientKey) {
			this.client = createRpcClient({
				authType: "api-key",
				rpcUrl: endpoint.url,
				token: credentials.token,
			});
			this.clientKey = clientKey;
			// New credentials: try again right away.
			this.authBlockedUntil = 0;
			this.authBackoffMs = 0;
		}
		return undefined;
	}

	/** `cli.authStatus` must advertise `liveSessions`. Runs in the background. */
	private startCapabilityCheck(force = false): void {
		const client = this.client;
		if (!client || this.capabilityTask) return;
		if (!force && !this.canRequest(performance.now())) return;
		this.requests += 1;
		const clientKey = this.clientKey;
		this.capabilityTask = (async () => {
			try {
				const status = await client.cli.authStatus(undefined, {
					signal: AbortSignal.timeout(this.timing.capabilityTimeoutMs),
				});
				if (status.capabilities?.liveSessions !== true) {
					this.stopReason ??= "unsupported";
					return;
				}
				this.capabilityConfirmed = true;
				this.capabilityFailures = 0;
				this.backoffMs = 0;
			} catch (error) {
				if (
					error instanceof ORPCError &&
					(error.status === 401 || error.status === 403)
				)
					this.onUnauthorized(clientKey);
				else {
					this.capabilityFailures += 1;
					if (!this.capabilityConfirmed) this.backOff();
				}
			}
		})().finally(() => {
			this.capabilityTask = undefined;
			this.wake();
		});
	}

	/**
	 * A 401: credentials may have been replaced (for example by a new login).
	 * Re-read them; a new token is used right away. If the current token was
	 * refused, pause requests (and retry later or on the next credentials
	 * change) without forgetting any session.
	 */
	private onUnauthorized(clientKey: string | undefined): void {
		const reason = this.loadClient();
		if (reason && reason !== "credentials-unreadable") {
			this.stopReason ??= reason;
			return;
		}
		if (this.clientKey !== clientKey) return;
		this.authBackoffMs =
			this.authBackoffMs === 0
				? this.timing.authBackoffInitialMs
				: Math.min(this.authBackoffMs * 2, this.timing.authBackoffMaxMs);
		this.authBlockedUntil = performance.now() + this.authBackoffMs;
		logger.warn(
			"Live session updates were refused (401); retrying in {seconds} s or when credentials change",
			{ seconds: Math.round(this.authBackoffMs / 1_000) },
		);
	}

	private isRepositoryAllowed(session: Session): boolean {
		return (
			!session.repository ||
			isRepositoryAutoUploadAllowed(
				session.repository.repoKey,
				session.source,
				session.repository.legacyKeys,
				this.configDir,
			)
		);
	}

	// Registrations ----------------------------------------------------------

	private registeredPids(): number[] {
		return [
			...new Set(
				[...this.sessions.values()]
					.flatMap((session) => session.registrations)
					.map((registration) => registration.agentPid)
					.filter((pid): pid is number => pid !== null),
			),
		];
	}

	/** An agent process not yet looked at (its start identity is recorded early). */
	private hasUnobservedPid(): boolean {
		return this.registeredPids().some(
			(pid) => !this.identityAttempted.has(pid),
		);
	}

	/** Compares process start identities in the background (one `ps` at most). */
	private startIdentityCheck(): boolean {
		const pids = this.registeredPids();
		if (pids.length === 0) return false;
		for (const pid of pids) this.identityAttempted.add(pid);
		this.identityTask = (async () => {
			const identities = await readProcessStartIdentities(pids);
			this.replacedIdentities.clear();
			for (const known of [...this.identityAttempted])
				if (!pids.includes(known)) {
					this.identityAttempted.delete(known);
					this.observedIdentities.delete(known);
					this.currentIdentities.delete(known);
				}
			for (const pid of pids) {
				const identity = identities.get(pid);
				if (identity === undefined) continue;
				const observed = this.observedIdentities.get(pid);
				if (observed === undefined) this.observedIdentities.set(pid, identity);
				else if (!isSameStartIdentity(observed, identity))
					this.replacedIdentities.add(pid);
				this.currentIdentities.set(pid, identity);
			}
		})()
			.catch(() => undefined)
			.finally(() => {
				this.identityTask = undefined;
			});
		return true;
	}

	/**
	 * Reads registrations, decides which agent processes still run, starts
	 * following new sessions and starts ending sessions without a live
	 * registration. Returns whether any registration exists.
	 */
	private async syncRegistrations(): Promise<boolean> {
		const registrations = (
			await listLiveSessionRegistrations(this.configDir)
		).filter((registration) => !this.removing.has(registration.file));
		const now = Date.now();
		const alivePids = new Set<number>();
		const unknownPids = new Set<number>();
		for (const registration of registrations) {
			const pid = registration.agentPid;
			if (pid === null) continue;
			const state = processState(pid);
			if (state === "alive") alivePids.add(pid);
			else if (state === "unknown") unknownPids.add(pid);
		}
		const alive = new Map<StoredLiveSessionRegistration, boolean>();
		for (const registration of registrations)
			alive.set(
				registration,
				this.isRegistrationAlive(registration, alivePids, unknownPids, now),
			);
		const superseded = findSupersededRegistrations(registrations, alive);
		const bySession = new Map<string, StoredLiveSessionRegistration[]>();
		for (const registration of registrations) {
			const key = getLiveSessionKey(
				registration.source,
				registration.sessionId,
			);
			bySession.set(key, [...(bySession.get(key) ?? []), registration]);
		}
		for (const [key, group] of bySession) {
			const live = group.filter(
				(registration) =>
					alive.get(registration) === true && !superseded.has(registration),
			);
			const session = this.sessions.get(key);
			if (session) {
				session.registrations = group;
				if (live.length > 0) {
					// Resumed (for example `/resume` after `/clear`) before it ended.
					if (session.ending) session.ending = undefined;
				} else if (!session.ending) {
					this.beginEnding(
						session,
						group.some((registration) => superseded.has(registration))
							? "session-replaced"
							: "agent-exited",
					);
				}
				continue;
			}
			const newest = group.reduce((left, right) =>
				right.startedAt > left.startedAt ? right : left,
			);
			if (
				(live.length === 0 &&
					now - newest.startedAt > this.timing.staleRegistrationMs) ||
				isLiveSessionPaused(this.configDir, newest.organizationId)
			) {
				// Left behind far too long ago, or paused.
				for (const registration of group)
					await removeLiveSessionRegistration(registration);
				continue;
			}
			if (this.sessions.size >= MAX_SESSIONS) {
				if (!this.sessionLimitLogged) {
					this.sessionLimitLogged = true;
					logger.warn("Live session updates follow at most {limit} sessions", {
						limit: MAX_SESSIONS,
					});
				}
				continue;
			}
			const created = await this.createSession(key, newest, group);
			if (created && live.length === 0)
				this.beginEnding(created, "agent-exited");
		}
		for (const session of this.sessions.values()) {
			if (!bySession.has(session.key) && !session.ending)
				this.beginEnding(session, "unregistered");
		}
		for (const file of [...this.lastSeenAlive.keys()])
			if (!registrations.some((registration) => registration.file === file))
				this.lastSeenAlive.delete(file);
		return registrations.length > 0;
	}

	private isRegistrationAlive(
		registration: StoredLiveSessionRegistration,
		alivePids: ReadonlySet<number>,
		unknownPids: ReadonlySet<number>,
		now: number,
	): boolean {
		const session = this.sessions.get(
			getLiveSessionKey(registration.source, registration.sessionId),
		);
		const lastActivityAt = Math.max(
			session?.lastActivityAt ?? 0,
			registration.startedAt,
		);
		if (registration.agentPidSource === "exited") return false;
		if (registration.agentPid === null)
			// Codex without a known `codex` process: follow while the rollout is active.
			return now - lastActivityAt < this.timing.codexOrphanIdleMs;
		const pid = registration.agentPid;
		// Not allowed to signal it (EPERM): judge by transcript activity.
		if (unknownPids.has(pid))
			return (
				now - lastActivityAt <
				(registration.source === "codex"
					? this.timing.codexOrphanIdleMs
					: this.timing.orphanIdleMs)
			);
		const current = this.currentIdentities.get(pid);
		const reused =
			this.replacedIdentities.has(pid) ||
			(registration.agentStartIdentity !== null &&
				current !== undefined &&
				!isSameStartIdentity(current, registration.agentStartIdentity));
		if (alivePids.has(pid) && !reused) {
			this.lastSeenAlive.set(registration.file, now);
			if (
				registration.source === "codex" &&
				now - lastActivityAt >= this.timing.codexIdleMs
			)
				return false;
			return true;
		}
		// The hook's parent stood in for an unknown agent process; if it ended
		// right away it was a wrapper, so follow the transcript until it idles.
		const seen = this.lastSeenAlive.get(registration.file);
		if (
			registration.agentPidSource === "parent" &&
			(seen === undefined ||
				seen - registration.startedAt < this.timing.orphanGraceMs)
		) {
			if (session && !session.orphanLogged) {
				session.orphanLogged = true;
				logger.info(
					"Live session {sessionId}: the agent process is unknown; following until its transcript is idle",
					{ sessionId: registration.sessionId },
				);
			}
			return now - lastActivityAt < this.timing.orphanIdleMs;
		}
		return false;
	}

	private async createSession(
		key: string,
		registration: StoredLiveSessionRegistration,
		group: StoredLiveSessionRegistration[],
	): Promise<Session | undefined> {
		if (
			!(await isAllowedTranscriptPath(
				registration.source,
				registration.transcriptPath,
				this.roots,
			))
		) {
			if (!this.rejectedPaths.has(key)) {
				this.rejectedPaths.add(key);
				logger.warn(
					"Live session {sessionId}: the transcript is outside the agent's transcript directory; not followed",
					{ sessionId: registration.sessionId },
				);
			}
			for (const item of group) await removeLiveSessionRegistration(item);
			return undefined;
		}
		const session: Session = {
			busy: false,
			createdAt: performance.now(),
			cwd: registration.cwd,
			ending: undefined,
			gitBranch: undefined,
			gitRemote: undefined,
			ignoredEntries: new Set(),
			inputBytes: 0,
			key,
			lastActivityAt: registration.startedAt,
			linesSent: 0,
			orphanLogged: false,
			organizationId: registration.organizationId,
			pendingBytes: 0,
			pendingLines: 0,
			redactedBytes: 0,
			redactionCounts: {},
			registrations: group,
			repository: undefined,
			discovered: false,
			serverEnded: false,
			serverHadStreams: false,
			serverStreams: undefined,
			sessionId: registration.sessionId,
			source: registration.source,
			streamLimitLogged: false,
			streams: new Map(),
			subagentDirectory: undefined,
			subagentDirectoryMtime: -1,
			subagentScannedAt: 0,
			transcriptPath: registration.transcriptPath,
			watched: new Set(),
		};
		try {
			const gitInfo = await getGitInfo(session.cwd);
			session.repository = {
				legacyKeys: getLegacyRepositoryKeys(session.cwd, gitInfo),
				repoKey: resolveUploadRepositoryIdentity(session.cwd, gitInfo).repoKey,
			};
			if (gitInfo.gitRemote && gitInfo.gitRemote.length <= 2048)
				session.gitRemote = gitInfo.gitRemote;
			if (gitInfo.branch && gitInfo.branch.length <= 1024)
				session.gitBranch = gitInfo.branch;
		} catch {
			// Without Git metadata the session is still followed.
		}
		if (session.source === "codex")
			this.codexRollouts.track(session.transcriptPath);
		this.sessions.set(key, session);
		this.sessionsFollowed += 1;
		this.watchDirectory(session, dirname(session.transcriptPath));
		logger.info("Live session {sessionId} ({source}) followed", {
			sessionId: session.sessionId,
			source: session.source,
		});
		if (!this.isRepositoryAllowed(session)) {
			this.dropSession(session, "repository-disabled", true);
			return undefined;
		}
		return session;
	}

	private beginEnding(session: Session, reason: string): void {
		const now = performance.now();
		session.ending = {
			deadline: now + this.timing.finalReadDelayMs + this.timing.finalFlushMs,
			readAt: now + this.timing.finalReadDelayMs,
			reason,
		};
	}

	/**
	 * Forgets a session. With `forget`, its registrations are removed too, so
	 * it is not followed again until a hook registers it anew.
	 */
	private dropSession(session: Session, reason: string, forget: boolean): void {
		if (this.sessions.get(session.key) !== session) return;
		this.sessions.delete(session.key);
		this.pendingBytes -= session.pendingBytes;
		for (const directory of session.watched)
			this.unwatchDirectory(session, directory);
		logger.info(
			"Live session {sessionId} ({source}) stopped: {reason} ({lines} lines)",
			{
				lines: session.linesSent,
				reason,
				sessionId: session.sessionId,
				source: session.source,
			},
		);
		if (forget)
			for (const registration of session.registrations) {
				this.removing.add(registration.file);
				void removeLiveSessionRegistration(registration)
					.catch(() => undefined)
					.finally(() => this.removing.delete(registration.file));
			}
	}

	private handleSessionError(session: Session, error: unknown): void {
		if (error instanceof StopFollowing) {
			this.stopReason ??= error.reason;
			return;
		}
		const reason = error instanceof StopSession ? error.reason : "failed";
		if (!(error instanceof StopSession))
			logger.warn("Live session {sessionId} failed: {error}", {
				error: describeError(error),
				sessionId: session.sessionId,
			});
		this.dropSession(session, reason, true);
	}

	// Change notifications ------------------------------------------------------

	/** File events wake the loop early; the 1 s tick remains the fallback. */
	private watchDirectory(session: Session, directory: string): void {
		if (session.watched.has(directory)) return;
		session.watched.add(directory);
		if (this.watchers.has(directory)) return;
		if (this.watchers.size >= MAX_WATCHED_DIRECTORIES) return;
		try {
			const watcher = watch(directory, { persistent: false }, () =>
				this.wake("file"),
			);
			watcher.on("error", () => {
				watcher.close();
				this.watchers.delete(directory);
			});
			this.watchers.set(directory, watcher);
		} catch {
			// Unsupported here, or too many watches: the tick covers it.
		}
	}

	private unwatchDirectory(session: Session, directory: string): void {
		session.watched.delete(directory);
		for (const other of this.sessions.values())
			if (other.watched.has(directory)) return;
		this.watchers.get(directory)?.close();
		this.watchers.delete(directory);
	}

	// Per-session work ---------------------------------------------------------

	/** State, stream discovery and per-session limits (once per tick). */
	private async refreshSession(session: Session): Promise<void> {
		const now = performance.now();
		if (now - session.createdAt >= this.timing.maxSessionMs)
			throw new StopSession("max-runtime");
		if (!session.serverStreams) {
			if (this.capabilityConfirmed && this.canRequest(now))
				this.startStateLoad(session);
			return;
		}
		await this.discoverStreams(session);
		if (
			!session.streams.has("") &&
			!session.ending &&
			now - session.createdAt >= this.timing.transcriptWaitMs
		)
			throw new StopSession("transcript-missing");
	}

	private target(session: Session) {
		return {
			organizationId: session.organizationId,
			protocol: LIVE_SESSION_PROTOCOL,
			sessionId: session.sessionId,
			source: session.source,
		} as const;
	}

	private startStateLoad(session: Session): void {
		const client = this.client;
		if (!client || session.busy) return;
		if (this.busyRequests >= this.timing.sendConcurrency) return;
		this.runTask(session, async () => {
			this.requests += 1;
			const clientKey = this.clientKey;
			try {
				const state = LiveSessionStateOutputSchema.parse(
					await client.liveSession.state(this.target(session), {
						signal: AbortSignal.timeout(this.timing.requestTimeoutMs),
					}),
				);
				if (this.sessions.get(session.key) !== session) return;
				session.serverStreams = new Map(
					state.streams.map((stream) => [
						stream.agentId ?? "",
						{
							committedLines: stream.committedLines,
							lastLineSha256: stream.lastLineSha256,
						},
					]),
				);
				session.serverHadStreams = state.streams.some(
					(stream) => stream.committedLines > 0,
				);
				session.serverEnded = state.ended;
				this.backoffMs = 0;
				this.capabilityFailures = 0;
			} catch (error) {
				await this.handleRequestError(session, error, clientKey);
			}
		});
	}

	/** Runs one request of a session in the background (bounded concurrency). */
	private runTask(session: Session, work: () => Promise<void>): void {
		session.busy = true;
		this.busyRequests += 1;
		const task: Promise<void> = work()
			.catch((error: unknown) => this.handleSessionError(session, error))
			.finally(() => {
				session.busy = false;
				this.busyRequests -= 1;
				this.tasks.delete(task);
				this.wake();
			});
		this.tasks.add(task);
	}

	private async discoverStreams(session: Session): Promise<void> {
		try {
			await this.discoverSessionStreams(session);
		} finally {
			session.discovered = true;
		}
	}

	private async discoverSessionStreams(session: Session): Promise<void> {
		if (!session.streams.has("")) {
			try {
				const metadata = await lstat(session.transcriptPath);
				if (metadata.isFile())
					this.addStream(session, null, session.transcriptPath);
			} catch {
				// The agent creates its transcript with the first record.
			}
		}
		if (session.source === "codex") {
			for (const child of this.codexRollouts.descendants(session.sessionId)) {
				if (session.streams.has(child.threadId)) continue;
				if (session.ignoredEntries.has(child.threadId)) continue;
				if (!this.hasStreamCapacity(session)) return;
				if (!/^[A-Za-z0-9_-]{1,200}$/u.test(child.threadId)) {
					this.ignore(session, child.threadId);
					continue;
				}
				try {
					const metadata = await lstat(child.transcriptPath);
					if (!metadata.isFile()) {
						this.ignore(session, child.threadId);
						continue;
					}
					this.addStream(session, child.threadId, child.transcriptPath);
					this.watchDirectory(session, dirname(child.transcriptPath));
				} catch {
					// Seen again next tick.
				}
			}
			return;
		}
		const directory = await this.resolveClaudeSubagentDirectory(session);
		if (!directory) return;
		// List the directory only when it changed (or now and then).
		let mtimeMs: number;
		try {
			mtimeMs = (await stat(directory)).mtimeMs;
		} catch {
			return;
		}
		const now = performance.now();
		if (
			mtimeMs === session.subagentDirectoryMtime &&
			now - session.subagentScannedAt < this.timing.directoryRescanMs
		)
			return;
		let names: string[];
		try {
			names = await readdir(directory);
		} catch {
			return;
		}
		session.subagentDirectoryMtime = mtimeMs;
		session.subagentScannedAt = now;
		for (const name of names) {
			const agentId = SUBAGENT_FILENAME_PATTERN.exec(name)?.[1];
			if (!agentId || session.streams.has(agentId)) continue;
			if (session.ignoredEntries.has(name)) continue;
			if (!this.hasStreamCapacity(session)) return;
			const path = join(directory, name);
			try {
				const metadata = await lstat(path);
				const canonical = metadata.isFile() ? await realpath(path) : undefined;
				if (!canonical || !isContainedPath(directory, canonical)) {
					this.ignore(session, name);
					continue;
				}
				this.addStream(session, agentId, canonical);
			} catch {
				// Removed or replaced while scanning; seen again next time.
				session.subagentDirectoryMtime = -1;
			}
		}
	}

	private ignore(session: Session, name: string): void {
		if (session.ignoredEntries.size < MAX_IGNORED_ENTRIES)
			session.ignoredEntries.add(name);
	}

	private hasStreamCapacity(session: Session): boolean {
		if (session.streams.size < MAX_STREAMS_PER_SESSION) return true;
		if (!session.streamLimitLogged) {
			session.streamLimitLogged = true;
			logger.warn(
				"Live session {sessionId} follows at most {limit} transcripts",
				{ limit: MAX_STREAMS_PER_SESSION, sessionId: session.sessionId },
			);
		}
		return false;
	}

	/** Only the canonical `<transcript dir>/<session id>/subagents` directory. */
	private async resolveClaudeSubagentDirectory(
		session: Session,
	): Promise<string | undefined> {
		if (session.subagentDirectory) return session.subagentDirectory;
		try {
			const parent = await realpath(dirname(session.transcriptPath));
			const directory = await realpath(
				join(parent, session.sessionId, "subagents"),
			);
			if (isContainedPath(parent, directory)) {
				session.subagentDirectory = directory;
				this.watchDirectory(session, directory);
				return directory;
			}
		} catch {
			// Not created until the first subagent runs.
		}
		return undefined;
	}

	private addStream(
		session: Session,
		agentId: string | null,
		path: string,
	): void {
		const stream: Stream = {
			agentId,
			committedLines: 0,
			committedSha: null,
			consecutiveResets: 0,
			dev: undefined,
			epoch: 0,
			firstPendingAt: undefined,
			holdUntil: 0,
			inode: undefined,
			locate: undefined,
			needsReset: false,
			outOfSync: 0,
			path,
			pending: [],
			pendingBytes: 0,
			rawOffset: 0,
			scannedTo: -1,
			slimmer: createTranscriptSlimmer(),
		};
		const known = session.serverStreams?.get(agentId ?? "");
		if (known && known.committedLines > 0) stream.locate = known;
		session.streams.set(agentId ?? "", stream);
	}

	/**
	 * Resumes a stream after the server's last committed line when the local
	 * file still produces that exact line; otherwise the stream starts over.
	 * A file that cannot be read now is tried again next time.
	 */
	private async locate(session: Session, stream: Stream): Promise<void> {
		const cursor = stream.locate;
		if (!cursor) return;
		if (cursor.committedLines === 0 || cursor.lastLineSha256 === null) {
			stream.locate = undefined;
			this.resetStream(session, stream);
			return;
		}
		const slimmer = createTranscriptSlimmer();
		// Codex slimming depends on earlier records of the stream: replay them
		// (without sending) so later lines match an uninterrupted follower.
		const found = await findLineEnd(
			stream.path,
			cursor.committedLines - 1,
			cursor.lastLineSha256,
			slimmer,
			this.readBuffer,
			session.source === "codex",
			() => {
				this.lastProgressAt = performance.now();
			},
		);
		stream.locate = undefined;
		if (!found) {
			this.resetStream(session, stream);
			return;
		}
		this.dropPending(session, stream, stream.pending.length);
		stream.epoch += 1;
		stream.slimmer = slimmer;
		stream.rawOffset = found.offset;
		stream.dev = found.dev;
		stream.inode = found.inode;
		stream.scannedTo = -1;
		stream.committedLines = cursor.committedLines;
		stream.committedSha = cursor.lastLineSha256;
		stream.needsReset = false;
		stream.outOfSync = 0;
	}

	/**
	 * Starts a stream over from line 0. A stream that keeps needing resets
	 * (a server or file that never agrees) waits longer each time and finally
	 * ends its session, so it can never flood the server.
	 */
	private resetStream(session: Session, stream: Stream): void {
		stream.consecutiveResets += 1;
		if (stream.consecutiveResets > this.timing.maxConsecutiveResets) {
			logger.warn(
				"Live session {sessionId}: transcript {agentId} keeps falling out of sync; not followed further",
				{ agentId: stream.agentId ?? "main", sessionId: session.sessionId },
			);
			throw new StopSession("out-of-sync");
		}
		this.dropPending(session, stream, stream.pending.length);
		const now = performance.now();
		stream.epoch += 1;
		stream.slimmer = createTranscriptSlimmer();
		stream.rawOffset = 0;
		stream.scannedTo = -1;
		stream.dev = undefined;
		stream.inode = undefined;
		stream.committedLines = 0;
		stream.committedSha = null;
		stream.needsReset = true;
		stream.outOfSync = 0;
		stream.locate = undefined;
		// A reset waits for the debounce like any other send.
		stream.firstPendingAt = now;
		if (stream.consecutiveResets >= 2)
			stream.holdUntil =
				now +
				Math.min(
					this.timing.resetBackoffInitialMs *
						2 ** (stream.consecutiveResets - 2),
					this.timing.resetBackoffMaxMs,
				);
	}

	private dropPending(session: Session, stream: Stream, count: number): void {
		if (count <= 0) return;
		const dropped = stream.pending.splice(0, count);
		const bytes = dropped.reduce((total, line) => total + line.bytes, 0);
		stream.pendingBytes -= bytes;
		session.pendingBytes -= bytes;
		session.pendingLines -= dropped.length;
		this.pendingBytes -= bytes;
		if (stream.pending.length === 0 && !stream.needsReset)
			stream.firstPendingAt = undefined;
	}

	// Reading ----------------------------------------------------------------

	/**
	 * Reads new complete lines, sessions in rotating order so one large
	 * catch-up cannot starve the others. Returns true when reading stopped at
	 * the read-ahead budget.
	 */
	private async readAll(): Promise<boolean> {
		let backlog = false;
		for (const session of this.ordered()) {
			if (!session.serverStreams) continue;
			const final =
				session.ending !== undefined &&
				performance.now() >= session.ending.readAt;
			try {
				if (await this.readSession(session, final)) {
					backlog = true;
					break;
				}
				this.checkRedaction(session);
			} catch (error) {
				this.handleSessionError(session, error);
			}
		}
		this.rotation += 1;
		return backlog;
	}

	private async readSession(
		session: Session,
		final: boolean,
	): Promise<boolean> {
		for (const stream of orderedStreams(session)) {
			if (this.pendingBytes >= READ_AHEAD_BYTES) return true;
			try {
				if (stream.locate) await this.locate(session, stream);
				if (await this.readStream(session, stream, final)) return true;
			} catch (error) {
				if (error instanceof StopSession) throw error;
				// Unreadable for now (permissions, removed, replaced, not a
				// regular file): next tick.
				stream.scannedTo = -1;
			}
		}
		return false;
	}

	private async readStream(
		session: Session,
		stream: Stream,
		final: boolean,
	): Promise<boolean> {
		const metadata: Stats = await lstat(stream.path);
		if (!metadata.isFile()) throw new Error("Not a regular file");
		if (
			metadata.size < stream.rawOffset ||
			(stream.inode !== undefined &&
				(metadata.ino !== stream.inode || metadata.dev !== stream.dev))
		)
			this.resetStream(session, stream);
		if (metadata.size === stream.scannedTo && !final) return false;
		const { handle, stats } = await openRegularFile(stream.path);
		try {
			// The file was replaced between the two looks: next time.
			if (stats.ino !== metadata.ino || stats.dev !== metadata.dev)
				throw new Error("File replaced");
			stream.dev = stats.dev;
			stream.inode = stats.ino;
			const before = stream.rawOffset;
			const read = await readCompleteLines(
				handle,
				stream.rawOffset,
				stats.size,
				(line) => {
					this.enqueue(session, stream, line);
					return this.pendingBytes < READ_AHEAD_BYTES;
				},
				this.readBuffer,
			);
			stream.rawOffset = read.endOffset;
			stream.scannedTo = read.stopped ? -1 : stats.size;
			if (read.endOffset > before) session.lastActivityAt = Date.now();
			if (read.stopped) return true;
			if (final && stream.rawOffset < stats.size) {
				// The agent is gone: a final line without `\n` is sent only when
				// it is complete JSON.
				const tail = await readTail(handle, stream.rawOffset, stats.size);
				if (tail && isJson(tail)) {
					this.enqueue(session, stream, { bytes: tail, kind: "line" });
					stream.rawOffset = stats.size;
				}
			}
		} finally {
			await handle.close().catch(() => undefined);
		}
		return false;
	}

	private enqueue(
		session: Session,
		stream: Stream,
		raw: RawLiveSessionLine,
	): void {
		const line = processLiveSessionLine(raw, stream.slimmer);
		this.lastProgressAt = performance.now();
		session.inputBytes += line.inputBytes;
		session.redactedBytes += line.redactedBytes;
		addCounts(session.redactionCounts, line.redactions);
		stream.pending.push({
			bytes: line.bytes,
			sha256: line.sha256,
			text: line.text,
			wireBytes: line.wireBytes,
		});
		stream.pendingBytes += line.bytes;
		session.pendingBytes += line.bytes;
		session.pendingLines += 1;
		this.pendingBytes += line.bytes;
		stream.firstPendingAt ??= performance.now();
	}

	private checkRedaction(session: Session): void {
		if (session.inputBytes < REDACTION_RATIO_MIN_INPUT_BYTES) return;
		const anomaly = getRedactionBudgetAnomaly(
			session.redactedBytes,
			session.inputBytes,
			session.redactionCounts,
		);
		if (!anomaly) return;
		logger.warn(
			"Live session {sessionId}: known-pattern redaction exceeded the safety ratio ({redactedBytes} of {inputBytes} bytes)",
			{
				inputBytes: anomaly.inputBytes,
				redactedBytes: anomaly.redactedBytes,
				sessionId: session.sessionId,
			},
		);
		throw new StopSession("redaction-budget");
	}

	// Sending ----------------------------------------------------------------

	/**
	 * Starts one append for each session that is due (up to the concurrency
	 * limit), including the final appends of ending sessions; never waits for
	 * them. Returns whether any request was started.
	 */
	private startSends(now: number, backlog: boolean, force: boolean): boolean {
		if (!this.capabilityConfirmed || !this.canRequest(now)) return false;
		let started = false;
		for (const session of this.ordered()) {
			if (this.busyRequests >= this.timing.sendConcurrency) break;
			if (session.busy || !session.serverStreams) continue;
			try {
				const ending = session.ending;
				if (ending) {
					if (now >= ending.deadline) {
						this.dropSession(session, `${ending.reason}-unflushed`, true);
						continue;
					}
					if (now < ending.readAt) continue;
					const ready = isReadyToFinish(session);
					if (
						ready &&
						session.pendingLines === 0 &&
						!hasReset(session, now) &&
						session.linesSent === 0 &&
						(!session.serverHadStreams || session.serverEnded)
					) {
						this.dropSession(session, ending.reason, true);
						continue;
					}
					const batch = this.buildBatch(session, ready, now);
					if (batch) started = this.startAppend(session, batch) || started;
					continue;
				}
				if (!force && !this.isDue(session, now, backlog)) continue;
				const batch = this.buildBatch(session, false, now);
				if (batch) started = this.startAppend(session, batch) || started;
			} catch (error) {
				this.handleSessionError(session, error);
			}
		}
		return started;
	}

	private isDue(session: Session, now: number, backlog: boolean): boolean {
		let first: number | undefined;
		let bytes = 0;
		for (const stream of session.streams.values()) {
			if (stream.holdUntil > now || stream.locate) continue;
			if (stream.pending.length === 0 && !stream.needsReset) continue;
			bytes += stream.pendingBytes;
			if (
				stream.firstPendingAt !== undefined &&
				(first === undefined || stream.firstPendingAt < first)
			)
				first = stream.firstPendingAt;
		}
		if (first === undefined) return false;
		if (backlog || bytes >= this.timing.sendThresholdBytes) return true;
		return now - first >= this.timing.debounceMs;
	}

	/**
	 * As many pending lines of this session as the request limits allow
	 * (raw line bytes, serialized bytes, lines per stream, streams). With
	 * `endedIfComplete`, asks to end the session when nothing remains.
	 */
	private buildBatch(
		session: Session,
		endedIfComplete: boolean,
		now: number,
	): Batch | undefined {
		const items: Batch["items"] = [];
		let rawBytes = 0;
		let wireBytes = 0;
		let lineCount = 0;
		let full = false;
		for (const stream of orderedStreams(session)) {
			if (stream.holdUntil > now || stream.locate) continue;
			if (stream.pending.length === 0 && !stream.needsReset) continue;
			if (full || items.length >= LIVE_SESSION_MAX_STREAMS_PER_REQUEST) break;
			const lines: LiveSessionLine[] = [];
			for (const line of stream.pending) {
				if (lines.length >= LIVE_SESSION_MAX_LINES_PER_STREAM) break;
				if (
					lineCount >= LIVE_SESSION_MAX_REQUEST_LINES ||
					rawBytes + line.bytes > LIVE_SESSION_MAX_REQUEST_LINE_BYTES ||
					wireBytes + line.wireBytes > LIVE_SESSION_MAX_WIRE_BYTES
				) {
					full = true;
					break;
				}
				lines.push(line);
				lineCount += 1;
				rawBytes += line.bytes;
				wireBytes += line.wireBytes;
			}
			if (lines.length === 0 && stream.pending.length > 0) break;
			items.push({ epoch: stream.epoch, lines, stream });
		}
		const complete =
			endedIfComplete &&
			[...session.streams.values()].every((stream) => {
				const item = items.find((entry) => entry.stream === stream);
				return item
					? item.lines.length === stream.pending.length
					: stream.pending.length === 0 && !stream.needsReset;
			});
		if (items.length === 0 && !complete) return undefined;
		return { ended: complete, items };
	}

	private startAppend(session: Session, batch: Batch): boolean {
		const client = this.client;
		if (!client) return false;
		this.runTask(session, async () => {
			const input: LiveSessionAppendInput = {
				...this.target(session),
				projectPath: session.cwd,
				...(session.gitRemote ? { gitRemote: session.gitRemote } : {}),
				...(session.gitBranch ? { gitBranch: session.gitBranch } : {}),
				...(batch.ended ? { ended: true } : {}),
				streams: batch.items.map(({ lines, stream }) => ({
					agentId: stream.agentId,
					...(stream.needsReset ? { reset: true } : {}),
					lines: lines.map((line) => line.text),
					previousLineSha256: stream.committedSha,
					startLine: stream.committedLines,
				})),
			};
			const resetSent = new Set(
				batch.items
					.filter(({ stream }) => stream.needsReset)
					.map(({ stream }) => stream),
			);
			const clientKey = this.clientKey;
			let output: ReturnType<typeof LiveSessionAppendOutputSchema.parse>;
			try {
				this.requests += 1;
				output = LiveSessionAppendOutputSchema.parse(
					await client.liveSession.append(input, {
						signal: AbortSignal.timeout(this.timing.requestTimeoutMs),
					}),
				);
			} catch (error) {
				await this.handleRequestError(session, error, clientKey);
				return;
			}
			this.backoffMs = 0;
			this.capabilityFailures = 0;
			if (this.sessions.get(session.key) !== session) return;
			const results = new Map(
				output.streams.map((stream) => [stream.agentId ?? "", stream]),
			);
			let committedAll = true;
			for (const { epoch, lines, stream } of batch.items) {
				// Replaced while the request was in flight (reset, file rewrite).
				if (stream.epoch !== epoch) {
					committedAll = false;
					continue;
				}
				const result = results.get(stream.agentId ?? "");
				const expectedLines = stream.committedLines + lines.length;
				const expectedSha = lines.at(-1)?.sha256 ?? stream.committedSha;
				if (
					result &&
					result.status !== "out-of-sync" &&
					result.committedLines === expectedLines &&
					result.lastLineSha256 === expectedSha
				) {
					const bytes = lines.reduce((total, line) => total + line.bytes, 0);
					this.dropPending(session, stream, lines.length);
					stream.committedLines = expectedLines;
					stream.committedSha = expectedSha;
					stream.needsReset = false;
					stream.outOfSync = 0;
					if (!resetSent.has(stream)) {
						stream.consecutiveResets = 0;
						stream.holdUntil = 0;
					}
					if (stream.pending.length === 0) stream.firstPendingAt = undefined;
					session.linesSent += lines.length;
					this.linesSent += lines.length;
					this.bytesSent += bytes;
					continue;
				}
				committedAll = false;
				if (result)
					this.reconcile(
						session,
						stream,
						result.committedLines,
						result.lastLineSha256,
					);
				else this.resetStream(session, stream);
			}
			if (batch.ended && committedAll && session.ending)
				this.dropSession(session, session.ending.reason, true);
		});
		return true;
	}

	/**
	 * The server's committed state differs from what was expected: adopt it
	 * when it is a prefix of the lines sent (a retried chunk whose response
	 * was lost), otherwise find it in the local file. Repeated disagreement
	 * waits longer each time.
	 */
	private reconcile(
		session: Session,
		stream: Stream,
		committedLines: number,
		lastLineSha256: string | null,
	): void {
		stream.outOfSync += 1;
		const now = performance.now();
		if (stream.consecutiveResets > 0) {
			stream.holdUntil =
				now +
				Math.min(
					this.timing.resetBackoffInitialMs *
						2 ** (stream.consecutiveResets - 1),
					this.timing.resetBackoffMaxMs,
				);
		} else if (stream.outOfSync > 1) {
			stream.holdUntil =
				now +
				Math.min(
					1_000 * 2 ** (stream.outOfSync - 2),
					this.timing.resetBackoffMaxMs,
				);
		}
		if (stream.outOfSync > MAX_OUT_OF_SYNC_RETRIES) {
			this.resetStream(session, stream);
			return;
		}
		const base = stream.committedLines;
		const ahead = committedLines - base;
		if (ahead >= 0 && ahead <= stream.pending.length) {
			const sha =
				ahead === 0 ? stream.committedSha : stream.pending[ahead - 1]?.sha256;
			if ((committedLines === 0 ? null : sha) === lastLineSha256) {
				this.dropPending(session, stream, ahead);
				stream.committedLines = committedLines;
				stream.committedSha = lastLineSha256;
				stream.needsReset = false;
				return;
			}
		}
		this.dropPending(session, stream, stream.pending.length);
		stream.epoch += 1;
		stream.locate = { committedLines, lastLineSha256 };
		stream.scannedTo = -1;
	}

	private async handleRequestError(
		session: Session,
		error: unknown,
		clientKey: string | undefined,
	): Promise<void> {
		if (error instanceof ORPCError) {
			if (error.code === LIVE_SESSIONS_DISABLED_CODE) {
				const data = error.data as
					| { pauseSeconds?: unknown; scope?: unknown }
					| undefined;
				const scope = data?.scope === "workspace" ? "workspace" : "global";
				// Decided before the pause file appears (the loop watches it).
				if (scope === "global") this.stopReason ??= "disabled";
				await pauseLiveSessions(
					this.configDir,
					session.organizationId,
					scope,
					typeof data?.pauseSeconds === "number" ? data.pauseSeconds : 3_600,
				).catch((pauseError: unknown) =>
					logger.warn("Could not record the live session pause: {error}", {
						error: describeError(pauseError),
					}),
				);
				if (scope === "global") throw new StopFollowing("disabled");
				for (const other of [...this.sessions.values()])
					if (other.organizationId === session.organizationId)
						this.dropSession(other, "paused", true);
				throw new StopSession("paused");
			}
			if (error.code === SESSION_OWNERSHIP_CONFLICT_CODE)
				throw new StopSession("ownership-conflict");
			if (error.status === 401) {
				this.onUnauthorized(clientKey);
				return;
			}
			if (error.status === 403) throw new StopSession("forbidden");
			if (error.status === 429) {
				this.backoffUntil = Math.max(
					this.backoffUntil,
					performance.now() + this.timing.rateLimitBackoffMs,
				);
				return;
			}
			if (error.status < 500 && error.status !== 408) {
				logger.warn("Live session {sessionId} was rejected ({status} {code})", {
					code: error.code,
					sessionId: session.sessionId,
					status: error.status,
				});
				throw new StopSession(`rejected-${error.status}`);
			}
		}
		// Network failures, timeouts, 5xx and malformed responses: transient.
		this.backOff();
	}

	private backOff(): void {
		this.backoffMs =
			this.backoffMs === 0
				? this.timing.backoffInitialMs
				: Math.min(this.backoffMs * 2, this.timing.backoffMaxMs);
		this.backoffUntil = Math.max(
			this.backoffUntil,
			performance.now() + this.backoffMs,
		);
	}
}

/**
 * Claude Code runs one session per process at a time: a later registration
 * from the same process (`/clear`, `/resume`) supersedes earlier ones of
 * other sessions. Codex processes run many threads at once.
 */
function findSupersededRegistrations(
	registrations: readonly StoredLiveSessionRegistration[],
	alive: ReadonlyMap<StoredLiveSessionRegistration, boolean>,
): Set<StoredLiveSessionRegistration> {
	const newestByPid = new Map<number, StoredLiveSessionRegistration>();
	for (const registration of registrations) {
		if (registration.source !== "claude_code" || registration.agentPid === null)
			continue;
		if (alive.get(registration) !== true) continue;
		const newest = newestByPid.get(registration.agentPid);
		if (!newest || registration.startedAt > newest.startedAt)
			newestByPid.set(registration.agentPid, registration);
	}
	const superseded = new Set<StoredLiveSessionRegistration>();
	for (const registration of registrations) {
		if (registration.source !== "claude_code" || registration.agentPid === null)
			continue;
		const newest = newestByPid.get(registration.agentPid);
		if (newest && newest.sessionId !== registration.sessionId)
			superseded.add(registration);
	}
	return superseded;
}

function orderedStreams(session: Session): Stream[] {
	const main = session.streams.get("");
	const others = [...session.streams.values()]
		.filter((stream) => stream.agentId !== null)
		.sort((left, right) =>
			(left.agentId ?? "") < (right.agentId ?? "") ? -1 : 1,
		);
	return main ? [main, ...others] : others;
}

/** Ending, past its final read, and every stream read to its end. */
function isReadyToFinish(session: Session): boolean {
	return (
		session.ending !== undefined &&
		performance.now() >= session.ending.readAt &&
		session.serverStreams !== undefined &&
		session.discovered &&
		[...session.streams.values()].every(
			(stream) => stream.scannedTo !== -1 && stream.locate === undefined,
		)
	);
}

function hasReset(session: Session, now: number): boolean {
	for (const stream of session.streams.values())
		if (stream.needsReset && stream.holdUntil <= now) return true;
	return false;
}

/**
 * The offset just after line `lineIndex` when that line, through the live
 * pipeline, hashes to `sha256` (with the file's identity); undefined when
 * the file has fewer complete lines or a different line there. With
 * `replay`, earlier lines also go through the pipeline so `slimmer` holds the
 * state of an uninterrupted stream. Read errors are thrown (retried later).
 */
async function findLineEnd(
	path: string,
	lineIndex: number,
	sha256: string,
	slimmer: TranscriptSlimmer,
	buffer: Buffer,
	replay: boolean,
	onLine: () => void,
): Promise<{ offset: number; dev: number; inode: number } | undefined> {
	const { handle, stats } = await openRegularFile(path);
	try {
		let index = 0;
		let matched = false;
		const read = await readCompleteLines(
			handle,
			0,
			stats.size,
			(line) => {
				onLine();
				if (index < lineIndex) {
					if (replay) processLiveSessionLine(line, slimmer);
					index += 1;
					return true;
				}
				matched = processLiveSessionLine(line, slimmer).sha256 === sha256;
				return false;
			},
			buffer,
		);
		return read.stopped && matched
			? { dev: stats.dev, inode: stats.ino, offset: read.endOffset }
			: undefined;
	} finally {
		await handle.close().catch(() => undefined);
	}
}

/** `missing` = logged out; `invalid` = present but unreadable right now. */
/** `kill(pid, 0)`: ESRCH = gone, EPERM = not ours to judge. */
function processState(pid: number): "alive" | "dead" | "unknown" {
	try {
		process.kill(pid, 0);
		return "alive";
	} catch (error) {
		const code = (error as { code?: unknown }).code;
		return code === "ESRCH" ? "dead" : code === "EPERM" ? "unknown" : "alive";
	}
}

function readCredentials(
	configDir: string,
): Credentials | "missing" | "invalid" {
	try {
		const credentials = loadCredentials("read-only", configDir);
		if (!credentials) return "missing";
		return credentials.user ? credentials : "missing";
	} catch {
		return "invalid";
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
