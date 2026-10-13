import type { Stats } from "node:fs";
import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
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
import {
	DEFAULT_FILE_LEASE_OPTIONS,
	type FileLease,
	isProcessAlive,
	tryAcquireFileLease,
} from "./file-lease.js";
import { getGitInfo } from "./git-info.js";
import { getLiveSessionFollowerLeasePath } from "./live-session-launch.js";
import {
	createLineReadBuffer,
	type LiveSessionLine,
	processLiveSessionLine,
	type RawLiveSessionLine,
	readCompleteLines,
	readTail,
} from "./live-session-lines.js";
import {
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
import { readProcessStartIdentities } from "./process-identity.js";
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
const MAX_IGNORED_SUBAGENT_ENTRIES = 4_096;
const MAX_OUT_OF_SYNC_RETRIES = 3;
/** Ends the follower and forgets every registration. */
const GLOBAL_STOP_REASONS = new Set([
	"api-key-required",
	"disabled",
	"endpoint-refused",
	"invalid-response",
	"not-authenticated",
	"paused",
	"unauthorized",
	"unsupported",
]);

export interface LiveSessionFollowerTiming {
	readonly tickMs: number;
	readonly debounceMs: number;
	readonly sendThresholdBytes: number;
	/** How often process start identities are compared (PID reuse guard). */
	readonly identityCheckMs: number;
	/** Credentials, capability, pauses and repository settings. */
	readonly settingsCheckMs: number;
	/** Exit after this long without registered sessions. */
	readonly idleExitMs: number;
	readonly leaseWaitMs: number;
	readonly transcriptWaitMs: number;
	readonly maxSessionMs: number;
	readonly finalReadDelayMs: number;
	readonly finalFlushMs: number;
	readonly backoffInitialMs: number;
	readonly backoffMaxMs: number;
	readonly rateLimitBackoffMs: number;
	readonly capabilityTimeoutMs: number;
	readonly requestTimeoutMs: number;
	/** A hook-parent agent process that exits this soon was not the agent. */
	readonly orphanGraceMs: number;
	/** Such a session ends after its transcript is idle this long. */
	readonly orphanIdleMs: number;
	/** A Codex session without a known `codex` process ends after this idle time. */
	readonly codexOrphanIdleMs: number;
	/** A Codex session of a running `codex` process ends after this idle time. */
	readonly codexIdleMs: number;
	/** A registration whose agent is already gone is only flushed when this recent. */
	readonly staleRegistrationMs: number;
}

export const DEFAULT_LIVE_SESSION_FOLLOWER_TIMING: LiveSessionFollowerTiming = {
	tickMs: 1_000,
	debounceMs: 1_500,
	sendThresholdBytes: MIB,
	identityCheckMs: 30_000,
	settingsCheckMs: 60_000,
	idleExitMs: 60_000,
	leaseWaitMs: 2_000,
	transcriptWaitMs: 10 * 60_000,
	maxSessionMs: 7 * 24 * 60 * 60_000,
	finalReadDelayMs: 300,
	finalFlushMs: 60_000,
	backoffInitialMs: 1_000,
	backoffMaxMs: 30_000,
	rateLimitBackoffMs: 60_000,
	capabilityTimeoutMs: 10_000,
	requestTimeoutMs: 30_000,
	orphanGraceMs: 5_000,
	orphanIdleMs: 10 * 60_000,
	codexOrphanIdleMs: 30 * 60_000,
	codexIdleMs: 6 * 60 * 60_000,
	staleRegistrationMs: 10 * 60_000,
};

export interface LiveSessionFollowerOptions {
	readonly configDir?: string;
	readonly timing?: Partial<LiveSessionFollowerTiming>;
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
	inode: number | undefined;
	committedLines: number;
	committedSha: string | null;
	pending: LiveSessionLine[];
	pendingBytes: number;
	firstPendingAt: number | undefined;
	needsReset: boolean;
	outOfSync: number;
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
	serverStreams: Map<string, StreamCursor> | undefined;
	serverHadStreams: boolean;
	repository: { repoKey: string; legacyKeys: string[] } | undefined;
	gitRemote: string | undefined;
	gitBranch: string | undefined;
	subagentDirectory: string | undefined;
	pendingBytes: number;
	pendingLines: number;
	inputBytes: number;
	redactedBytes: number;
	readonly redactionCounts: Record<string, number>;
	/** Wall time of the last new transcript bytes (or of registration). */
	lastActivityAt: number;
	ending: Ending | undefined;
	streamLimitLogged: boolean;
	orphanLogged: boolean;
	linesSent: number;
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
	let reason: string;
	try {
		reason = await follower.run();
	} catch (error) {
		reason = error instanceof StopFollowing ? error.reason : "failed";
		if (!(error instanceof StopFollowing))
			logger.warn("Live session follower failed: {error}", {
				error: describeError(error),
			});
	}
	await follower.dispose(reason);
	return follower.result(reason);
}

class LiveSessionFollower {
	private readonly timing: LiveSessionFollowerTiming;
	private readonly configDir: string;
	private readonly sessions = new Map<string, Session>();
	private readonly readBuffer = createLineReadBuffer();
	private readonly codexRollouts = new CodexRolloutIndex();
	/** Registration file → wall time its agent process was last seen alive. */
	private readonly lastSeenAlive = new Map<string, number>();
	/** Agent pid → start identity first observed by the follower. */
	private readonly observedIdentities = new Map<number, string>();
	/** Agent pid → start identity at the latest check. */
	private readonly currentIdentities = new Map<number, string>();
	/** Registration files being removed (not to be followed again meanwhile). */
	private readonly removing = new Set<string>();
	/** Pids whose start identity changed since first observed (reused). */
	private readonly replacedIdentities = new Set<number>();
	private lease: FileLease | null = null;
	private started = false;
	private client: Client | undefined;
	private clientKey: string | undefined;
	private capabilityConfirmed = false;
	private pendingBytes = 0;
	private backoffUntil = 0;
	private backoffMs = 0;
	private sessionLimitLogged = false;
	private rotation = 0;
	private requests = 0;
	private linesSent = 0;
	private bytesSent = 0;
	private sessionsFollowed = 0;

	constructor(options: LiveSessionFollowerOptions) {
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
			sessions: this.sessionsFollowed,
		};
	}

	async run(): Promise<string> {
		this.lease = await this.acquireLease();
		if (!this.lease) return "already-running";
		this.started = true;
		logger.info("Live session follower started (process {pid})", {
			pid: process.pid,
		});
		return await this.loop();
	}

	async dispose(reason: string): Promise<void> {
		for (const session of [...this.sessions.values()])
			this.dropSession(session, reason, false);
		if (GLOBAL_STOP_REASONS.has(reason))
			await removeAllLiveSessionRegistrations(this.configDir).catch(
				() => undefined,
			);
		await this.lease?.release().catch(() => undefined);
		this.lease = null;
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
		while (true) {
			const lease = await tryAcquireFileLease(path, DEFAULT_FILE_LEASE_OPTIONS);
			if (lease || performance.now() >= waitUntil) return lease;
			await sleep(Math.min(250, this.timing.tickMs));
		}
	}

	// Main loop --------------------------------------------------------------

	private async loop(): Promise<string> {
		const { timing } = this;
		let nextTick = 0;
		let nextSettings = 0;
		let nextIdentity = 0;
		let idleSince: number | undefined;
		while (true) {
			let now = performance.now();
			if (now >= nextSettings) {
				nextSettings = now + timing.settingsCheckMs;
				const reason = await this.checkSettings();
				if (reason) return reason;
			}
			if (now >= nextTick) {
				nextTick = now + timing.tickMs;
				if (!(await this.ownsLease())) return "lease-lost";
				const checkIdentities = now >= nextIdentity;
				if (checkIdentities) nextIdentity = now + timing.identityCheckMs;
				const registered = await this.syncRegistrations(checkIdentities);
				if (this.sessions.size > 0 || registered) idleSince = undefined;
				else {
					idleSince ??= now;
					if (now - idleSince >= timing.idleExitMs) {
						if (await this.handOver()) return "idle";
						idleSince = undefined;
					}
				}
				if (!this.capabilityConfirmed && now >= this.backoffUntil)
					await this.confirmCapability();
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
			let sent = false;
			if (this.capabilityConfirmed && now >= this.backoffUntil)
				sent = await this.sendDue(now, backlog);
			await this.finishEndedSessions();
			// Catching up: keep reading and sending without waiting.
			if (sent && performance.now() >= this.backoffUntil && backlog) continue;
			await sleep(this.nextDelay(nextTick));
		}
	}

	private nextDelay(nextTick: number): number {
		const now = performance.now();
		let wakeAt = nextTick;
		for (const session of this.sessions.values()) {
			const first = oldestPendingAt(session);
			if (first !== undefined && !session.ending)
				wakeAt = Math.min(
					wakeAt,
					Math.max(first + this.timing.debounceMs, this.backoffUntil),
				);
			const ending = session.ending;
			if (ending && now < ending.readAt)
				wakeAt = Math.min(wakeAt, ending.readAt);
			else if (
				ending &&
				this.capabilityConfirmed &&
				(session.pendingLines > 0 || isReadyToFinish(session))
			)
				wakeAt = Math.min(wakeAt, this.backoffUntil);
		}
		return Math.max(0, Math.min(this.timing.tickMs, wakeAt - now));
	}

	private ordered(): Session[] {
		const sessions = [...this.sessions.values()];
		if (sessions.length === 0) return sessions;
		const start = this.rotation % sessions.length;
		return [...sessions.slice(start), ...sessions.slice(0, start)];
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
			DEFAULT_FILE_LEASE_OPTIONS,
		).catch(() => null);
		return this.lease === null;
	}

	// Settings ---------------------------------------------------------------

	private async checkSettings(): Promise<string | undefined> {
		const credentials = readCredentials(this.configDir);
		if (!credentials) return "not-authenticated";
		if (credentials.authType !== "api-key") return "api-key-required";
		if (isLiveSessionPaused(this.configDir, "")) return "paused";
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
		}
		await this.confirmCapability();
		for (const session of [...this.sessions.values()]) {
			if (isLiveSessionPaused(this.configDir, session.organizationId))
				this.dropSession(session, "paused", true);
			else if (!this.isRepositoryAllowed(session))
				this.dropSession(session, "repository-disabled", true);
		}
		return undefined;
	}

	/** `cli.authStatus` must advertise `liveSessions`; a network failure retries. */
	private async confirmCapability(): Promise<void> {
		const client = this.client;
		if (!client) return;
		try {
			this.requests += 1;
			const status = await client.cli.authStatus(undefined, {
				signal: AbortSignal.timeout(this.timing.capabilityTimeoutMs),
			});
			if (status.capabilities?.liveSessions !== true)
				throw new StopFollowing("unsupported");
			this.capabilityConfirmed = true;
		} catch (error) {
			if (error instanceof StopFollowing) throw error;
			if (
				error instanceof ORPCError &&
				(error.status === 401 || error.status === 403)
			)
				throw new StopFollowing("unauthorized");
			if (!this.capabilityConfirmed) this.backOff();
		}
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

	/**
	 * Reads registrations, decides which agent processes still run, starts
	 * following new sessions and starts ending sessions without a live
	 * registration. Returns whether any registration exists.
	 */
	private async syncRegistrations(checkIdentities: boolean): Promise<boolean> {
		const registrations = (
			await listLiveSessionRegistrations(this.configDir)
		).filter((registration) => !this.removing.has(registration.file));
		const now = Date.now();
		const pids = [
			...new Set(
				registrations
					.map((registration) => registration.agentPid)
					.filter((pid): pid is number => pid !== null),
			),
		];
		const alivePids = new Set(pids.filter((pid) => isProcessAlive(pid)));
		if (checkIdentities) await this.checkIdentities([...alivePids]);
		const alive = new Map<StoredLiveSessionRegistration, boolean>();
		for (const registration of registrations)
			alive.set(
				registration,
				this.isRegistrationAlive(registration, alivePids, now),
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
				live.length === 0 &&
				now - newest.startedAt > this.timing.staleRegistrationMs
			) {
				// Left behind (for example by a reboot): nothing to follow.
				for (const registration of group)
					await removeLiveSessionRegistration(registration);
				continue;
			}
			if (isLiveSessionPaused(this.configDir, newest.organizationId)) {
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
			if (live.length === 0) this.beginEnding(created, "agent-exited");
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

	private async checkIdentities(pids: number[]): Promise<void> {
		this.replacedIdentities.clear();
		for (const known of [...this.observedIdentities.keys()])
			if (!pids.includes(known)) {
				this.observedIdentities.delete(known);
				this.currentIdentities.delete(known);
			}
		const identities = await readProcessStartIdentities(pids);
		for (const pid of pids) {
			const identity = identities.get(pid);
			if (identity === undefined) continue;
			const observed = this.observedIdentities.get(pid);
			if (observed === undefined) this.observedIdentities.set(pid, identity);
			else if (observed !== identity) this.replacedIdentities.add(pid);
			this.currentIdentities.set(pid, identity);
		}
	}

	private isRegistrationAlive(
		registration: StoredLiveSessionRegistration,
		alivePids: ReadonlySet<number>,
		now: number,
	): boolean {
		const session = this.sessions.get(
			getLiveSessionKey(registration.source, registration.sessionId),
		);
		const lastActivityAt = Math.max(
			session?.lastActivityAt ?? 0,
			registration.startedAt,
		);
		if (registration.agentPid === null)
			// Codex without a known `codex` process: follow while the rollout is active.
			return now - lastActivityAt < this.timing.codexOrphanIdleMs;
		const pid = registration.agentPid;
		const current = this.currentIdentities.get(pid);
		const reused =
			this.replacedIdentities.has(pid) ||
			(registration.agentStartIdentity !== null &&
				current !== undefined &&
				current !== registration.agentStartIdentity);
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
	): Promise<Session> {
		const session: Session = {
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
			serverHadStreams: false,
			serverStreams: undefined,
			sessionId: registration.sessionId,
			source: registration.source,
			streamLimitLogged: false,
			streams: new Map(),
			subagentDirectory: undefined,
			transcriptPath: registration.transcriptPath,
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
		logger.info("Live session {sessionId} ({source}) followed", {
			sessionId: session.sessionId,
			source: session.source,
		});
		if (!this.isRepositoryAllowed(session))
			this.dropSession(session, "repository-disabled", true);
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
		if (error instanceof StopFollowing) throw error;
		const reason = error instanceof StopSession ? error.reason : "failed";
		if (!(error instanceof StopSession))
			logger.warn("Live session {sessionId} failed: {error}", {
				error: describeError(error),
				sessionId: session.sessionId,
			});
		this.dropSession(session, reason, true);
	}

	// Per-session work ---------------------------------------------------------

	/** State, stream discovery and per-session limits (once per tick). */
	private async refreshSession(session: Session): Promise<void> {
		const now = performance.now();
		if (now - session.createdAt >= this.timing.maxSessionMs)
			throw new StopSession("max-runtime");
		if (!session.serverStreams) {
			if (!this.capabilityConfirmed || now < this.backoffUntil) return;
			await this.loadServerState(session);
			if (!session.serverStreams) return;
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

	private async loadServerState(session: Session): Promise<void> {
		const client = this.client;
		if (!client) return;
		try {
			this.requests += 1;
			const state = LiveSessionStateOutputSchema.parse(
				await client.liveSession.state(this.target(session), {
					signal: AbortSignal.timeout(this.timing.requestTimeoutMs),
				}),
			);
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
			this.backoffMs = 0;
		} catch (error) {
			await this.handleRequestError(session, error);
		}
	}

	private async discoverStreams(session: Session): Promise<void> {
		if (!session.streams.has("")) {
			try {
				const metadata = await stat(session.transcriptPath);
				if (metadata.isFile())
					await this.addStream(session, null, session.transcriptPath);
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
					session.ignoredEntries.add(child.threadId);
					continue;
				}
				try {
					const metadata = await lstat(child.transcriptPath);
					if (!metadata.isFile()) {
						session.ignoredEntries.add(child.threadId);
						continue;
					}
					await this.addStream(session, child.threadId, child.transcriptPath);
				} catch {
					// Seen again next tick.
				}
			}
			return;
		}
		const directory = await this.resolveClaudeSubagentDirectory(session);
		if (!directory) return;
		let names: string[];
		try {
			names = await readdir(directory);
		} catch {
			return;
		}
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
					if (session.ignoredEntries.size < MAX_IGNORED_SUBAGENT_ENTRIES)
						session.ignoredEntries.add(name);
					continue;
				}
				await this.addStream(session, agentId, canonical);
			} catch {
				// Removed or replaced while scanning; seen again next tick.
			}
		}
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
				return directory;
			}
		} catch {
			// Not created until the first subagent runs.
		}
		return undefined;
	}

	private async addStream(
		session: Session,
		agentId: string | null,
		path: string,
	): Promise<void> {
		const stream: Stream = {
			agentId,
			committedLines: 0,
			committedSha: null,
			firstPendingAt: undefined,
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
		this.dropPending(session, stream, stream.pending.length);
		stream.slimmer = createTranscriptSlimmer();
		stream.scannedTo = -1;
		stream.outOfSync = 0;
		if (cursor.committedLines === 0 || cursor.lastLineSha256 === null) {
			stream.locate = undefined;
			this.resetStream(session, stream);
			return;
		}
		// Codex slimming depends on earlier records of the stream: replay them
		// (without sending) so later lines match an uninterrupted follower.
		const offset = await findLineEnd(
			stream.path,
			cursor.committedLines - 1,
			cursor.lastLineSha256,
			stream.slimmer,
			this.readBuffer,
			session.source === "codex",
		);
		stream.locate = undefined;
		if (offset === undefined) {
			this.resetStream(session, stream);
			return;
		}
		stream.rawOffset = offset;
		stream.committedLines = cursor.committedLines;
		stream.committedSha = cursor.lastLineSha256;
		stream.needsReset = false;
	}

	private resetStream(session: Session, stream: Stream): void {
		this.dropPending(session, stream, stream.pending.length);
		stream.slimmer = createTranscriptSlimmer();
		stream.rawOffset = 0;
		stream.scannedTo = -1;
		stream.committedLines = 0;
		stream.committedSha = null;
		stream.needsReset = true;
		stream.outOfSync = 0;
		stream.locate = undefined;
	}

	private dropPending(session: Session, stream: Stream, count: number): void {
		if (count <= 0) return;
		const dropped = stream.pending.splice(0, count);
		const bytes = dropped.reduce((total, line) => total + line.bytes, 0);
		stream.pendingBytes -= bytes;
		session.pendingBytes -= bytes;
		session.pendingLines -= dropped.length;
		this.pendingBytes -= bytes;
		if (stream.pending.length === 0) stream.firstPendingAt = undefined;
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
			} catch {
				// Unreadable for now (permissions, removed or replaced): next tick.
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
		let metadata: Stats = await stat(stream.path);
		if (
			metadata.size < stream.rawOffset ||
			(stream.inode !== undefined && metadata.ino !== stream.inode)
		)
			this.resetStream(session, stream);
		stream.inode = metadata.ino;
		if (metadata.size === stream.scannedTo && !final) return false;
		const handle = await open(stream.path, "r");
		try {
			metadata = await handle.stat();
			const before = stream.rawOffset;
			const read = await readCompleteLines(
				handle,
				stream.rawOffset,
				metadata.size,
				(line) => {
					this.enqueue(session, stream, line);
					return this.pendingBytes < READ_AHEAD_BYTES;
				},
				this.readBuffer,
			);
			stream.rawOffset = read.endOffset;
			stream.scannedTo = read.stopped ? -1 : metadata.size;
			if (read.endOffset > before) session.lastActivityAt = Date.now();
			if (read.stopped) return true;
			if (final && stream.rawOffset < metadata.size) {
				// The agent is gone: a final line without `\n` is sent only when
				// it is complete JSON.
				const tail = await readTail(handle, stream.rawOffset, metadata.size);
				if (tail && isJson(tail)) {
					this.enqueue(session, stream, { bytes: tail, kind: "line" });
					stream.rawOffset = metadata.size;
				}
			}
		} finally {
			await handle.close();
		}
		return false;
	}

	private enqueue(
		session: Session,
		stream: Stream,
		raw: RawLiveSessionLine,
	): void {
		const line = processLiveSessionLine(raw, stream.slimmer);
		session.inputBytes += line.inputBytes;
		session.redactedBytes += line.redactedBytes;
		addCounts(session.redactionCounts, line.redactions);
		stream.pending.push({
			bytes: line.bytes,
			sha256: line.sha256,
			text: line.text,
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

	/** One append for each session that is due. Returns whether any was sent. */
	private async sendDue(now: number, backlog: boolean): Promise<boolean> {
		let sent = false;
		for (const session of this.ordered()) {
			if (now < this.backoffUntil) break;
			if (!session.serverStreams || session.ending) continue;
			if (!this.isDue(session, now, backlog)) continue;
			try {
				await this.sendOnce(session, false);
				sent = true;
			} catch (error) {
				this.handleSessionError(session, error);
			}
		}
		return sent;
	}

	private isDue(session: Session, now: number, backlog: boolean): boolean {
		if (session.pendingLines === 0 && !hasEmptyReset(session)) return false;
		if (backlog || session.pendingBytes >= this.timing.sendThresholdBytes)
			return true;
		const first = oldestPendingAt(session);
		return first === undefined || now - first >= this.timing.debounceMs;
	}

	/**
	 * Ending sessions: after the final read, send everything and `ended`, then
	 * forget the session and its registrations.
	 */
	private async finishEndedSessions(): Promise<void> {
		for (const session of this.ordered()) {
			const ending = session.ending;
			if (!ending) continue;
			const now = performance.now();
			if (now >= ending.deadline) {
				this.dropSession(session, `${ending.reason}-unflushed`, true);
				continue;
			}
			if (now < ending.readAt || !session.serverStreams) continue;
			if (!this.capabilityConfirmed || now < this.backoffUntil) continue;
			try {
				const ready = isReadyToFinish(session);
				const more = session.pendingLines > 0 || hasEmptyReset(session);
				if (!ready && !more) continue;
				if (
					ready &&
					!more &&
					session.linesSent === 0 &&
					!session.serverHadStreams
				) {
					this.dropSession(session, ending.reason, true);
					continue;
				}
				if (await this.sendOnce(session, ready))
					this.dropSession(session, ending.reason, true);
			} catch (error) {
				this.handleSessionError(session, error);
			}
		}
	}

	/**
	 * Sends one append with as many pending lines of this session as the
	 * request limits allow. Returns true when `ended` was requested and
	 * everything was committed.
	 */
	private async sendOnce(
		session: Session,
		endedIfComplete: boolean,
	): Promise<boolean> {
		const client = this.client;
		if (!client) return false;
		const batch: { stream: Stream; lines: LiveSessionLine[] }[] = [];
		let batchBytes = 0;
		for (const stream of orderedStreams(session)) {
			if (batch.length >= LIVE_SESSION_MAX_STREAMS_PER_REQUEST) break;
			if (stream.locate) continue;
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
			[...session.streams.values()].every((stream) => {
				const item = batch.find((entry) => entry.stream === stream);
				return item
					? item.lines.length === stream.pending.length
					: stream.pending.length === 0 && !stream.needsReset;
			});
		const input: LiveSessionAppendInput = {
			...this.target(session),
			projectPath: session.cwd,
			...(session.gitRemote ? { gitRemote: session.gitRemote } : {}),
			...(session.gitBranch ? { gitBranch: session.gitBranch } : {}),
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
				await client.liveSession.append(input, {
					signal: AbortSignal.timeout(this.timing.requestTimeoutMs),
				}),
			);
		} catch (error) {
			await this.handleRequestError(session, error);
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
				const bytes = lines.reduce((total, line) => total + line.bytes, 0);
				this.dropPending(session, stream, lines.length);
				stream.committedLines = expectedLines;
				stream.committedSha = expectedSha;
				stream.needsReset = false;
				stream.outOfSync = 0;
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
		return complete && committedAll;
	}

	/**
	 * The server's committed state differs from what was expected: adopt it
	 * when it is a prefix of the lines sent (a retried chunk whose response
	 * was lost), otherwise find it in the local file.
	 */
	private reconcile(
		session: Session,
		stream: Stream,
		committedLines: number,
		lastLineSha256: string | null,
	): void {
		stream.outOfSync += 1;
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
		stream.locate = { committedLines, lastLineSha256 };
		stream.scannedTo = -1;
	}

	private async handleRequestError(
		session: Session,
		error: unknown,
	): Promise<void> {
		if (error instanceof ORPCError) {
			if (error.code === LIVE_SESSIONS_DISABLED_CODE) {
				const data = error.data as
					| { pauseSeconds?: unknown; scope?: unknown }
					| undefined;
				const scope = data?.scope === "workspace" ? "workspace" : "global";
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
			if (error.status === 401 || error.status === 403)
				throw new StopFollowing("unauthorized");
			if (error.status === 429) {
				this.backoffUntil = performance.now() + this.timing.rateLimitBackoffMs;
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
		} else if (error instanceof ZodError) {
			throw new StopFollowing("invalid-response");
		}
		this.backOff();
	}

	private backOff(): void {
		this.backoffMs =
			this.backoffMs === 0
				? this.timing.backoffInitialMs
				: Math.min(this.backoffMs * 2, this.timing.backoffMaxMs);
		this.backoffUntil = performance.now() + this.backoffMs;
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

function oldestPendingAt(session: Session): number | undefined {
	let oldest: number | undefined;
	for (const stream of session.streams.values())
		if (
			stream.firstPendingAt !== undefined &&
			(oldest === undefined || stream.firstPendingAt < oldest)
		)
			oldest = stream.firstPendingAt;
	return oldest;
}

/** Ending, past its final read, and every stream read to its end. */
function isReadyToFinish(session: Session): boolean {
	return (
		session.ending !== undefined &&
		performance.now() >= session.ending.readAt &&
		session.serverStreams !== undefined &&
		[...session.streams.values()].every(
			(stream) => stream.scannedTo !== -1 && stream.locate === undefined,
		)
	);
}

function hasEmptyReset(session: Session): boolean {
	for (const stream of session.streams.values())
		if (stream.needsReset && stream.pending.length === 0) return true;
	return false;
}

/**
 * Byte offset just after line `lineIndex` when that line, through the live
 * pipeline, hashes to `sha256`; undefined when the file has fewer complete
 * lines or a different line there. With `replay`, earlier lines also go
 * through the pipeline so `slimmer` holds the state of an uninterrupted
 * stream. Read errors are thrown (the caller retries later).
 */
async function findLineEnd(
	path: string,
	lineIndex: number,
	sha256: string,
	slimmer: TranscriptSlimmer,
	buffer: Buffer,
	replay: boolean,
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
					if (replay) processLiveSessionLine(line, slimmer);
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

function readCredentials(configDir: string): Credentials | null {
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
