import { spawn } from "node:child_process";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseSafeApiEndpoint, type Source } from "../contracts/index.js";
import {
	SESSION_INVENTORY_MAX_SESSIONS,
	type SessionInventoryEntry,
} from "../contracts/session-inventory.js";
import { MissingTranscriptTimestampError } from "../internal/agent-adapters/errors.js";
import type {
	AgentAdapter,
	SessionFile,
} from "../internal/agent-adapters/index.js";
import { createApiClient } from "./api-client.js";
import { getApiBaseOverride } from "./api-target.js";
import {
	isRepositoryAutoUploadDisabled,
	loadAutoUploadConfig,
} from "./auto-upload-config.js";
import { type Credentials, loadCredentials } from "./credentials.js";
import { tryAcquireFileLease } from "./file-lease.js";
import { type GitInfo, getGitInfo } from "./git-info.js";
import { getConfigDir, writePrivateFile } from "./local-state.js";
import { getCliVersion } from "./product-analytics.js";
import { getProjectOrgId } from "./project-config.js";
import { inferSessionRepository } from "./session-repository.js";
import { allowsInsecureEndpointFromEnv } from "./upload-endpoint.js";
import {
	discoverUploadRepositories,
	getUploadAdapters,
	type UploadRepository,
} from "./upload-manager-repositories.js";

export const SESSION_INVENTORY_INTERVAL_MS = 30 * 60_000;
const UNSUPPORTED_RETRY_MS = 24 * 60 * 60_000;
const CACHE_VERSION = 1;
const STATE_FILE = "session-inventory.json";
const CACHE_FILE = "session-inventory-cache.json";
const LEASE_DIRECTORY = "session-inventory.lease";
const FORCE_ENV = "OPALINE_SESSION_INVENTORY_FORCE";
const SUBAGENT_FILE = /^agent-[A-Za-z0-9_-]{1,200}\.jsonl$/u;

interface InventoryState {
	lastAttemptAt?: number;
	lastSentAt?: number;
	unsupportedUntil?: number;
}

interface CachedCounts {
	mainLines: number;
	mainBytes: number;
	subagentLines: number;
	subagentBytes: number;
	subagentFiles: number;
	modifiedMs: number;
}

interface CachedSession {
	signature: string;
	excluded?: true;
	inferred?: { repoKey: string; legacyKeys: string[] } | null;
	counts?: CachedCounts;
}

interface InventoryCache {
	version: number;
	sessions: Record<string, CachedSession>;
}

export interface InventoryGroup {
	organizationId?: string;
	sessions: SessionInventoryEntry[];
	omitted: number;
}

export type InventoryOutcome =
	| "sent"
	| "not-due"
	| "busy"
	| "unsupported"
	| "signed-out"
	| "disabled"
	| "failed";

export async function countTranscriptLines(
	path: string,
): Promise<{ lines: number; bytes: number }> {
	let lines = 0;
	let bytes = 0;
	let content = false;
	for await (const chunk of createReadStream(path, {
		highWaterMark: 1024 * 1024,
	}) as AsyncIterable<Buffer>) {
		bytes += chunk.length;
		for (let index = 0; index < chunk.length; index++) {
			const byte = chunk[index];
			if (byte === 10) {
				if (content) lines++;
				content = false;
			} else if (
				!content &&
				byte !== 32 &&
				byte !== 9 &&
				byte !== 13 &&
				byte !== 11 &&
				byte !== 12
			)
				content = true;
		}
	}
	if (content) lines++;
	return { lines, bytes };
}

