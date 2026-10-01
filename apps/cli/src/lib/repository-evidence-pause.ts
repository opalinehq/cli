import { randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	openSync,
	readSync,
	renameSync,
	rmdirSync,
	rmSync,
	type Stats,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { ORPCError } from "@orpc/client";
import { tryWithConfigLockSync, withConfigLock } from "./config-lock.js";
import { getConfigDir } from "./local-state.js";

const MAX_MARKER_BYTES = 4_096;
const MAX_PAUSE_MS = 604_800_000;
const PAUSE_LOCK_WAIT_MS = 2_000;

export function readRepositoryEvidencePauseUntil(
	configDir = getConfigDir(),
	now = Date.now(),
): number | undefined {
	// A pause writer holds the config lock between its read and its rename.
	// Remove a stale marker only under that lock, so that the reader cannot
	// delete a marker that a writer published after this read.
	return readPauseMarker(configDir, now, (remove) => {
		tryWithConfigLockSync(configDir, remove);
	});
}

function readPauseMarker(
	configDir: string,
	now: number,
	withLock: (remove: () => void) => void,
): number | undefined {
	const path = join(configDir, "repository-evidence-pause.json");
	let markerStat: Stats | undefined;
	let descriptor: number | undefined;
	try {
		markerStat = lstatSync(path);
		if (!markerStat.isFile() || markerStat.size > MAX_MARKER_BYTES)
			return undefined;
		descriptor = openSync(
			path,
			constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
		);
		const openedStat = fstatSync(descriptor);
		if (
			!openedStat.isFile() ||
			openedStat.size > MAX_MARKER_BYTES ||
			openedStat.dev !== markerStat.dev ||
			openedStat.ino !== markerStat.ino
		)
			return undefined;
		const bytes = Buffer.alloc(MAX_MARKER_BYTES + 1);
		let size = 0;
		while (size < bytes.length) {
			const count = readSync(
				descriptor,
				bytes,
				size,
				bytes.length - size,
				size,
			);
			if (count === 0) break;
			size += count;
		}
		if (size > MAX_MARKER_BYTES) return undefined;
		const marker: unknown = JSON.parse(
			bytes.subarray(0, size).toString("utf8"),
		);
		if (
			typeof marker === "object" &&
			marker !== null &&
			"until" in marker &&
			typeof marker.until === "number" &&
			Number.isSafeInteger(marker.until) &&
			marker.until > now &&
			marker.until <= now + MAX_PAUSE_MS
		) {
			markerStat = undefined;
			return marker.until;
		}
	} catch {
	} finally {
		if (descriptor !== undefined) {
			try {
				closeSync(descriptor);
			} catch {}
		}
		const stale = markerStat;
		if (stale) {
			try {
				withLock(() => {
					const current = lstatSync(path);
					if (current.dev === stale.dev && current.ino === stale.ino) {
						if (current.isDirectory()) rmdirSync(path);
						else rmSync(path, { force: true });
					}
				});
			} catch {}
		}
	}
	return undefined;
}

export function isEvidenceCaptureDisabledError(
	error: unknown,
): error is ORPCError<string, unknown> {
	return (
		error instanceof ORPCError && error.code === "EVIDENCE_CAPTURE_DISABLED"
	);
}

export async function pauseRepositoryEvidenceCapture(
	error: ORPCError<string, unknown>,
	configDir = getConfigDir(),
	now?: number,
): Promise<void> {
	const data = error.data;
	const value =
		typeof data === "object" && data !== null && "pauseSeconds" in data
			? data.pauseSeconds
			: undefined;
	const seconds =
		typeof value === "number" && Number.isFinite(value)
			? Math.min(604_800, Math.max(3_600, Math.floor(value)))
			: 86_400;
	await withConfigLock(
		configDir,
		async () => {
			const observedNow = now ?? Date.now();
			const until = Math.max(
				observedNow + seconds * 1_000,
				readPauseMarker(configDir, observedNow, (remove) => remove()) ?? 0,
			);
			const path = join(configDir, "repository-evidence-pause.json");
			const temporary = `${path}.${randomUUID()}.tmp`;
			try {
				writeFileSync(temporary, `${JSON.stringify({ until })}\n`, {
					flag: "wx",
					mode: 0o600,
				});
				renameSync(temporary, path);
			} finally {
				rmSync(temporary, { force: true });
			}
		},
		{ waitMs: PAUSE_LOCK_WAIT_MS },
	);
}
