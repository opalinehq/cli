import { randomUUID } from "node:crypto";
import {
	lstatSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { withConfigLock } from "./config-lock.js";

const MAX_PAUSE_FILE_BYTES = 64 * 1024;
const MIN_PAUSE_SECONDS = 60;
const MAX_PAUSE_SECONDS = 604_800;
const MAX_PAUSED_WORKSPACES = 256;

/** `{ global?: untilMs, workspaces?: { [organizationId]: untilMs } }` */
interface LiveSessionPause {
	readonly global?: number;
	readonly workspaces?: Readonly<Record<string, number>>;
}

export function getLiveSessionsDirectory(configDir: string): string {
	return join(configDir, "live-sessions");
}

function getPausePath(configDir: string): string {
	return join(getLiveSessionsDirectory(configDir), "paused.json");
}

/**
 * Whether the server paused live session updates for every workspace or for
 * this one. Unreadable, oversized or malformed files count as no pause.
 */
export function isLiveSessionPaused(
	configDir: string,
	organizationId: string,
	now = Date.now(),
): boolean {
	const pause = readPause(configDir, now);
	return (
		(pause.global ?? 0) > now || (pause.workspaces?.[organizationId] ?? 0) > now
	);
}

/**
 * Records a `LIVE_SESSIONS_DISABLED` answer. Pauses only ever extend; expired
 * entries are dropped.
 */
export async function pauseLiveSessions(
	configDir: string,
	organizationId: string,
	scope: "global" | "workspace",
	pauseSeconds: number,
): Promise<void> {
	const seconds = Number.isFinite(pauseSeconds)
		? Math.min(
				MAX_PAUSE_SECONDS,
				Math.max(MIN_PAUSE_SECONDS, Math.floor(pauseSeconds)),
			)
		: 3_600;
	await mkdir(getLiveSessionsDirectory(configDir), {
		mode: 0o700,
		recursive: true,
	});
	await withConfigLock(configDir, async () => {
		const now = Date.now();
		const until = now + seconds * 1_000;
		const current = readPause(configDir, now);
		const workspaces: Record<string, number> = { ...current.workspaces };
		let global = current.global;
		if (scope === "global") global = Math.max(global ?? 0, until);
		else
			workspaces[organizationId] = Math.max(
				workspaces[organizationId] ?? 0,
				until,
			);
		const next: LiveSessionPause = {
			...(global === undefined ? {} : { global }),
			...(Object.keys(workspaces).length === 0 ? {} : { workspaces }),
		};
		const path = getPausePath(configDir);
		const temporary = `${path}.${randomUUID()}.tmp`;
		try {
			writeFileSync(temporary, `${JSON.stringify(next)}\n`, {
				flag: "wx",
				mode: 0o600,
			});
			renameSync(temporary, path);
		} finally {
			rmSync(temporary, { force: true });
		}
	});
}

function readPause(configDir: string, now: number): LiveSessionPause {
	const path = getPausePath(configDir);
	let value: unknown;
	try {
		const stat = lstatSync(path);
		if (!stat.isFile() || stat.size > MAX_PAUSE_FILE_BYTES) return {};
		value = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return {};
	}
	if (typeof value !== "object" || value === null) return {};
	const maxUntil = now + MAX_PAUSE_SECONDS * 1_000;
	const isActive = (until: unknown): until is number =>
		typeof until === "number" &&
		Number.isSafeInteger(until) &&
		until > now &&
		until <= maxUntil;
	const record = value as { global?: unknown; workspaces?: unknown };
	const workspaces: Record<string, number> = {};
	if (typeof record.workspaces === "object" && record.workspaces !== null) {
		for (const [organizationId, until] of Object.entries(record.workspaces)) {
			if (Object.keys(workspaces).length >= MAX_PAUSED_WORKSPACES) break;
			if (isActive(until)) workspaces[organizationId] = until;
		}
	}
	return {
		...(isActive(record.global) ? { global: record.global } : {}),
		...(Object.keys(workspaces).length === 0 ? {} : { workspaces }),
	};
}
