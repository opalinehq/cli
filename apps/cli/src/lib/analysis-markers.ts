import { randomUUID } from "node:crypto";
import { readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { SourceSchema } from "../contracts/index.js";
import { getConfigDir, writePrivateFile } from "./local-state.js";

/**
 * Durable "this chat belongs to an Opaline analysis" markers. `opaline import
 * --analysis` records one before the agent writes its final answer; the
 * agent's turn-complete / session-end hook then uploads the conversation with
 * the analysis id, so the final answer and later follow-ups are included.
 */

export const ANALYSIS_MARKER_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_MARKERS = 50;
const MAX_MEMBERS = 80;

const FingerprintSchema = z.object({
	mtimeMs: z.number(),
	size: z.number().int().nonnegative(),
});

const AnalysisMarkerSchema = z.object({
	analysisId: z.string().min(1).max(200),
	createdAt: z.string(),
	expiresAt: z.string(),
	/** Session or thread ids covered: the marked one plus related threads. */
	memberIds: z.array(z.string().min(1).max(200)).max(MAX_MEMBERS),
	/** The id passed to `opaline import`; related threads resolve from it. */
	sessionId: z.string().min(1).max(200),
	source: SourceSchema,
	/** Transcript fingerprints at the last linked upload, by member id. */
	uploaded: z.record(z.string(), FingerprintSchema),
});

const AnalysisMarkersFileSchema = z.object({
	markers: z.array(AnalysisMarkerSchema),
	version: z.literal(1),
});

export type AnalysisMarker = z.infer<typeof AnalysisMarkerSchema>;
export type TranscriptFingerprint = z.infer<typeof FingerprintSchema>;

let mutationQueue: Promise<void> = Promise.resolve();

export async function recordAnalysisMarker(
	input: {
		readonly analysisId: string;
		readonly memberIds: readonly string[];
		readonly sessionId: string;
		readonly source: AnalysisMarker["source"];
	},
	now: Date = new Date(),
): Promise<AnalysisMarker> {
	const marker: AnalysisMarker = {
		analysisId: input.analysisId,
		createdAt: now.toISOString(),
		expiresAt: new Date(now.getTime() + ANALYSIS_MARKER_TTL_MS).toISOString(),
		memberIds: unique([input.sessionId, ...input.memberIds]).slice(
			0,
			MAX_MEMBERS,
		),
		sessionId: input.sessionId,
		source: input.source,
		uploaded: {},
	};
	await mutateMarkers(now, (markers) => [
		...markers.filter(
			(existing) =>
				existing.source !== marker.source ||
				existing.sessionId !== marker.sessionId,
		),
		marker,
	]);
	return marker;
}

/** The newest unexpired marker covering this session or thread id. */
export async function findAnalysisMarker(
	source: AnalysisMarker["source"],
	sessionId: string,
	now: Date = new Date(),
): Promise<AnalysisMarker | null> {
	const markers = (await readMarkers()).filter(
		(marker) =>
			marker.source === source &&
			isLive(marker, now) &&
			marker.memberIds.includes(sessionId),
	);
	return (
		markers.sort((left, right) =>
			right.createdAt.localeCompare(left.createdAt),
		)[0] ?? null
	);
}

/** Merge newly resolved members and upload fingerprints into a live marker. */
export async function updateAnalysisMarker(
	marker: Pick<AnalysisMarker, "sessionId" | "source">,
	update: {
		readonly memberIds?: readonly string[];
		readonly uploaded?: Readonly<Record<string, TranscriptFingerprint>>;
	},
	now: Date = new Date(),
): Promise<void> {
	await mutateMarkers(now, (markers) =>
		markers.map((existing) =>
			existing.source === marker.source &&
			existing.sessionId === marker.sessionId
				? {
						...existing,
						memberIds: unique([
							...existing.memberIds,
							...(update.memberIds ?? []),
						]).slice(0, MAX_MEMBERS),
						uploaded: { ...existing.uploaded, ...update.uploaded },
					}
				: existing,
		),
	);
}

export async function removeAnalysisMarker(
	marker: Pick<AnalysisMarker, "sessionId" | "source">,
	now: Date = new Date(),
): Promise<void> {
	await mutateMarkers(now, (markers) =>
		markers.filter(
			(existing) =>
				existing.source !== marker.source ||
				existing.sessionId !== marker.sessionId,
		),
	);
}

async function mutateMarkers(
	now: Date,
	operation: (markers: AnalysisMarker[]) => AnalysisMarker[],
): Promise<void> {
	const run = async () => {
		const live = (await readMarkers()).filter((marker) => isLive(marker, now));
		const next = operation(live)
			.sort((left, right) => left.createdAt.localeCompare(right.createdAt))
			.slice(-MAX_MARKERS);
		await writeMarkers(next);
	};
	const queued = mutationQueue.then(run, run);
	mutationQueue = queued.catch(() => {});
	await queued;
}

async function readMarkers(): Promise<AnalysisMarker[]> {
	try {
		const parsed = AnalysisMarkersFileSchema.safeParse(
			JSON.parse(await readFile(getMarkersPath(), "utf8")),
		);
		return parsed.success ? parsed.data.markers : [];
	} catch {
		return [];
	}
}

// Hooks of concurrent agents may write at once: publish whole files by rename
// so a reader never sees a torn document.
async function writeMarkers(markers: readonly AnalysisMarker[]): Promise<void> {
	const configDir = getConfigDir();
	const path = getMarkersPath();
	const temporary = `${path}.${process.pid}-${randomUUID()}.tmp`;
	await writePrivateFile(
		temporary,
		JSON.stringify({ markers, version: 1 }, null, 2),
		configDir,
	);
	await rename(temporary, path);
}

function getMarkersPath(): string {
	return join(getConfigDir(), "analysis-markers.json");
}

function isLive(marker: AnalysisMarker, now: Date): boolean {
	return Date.parse(marker.expiresAt) > now.getTime();
}

function unique(values: readonly string[]): string[] {
	return [...new Set(values)];
}