export async function collectSessionInventory(
	options: {
		adapters?: AgentAdapter[];
		configDir?: string;
		cwd?: string;
		maxSessions?: number;
	} = {},
): Promise<InventoryGroup[]> {
	const configDir = options.configDir ?? getConfigDir();
	const adapters = options.adapters ?? getUploadAdapters();
	const config = loadAutoUploadConfig(configDir);
	const repositories = await discoverUploadRepositories(() => undefined, {
		adapters,
		configDir,
		cwd: options.cwd,
	});
	const previous = readCache(configDir);
	const cache: InventoryCache = { version: CACHE_VERSION, sessions: {} };
	const gitInfo = new Map<string, Promise<GitInfo>>();
	const organizations = new Map<string, Promise<string | undefined>>();
	const projectAgentFiles = new Map<string, Promise<string>>();
	const groups = new Map<string, SessionInventoryEntry[]>();
	for (const repository of repositories) {
		if (!repository.enabled) continue;
		for (const session of repository.sessions ?? []) {
			const adapter = adapters.find(
				(candidate) => candidate.source === session.source,
			);
			if (!adapter || !isSourceAllowed(config !== null, repository, adapter))
				continue;
			const key = `${session.source}:${session.sessionId}`;
			const inspected = await inspectSession(adapter, session, {
				previous: previous.sessions[key],
				gitInfo,
				projectAgentFiles,
			});
			if (!inspected) continue;
			cache.sessions[key] = inspected;
			if (inspected.excluded || !inspected.counts) continue;
			if (
				inspected.inferred &&
				isRepositoryAutoUploadDisabled(
					inspected.inferred.repoKey,
					session.source,
					inspected.inferred.legacyKeys,
					configDir,
				)
			)
				continue;
			let organization = organizations.get(session.projectPath);
			if (!organization) {
				organization = getProjectOrgId(session.projectPath).then(
					(id) => id ?? repository.organizationId,
				);
				organizations.set(session.projectPath, organization);
			}
			const organizationId = (await organization) ?? "";
			const entries = groups.get(organizationId) ?? [];
			entries.push(inventoryEntry(session, inspected.counts));
			groups.set(organizationId, entries);
		}
	}
	await writePrivateFile(
		join(configDir, CACHE_FILE),
		JSON.stringify(cache),
		configDir,
	);
	const maxSessions = options.maxSessions ?? SESSION_INVENTORY_MAX_SESSIONS;
	return [...groups].map(([organizationId, sessions]) => {
		const newest = sessions
			.sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt))
			.slice(0, maxSessions);
		return {
			...(organizationId ? { organizationId } : {}),
			sessions: newest,
			omitted: sessions.length - newest.length,
		};
	});
}

