import { randomUUID } from "node:crypto";
import {
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { ORPCError } from "@orpc/client";
import { getConfigDir } from "./local-state.js";

export function readRepositoryEvidencePauseUntil(
	configDir = getConfigDir(),
	now = Date.now(),
): number | undefined {
	try {
		const marker: unknown = JSON.parse(
			readFileSync(join(configDir, "repository-evidence-pause.json"), "utf8"),
		);
		if (
			typeof marker === "object" &&
			marker !== null &&
			"until" in marker &&
			typeof marker.until === "number" &&
			Number.isFinite(marker.until) &&
			marker.until > now
		)
			return marker.until;
	} catch {}
	return undefined;
}

export function isEvidenceCaptureDisabledError(
	error: unknown,
): error is ORPCError<string, unknown> {
	return (
		error instanceof ORPCError && error.code === "EVIDENCE_CAPTURE_DISABLED"
	);
}

export function pauseRepositoryEvidenceCapture(
	error: ORPCError<string, unknown>,
	configDir = getConfigDir(),
	now = Date.now(),
): void {
	const data = error.data;
	const value =
		typeof data === "object" && data !== null && "pauseSeconds" in data
			? data.pauseSeconds
			: undefined;
	const seconds =
		typeof value === "number" && Number.isFinite(value)
			? Math.min(604_800, Math.max(3_600, Math.floor(value)))
			: 86_400;
	const until = Math.max(
		now + seconds * 1_000,
		readRepositoryEvidencePauseUntil(configDir, now) ?? 0,
	);
	mkdirSync(configDir, { recursive: true, mode: 0o700 });
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
}
