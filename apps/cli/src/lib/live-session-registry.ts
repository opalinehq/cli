import { createHash, randomUUID } from "node:crypto";
import {
	lstat,
	mkdir,
	readdir,
	readFile,
	rename,
	rm,
	unlink,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { getLiveSessionsDirectory } from "./live-session-pause.js";
import { isValidPid } from "./process-identity.js";

/**
 * Hooks register running sessions here; the machine-wide follower reads the
 * registrations every tick. One file per (session, agent process):
 * `<sha256("<source>:<sessionId>")>-<agentPid or 0>.json`.
 */
export type LiveSessionSource = "claude_code" | "codex";

/**
 * How the agent process was found: Claude Code's `CLAUDE_PID` (`env`), the
 * hook's parent (`parent`), the nearest `codex` ancestor of the notify
 * process (`ancestor`), not at all (`none`, ended by idleness), or already
 * gone when the hook ran (`exited`, ended right away).
 */
export type AgentPidSource = "env" | "parent" | "ancestor" | "none" | "exited";

export interface LiveSessionRegistration {
	readonly version: 1;
	readonly source: LiveSessionSource;
	readonly sessionId: string;
	readonly transcriptPath: string;
	readonly cwd: string;
	readonly organizationId: string;
	readonly agentPid: number | null;
	readonly agentPidSource: AgentPidSource;
	readonly agentStartIdentity: string | null;
	/** Claude Code's SessionStart `source` (`startup`, `resume`, ...). */
	readonly hookSource?: string;
	/** When the hook registered (ms since epoch). */
	readonly startedAt: number;
}

export interface StoredLiveSessionRegistration extends LiveSessionRegistration {
	readonly file: string;
}

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,200}$/u;
const FILE_PATTERN = /^[0-9a-f]{64}-\d{1,10}\.json$/u;
const MAX_REGISTRATION_BYTES = 16 * 1024;
export const MAX_REGISTRATIONS = 1_024;

export function getLiveSessionRegistrationsDirectory(
	configDir: string,
): string {
	return join(getLiveSessionsDirectory(configDir), "sessions");
}

export function getLiveSessionKey(
	source: LiveSessionSource,
	sessionId: string,
): string {
	return `${source}:${sessionId}`;
}

function registrationFileName(registration: LiveSessionRegistration): string {
	const hash = createHash("sha256")
		.update(getLiveSessionKey(registration.source, registration.sessionId))
		.digest("hex");
	return `${hash}-${registration.agentPid ?? 0}.json`;
}

/**
 * Writes (atomically) a registration. With `onlyIfChanged`, an existing
 * registration that differs only in `startedAt` is left as it is, so
 * per-turn re-registration is a cheap no-op.
 */
export async function writeLiveSessionRegistration(
	configDir: string,
	registration: LiveSessionRegistration,
	options: { readonly onlyIfChanged?: boolean } = {},
): Promise<void> {
	if (!isValidRegistration(registration))
		throw new Error("Invalid live session registration");
	const directory = getLiveSessionRegistrationsDirectory(configDir);
	await mkdir(directory, { mode: 0o700, recursive: true });
	const path = join(directory, registrationFileName(registration));
	if (options.onlyIfChanged) {
		const current = await readRegistration(path);
		if (current && sameExceptStart(current, registration)) return;
	}
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporary, JSON.stringify(registration), {
			flag: "wx",
			mode: 0o600,
		});
		await rename(temporary, path);
	} finally {
		await rm(temporary, { force: true });
	}
}

/** Valid registrations; malformed files are removed. */
export async function listLiveSessionRegistrations(
	configDir: string,
): Promise<StoredLiveSessionRegistration[]> {
	const directory = getLiveSessionRegistrationsDirectory(configDir);
	let names: string[];
	try {
		names = await readdir(directory);
	} catch {
		return [];
	}
	const registrations: StoredLiveSessionRegistration[] = [];
	for (const name of names) {
		if (registrations.length >= MAX_REGISTRATIONS) break;
		if (!FILE_PATTERN.test(name)) continue;
		const path = join(directory, name);
		const registration = await readRegistration(path);
		if (!registration || registrationFileName(registration) !== name) {
			// Being written is impossible (writes rename into place): drop it.
			await unlink(path).catch(() => undefined);
			continue;
		}
		registrations.push({ ...registration, file: path });
	}
	return registrations;
}

/** Removes a registration unless a hook has rewritten it since it was read. */
export async function removeLiveSessionRegistration(
	registration: StoredLiveSessionRegistration,
): Promise<void> {
	const current = await readRegistration(registration.file);
	if (current && current.startedAt !== registration.startedAt) return;
	await unlink(registration.file).catch(() => undefined);
}

export async function removeAllLiveSessionRegistrations(
	configDir: string,
): Promise<void> {
	for (const registration of await listLiveSessionRegistrations(configDir))
		await removeLiveSessionRegistration(registration);
}

async function readRegistration(
	path: string,
): Promise<LiveSessionRegistration | null> {
	try {
		const metadata = await lstat(path);
		if (!metadata.isFile() || metadata.size > MAX_REGISTRATION_BYTES)
			return null;
		const value: unknown = JSON.parse(await readFile(path, "utf8"));
		return isValidRegistration(value) ? value : null;
	} catch {
		return null;
	}
}

function isValidRegistration(value: unknown): value is LiveSessionRegistration {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return (
		record.version === 1 &&
		(record.source === "claude_code" || record.source === "codex") &&
		typeof record.sessionId === "string" &&
		SESSION_ID_PATTERN.test(record.sessionId) &&
		isBoundedString(record.transcriptPath, 4096) &&
		isBoundedString(record.cwd, 4096) &&
		isBoundedString(record.organizationId, 200) &&
		(record.agentPid === null || isValidPid(record.agentPid)) &&
		(record.agentPidSource === "env" ||
			record.agentPidSource === "parent" ||
			record.agentPidSource === "ancestor" ||
			record.agentPidSource === "none" ||
			record.agentPidSource === "exited") &&
		(record.agentPid === null) ===
			(record.agentPidSource === "none" ||
				record.agentPidSource === "exited") &&
		(record.agentStartIdentity === null ||
			isBoundedString(record.agentStartIdentity, 200)) &&
		(record.hookSource === undefined ||
			isBoundedString(record.hookSource, 32)) &&
		typeof record.startedAt === "number" &&
		Number.isSafeInteger(record.startedAt) &&
		record.startedAt > 0
	);
}

function isBoundedString(value: unknown, max: number): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= max;
}

function sameExceptStart(
	left: LiveSessionRegistration,
	right: LiveSessionRegistration,
): boolean {
	return (
		JSON.stringify({ ...left, startedAt: 0 }) ===
		JSON.stringify({ ...right, startedAt: 0 })
	);
}