export async function runSessionInventory(
	options: {
		configDir?: string;
		adapters?: AgentAdapter[];
		credentials?: Credentials | null;
		force?: boolean;
		now?: () => number;
		onWarning?: (warning: string) => void;
	} = {},
): Promise<InventoryOutcome> {
	const configDir = options.configDir ?? getConfigDir();
	const now = options.now ?? Date.now;
	if (isSessionInventoryDisabledByEnvironment()) return "disabled";
	const credentials = options.credentials ?? loadCredentials();
	if (!credentials) return "signed-out";
	const lease = await tryAcquireFileLease(join(configDir, LEASE_DIRECTORY));
	if (!lease) return "busy";
	try {
		const state = readState(configDir);
		if (!options.force && !isDue(state, now())) return "not-due";
		if ((state.unsupportedUntil ?? 0) > now()) return "unsupported";
		await writeState(configDir, { ...state, lastAttemptAt: now() });
		const apiBase = getApiBaseOverride() ?? credentials.apiBaseUrl;
		const endpoint = parseSafeApiEndpoint(`${apiBase}/rpc`, {
			allowPlaintext: allowsInsecureEndpointFromEnv(),
		});
		if (!endpoint.ok) return "failed";
		const client = createApiClient({
			apiBaseUrl: endpoint.url.replace(/\/rpc\/?$/u, ""),
			token: credentials.token,
			authType: credentials.authType,
		});
		const status = await client.cli.authStatus(undefined, {
			signal: AbortSignal.timeout(10_000),
		});
		if (!status.capabilities?.sessionInventory) {
			await writeState(configDir, {
				...readState(configDir),
				unsupportedUntil: now() + UNSUPPORTED_RETRY_MS,
			});
			return "unsupported";
		}
		const groups = await collectSessionInventory({
			adapters: options.adapters,
			configDir,
		});
		let failed = false;
		for (const group of groups) {
			try {
				await client.cli.sessionInventory(
					{
						...(group.organizationId
							? { organizationId: group.organizationId }
							: {}),
						cliVersion: getCliVersion(),
						omitted: group.omitted,
						sessions: group.sessions,
					},
					{ signal: AbortSignal.timeout(60_000) },
				);
			} catch (error) {
				failed = true;
				options.onWarning?.(
					`Session inventory was not accepted: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
		if (failed) return "failed";
		await writeState(configDir, { ...readState(configDir), lastSentAt: now() });
		return "sent";
	} catch (error) {
		options.onWarning?.(
			`Session inventory failed: ${error instanceof Error ? error.message : String(error)}`,
		);
		return "failed";
	} finally {
		await lease.release();
	}
}

export function startSessionInventoryInBackground(
	options: { configDir?: string; force?: boolean; now?: number } = {},
): boolean {
	try {
		if (isSessionInventoryDisabledByEnvironment()) return false;
		const configDir = options.configDir ?? getConfigDir();
		const state = readState(configDir);
		const now = options.now ?? Date.now();
		if (!options.force && !isDue(state, now)) return false;
		if ((state.unsupportedUntil ?? 0) > now) return false;
		if (!loadCredentials("read-only", configDir)) return false;
		const entrypoint = process.argv[1];
		if (!entrypoint) return false;
		const child = spawn(
			process.execPath,
			[...process.execArgv, entrypoint, "hooks", "session-inventory"],
			{
				detached: process.platform !== "win32",
				env: options.force ? { ...process.env, [FORCE_ENV]: "1" } : process.env,
				stdio: "ignore",
				windowsHide: true,
			},
		);
		child.on("error", () => undefined);
		child.unref();
		return true;
	} catch {
		return false;
	}
}

export function isSessionInventoryDisabledByEnvironment(
	environment: NodeJS.ProcessEnv = process.env,
): boolean {
	const value = environment.OPALINE_SESSION_INVENTORY?.trim().toLowerCase();
	return value === "0" || value === "false" || value === "off";
}

export function isSessionInventoryForced(): boolean {
	return process.env[FORCE_ENV] === "1";
}

function isDue(state: InventoryState, now: number): boolean {
	return now - (state.lastAttemptAt ?? 0) >= SESSION_INVENTORY_INTERVAL_MS;
}

function isSourceAllowed(
	managed: boolean,
	repository: UploadRepository,
	adapter: AgentAdapter,
): boolean {
	if (managed)
		return repository.enabledSources?.includes(adapter.source) === true;
	const installed = (options: { global?: boolean; projectPath?: string }) => {
		try {
			return adapter.isHookInstalled(options);
		} catch {
			return false;
		}
	};
	return (
		installed({ global: true }) ||
		repository.paths.some(
			(path) => existsSync(path) && installed({ projectPath: path }),
		)
	);
}

async function inspectSession(
	adapter: AgentAdapter,
	session: SessionFile & { source: Source },
	context: {
		previous: CachedSession | undefined;
		gitInfo: Map<string, Promise<GitInfo>>;
		projectAgentFiles: Map<string, Promise<string>>;
	},
): Promise<CachedSession | null> {
	let signature: string;
	try {
		signature = await sessionSignature(session, context.projectAgentFiles);
	} catch {
		return null;
	}
	if (
		context.previous?.signature === signature &&
		isCachedSession(context.previous)
	)
		return context.previous;
	let info = context.gitInfo.get(session.projectPath);
	if (!info) {
		info = getGitInfo(session.projectPath);
		context.gitInfo.set(session.projectPath, info);
	}
	try {
		const request = await adapter.buildUploadRequest(session, {
			gitInfo: await info,
			uploadMode: "hook",
		});
		const inferred =
			request.metadata.gitRemote || request.metadata.packageName
				? null
				: await inferSessionRepository(request);
		const main = await countTranscriptLines(request.transcriptPath);
		const subagents = await Promise.all(
			request.subagents.map((subagent) => countTranscriptLines(subagent.path)),
		);
		const modified = await Promise.all(
			[
				request.transcriptPath,
				...request.subagents.map((subagent) => subagent.path),
			].map(async (path) => (await stat(path)).mtimeMs),
		);
		return {
			signature,
			inferred: inferred
				? {
						repoKey: inferred.repository.repoKey,
						legacyKeys: [...inferred.legacyKeys],
					}
				: null,
			counts: {
				mainLines: main.lines,
				mainBytes: main.bytes,
				subagentLines: subagents.reduce((sum, file) => sum + file.lines, 0),
				subagentBytes: subagents.reduce((sum, file) => sum + file.bytes, 0),
				subagentFiles: subagents.length,
				modifiedMs: Math.max(...modified),
			},
		};
	} catch (error) {
		if (error instanceof MissingTranscriptTimestampError)
			return { signature, excluded: true };
		return null;
	}
}

async function sessionSignature(
	session: SessionFile & { source: Source },
	projectAgentFiles: Map<string, Promise<string>>,
): Promise<string> {
	const main = await stat(session.transcriptPath);
	if (session.source !== "claude_code")
		return JSON.stringify([main.size, main.mtimeMs]);
	const projectDirectory = dirname(session.transcriptPath);
	let projectAgents = projectAgentFiles.get(projectDirectory);
	if (!projectAgents) {
		projectAgents = agentFilesSignature(projectDirectory);
		projectAgentFiles.set(projectDirectory, projectAgents);
	}
	return JSON.stringify([
		main.size,
		main.mtimeMs,
		await projectAgents,
		await agentFilesSignature(
			join(projectDirectory, session.sessionId, "subagents"),
		),
	]);
}

async function agentFilesSignature(directory: string): Promise<string> {
	let names: string[];
	try {
		names = (await readdir(directory)).filter((name) =>
			SUBAGENT_FILE.test(name),
		);
	} catch {
		return "";
	}
	const files = await Promise.all(
		names.sort().map(async (name) => {
			try {
				const file = await stat(join(directory, name));
				return [name, file.size, file.mtimeMs];
			} catch {
				return [name];
			}
		}),
	);
	return JSON.stringify(files);
}

function inventoryEntry(
	session: SessionFile & { source: Source },
	counts: CachedCounts,
): SessionInventoryEntry {
	return {
		sessionId: session.sessionId,
		source: session.source,
		mainLines: counts.mainLines,
		subagentLines: counts.subagentLines,
		subagentFiles: counts.subagentFiles,
		mainBytes: counts.mainBytes,
		subagentBytes: counts.subagentBytes,
		modifiedAt: new Date(counts.modifiedMs).toISOString(),
		...(session.sessionDate !== undefined &&
		Number.isFinite(session.sessionDate)
			? { startedAt: new Date(session.sessionDate).toISOString() }
			: {}),
	};
}

function isCachedSession(value: CachedSession): boolean {
	if (value.excluded === true) return true;
	const counts = value.counts;
	return (
		counts !== undefined &&
		[
			counts.mainLines,
			counts.mainBytes,
			counts.subagentLines,
			counts.subagentBytes,
			counts.subagentFiles,
			counts.modifiedMs,
		].every((field) => typeof field === "number" && Number.isFinite(field))
	);
}

function readState(configDir: string): InventoryState {
	const value = readJson(join(configDir, STATE_FILE));
	if (typeof value !== "object" || value === null) return {};
	const state: InventoryState = {};
	for (const key of [
		"lastAttemptAt",
		"lastSentAt",
		"unsupportedUntil",
	] as const) {
		const field = (value as Record<string, unknown>)[key];
		if (typeof field === "number" && Number.isFinite(field)) state[key] = field;
	}
	return state;
}

async function writeState(
	configDir: string,
	state: InventoryState,
): Promise<void> {
	await writePrivateFile(
		join(configDir, STATE_FILE),
		JSON.stringify(state),
		configDir,
	);
}

function readCache(configDir: string): InventoryCache {
	const value = readJson(join(configDir, CACHE_FILE));
	if (
		typeof value === "object" &&
		value !== null &&
		(value as InventoryCache).version === CACHE_VERSION &&
		typeof (value as InventoryCache).sessions === "object"
	)
		return value as InventoryCache;
	return { version: CACHE_VERSION, sessions: {} };
}

function readJson(path: string): unknown {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
}
