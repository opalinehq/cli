import type { Source } from "../contracts/index.js";
import type { UploadTransferProgress } from "./types.js";

export interface SessionUploadDetail {
	sessionId: string;
	source: Source;
	sessionDate: number | undefined;
	status: "preparing" | UploadTransferProgress["phase"] | "retrying" | "failed";
	uploadedBytes: number | undefined;
	totalBytes: number | undefined;
	error?: string;
	failureStage?: "preparing" | "uploading" | "processing";
	attempt?: number;
	maxAttempts?: number;
}

export interface UploadSpeed {
	startedAt: number;
	samples: Array<{ at: number; bytes: number }>;
}

const SPEED_WINDOW_MS = 5_000;

/** Count transferred bytes, including retried parts, in a bounded rolling window. */
export function recordUploadBytes(
	speed: UploadSpeed,
	bytes: number,
	now: number,
): void {
	if (bytes <= 0) return;
	const bucket = Math.floor(now / 100) * 100;
	const last = speed.samples.at(-1);
	if (last?.at === bucket) last.bytes += bytes;
	else speed.samples.push({ at: bucket, bytes });
	while (speed.samples[0] && speed.samples[0].at < now - SPEED_WINDOW_MS)
		speed.samples.shift();
}

export function uploadBytesPerSecond(speed: UploadSpeed, now: number): number {
	const bytes = speed.samples.reduce(
		(sum, sample) =>
			sum + (sample.at > now - SPEED_WINDOW_MS ? sample.bytes : 0),
		0,
	);
	const seconds = Math.max(
		1,
		Math.min(SPEED_WINDOW_MS, now - speed.startedAt) / 1_000,
	);
	return bytes / seconds;
}

export function formatUploadBytes(bytes: number | undefined): string {
	if (bytes === undefined) return "—";
	if (bytes < 1_000) return `${Math.floor(bytes)} B`;
	if (bytes < 1_000_000) return `${(bytes / 1_000).toFixed(1)} kB`;
	if (bytes < 1_000_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
	return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
}
