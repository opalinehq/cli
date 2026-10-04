import { randomUUID } from "node:crypto";
import { readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { SourceSchema } from "../contracts/index.js";
import { getConfigDir, writePrivateFile } from "./local-state.js";
import { withDirectoryLock } from "./transcript-revision-store.js";

/**
 * Durable "this chat belongs to an Opaline analysis" markers. `opaline import
 * --analysis` records one before the agent writes its final answer; the
 * agent's turn-complete / session-end hook then uploads the conversation with
 * the analysis id, so the final answer and later follow-ups are included.
 *
 * Hooks of several agents run as separate processes, so every change is a
 * read-modify-rename under one cross-process lock.
 */

export const ANALYSIS_MARKER_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_MARKERS = 50;
const MAX_MEMBERS = 80;
const LOCK_TIMEOUT_MS = 10_000;

const FingerprintSchema = z.object({
	mtimeMs: z.number(),
	size: z.number().int().nonnegative(),
});

const AnalysisDestinationSchema = z.object({
	/** Account the import was approved for: user id, else key id, else key hash. */
	account: z.string().min(1).max(200),
	/** RPC endpoint the import preflighted and uploaded to. */
	endpoint: z.string().min(1).max(2_000),
});

const AnalysisMarkerSchema = z.object({
	analysisId: z.string().min(1).max(200),
	createdAt: z.string(),
	destination: AnalysisDestinationSchema,
	expiresAt: z.string(),
	/** Unique per import, so a replaced marker never receives stale updates. */
	markerId: z.string().min(1).max(100),
	/** Session or thread ids covered: the marked one plus related threads. */
	memberIds: z.array(z.string().min(1).max(200)).max(MAX_MEMBERS),
	/** Whether related Codex threads belong to the upload (`--no-related`). */
	related: z.boolean(),
	/** The id passed to `opaline import`; related threads resolve from it. */
	sessionId: z.string().min(1).max(200),
	source: SourceSchema,
	/** Transcript fingerprints at the last linked upload, by member id. */
	uploaded: z.record(z.string(), FingerprintSchema),
});

const AnalysisMarkersFileSchema = z.object({
	markers: z.array(AnalysisMarkerSchema),
	version: z.literal(2),
});

export type AnalysisMarker = z.infer<typeof AnalysisMarkerSchema>;
export type AnalysisDestination = z.infer<typeof AnalysisDestinationSchema>;
export type TranscriptFingerprint = z.infer<typeof FingerprintSchema>;

export async function recordAnalysisMarker(
	input: {
		readonly analysisId: string;
		readonly destination: AnalysisDestination;
		readonly memberIds: readonly string[];
		readonly related: boolean;
		readonly sessionId: string;
		readonly source: AnalysisMarker["source"];
	},
	now: Date = new Date(),
): Promise<AnalysisMarker> {
	const marker: AnalysisMarker = {
		analysisId: input.analysisId,
		createdAt: now.toISOString(),
		destination: input.destination,
		expiresAt: new Date(now.getTime() + ANALYSIS_MARKER_TTL_MS).toISOString(),
		markerId: randomUUID(),
		memberIds: unique([input.sessionId, ...input.memberIds]).slice(
			0,
			MAX_MEMBERS,
		),
		related: input.related,
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

/**
 * Merge newly resolved members and upload fingerprints into the same marker.
 * A marker that was removed or replaced meanwhile is left alone.
 */
export async function updateAnalysisMarker(
	marker: Pick<AnalysisMarker, "markerId">,
	update: {
		readonly memberIds?: readonly string[];
		readonly uploaded?: Readonly<Record<string, TranscriptFingerprint>>;
	},
	now: Date = new Date(),
): Promise<void> {
	await mutateMarkers(now, (markers) =>
		markers.map((existing) =>
			existing.markerId === marker.markerId
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

/** Remove one marker, or every marker of a chat when no id is known. */
export async function removeAnalysisMarker(
	marker:
		| Pick<AnalysisMarker, "markerId">
		| Pick<AnalysisMarker, "sessionId" | "source">,
	now: Date = new Date(),
): Promise<void> {
	await mutateMarkers(now, (markers) =>
		markers.filter((existing) =>
			"markerId" in marker
				? existing.markerId !== marker.markerId
				: existing.source !== marker.source ||
					existing.sessionId !== marker.sessionId,
		),
	);
}

/** Drop markers that link this session to this analysis (link not confirmed). */
export async function invalidateAnalysisMarkers(
	analysisId: string,
	sessionId: string,
	now: Date = new Date(),
): Promise<void> {
	await mutateMarkers(now, (markers) =>
		markers.filter(
			(existing) =>
				existing.analysisId !== analysisId ||
				!existing.memberIds.includes(sessionId),
		),
	);
}

async function mutateMarkers(
	now: Date,
	operation: (markers: AnalysisMarker[]) => AnalysisMarker[],
): Promise<void> {
	const configDir = getConfigDir();
	await withDirectoryLock(
		join(configDir, "analysis-markers.lock"),
		LOCK_TIMEOUT_MS,
		async () => {
			const live = (await readMarkers()).filter((marker) =>
				isLive(marker, now),
			);
			const next = operation(live)
				.sort((left, right) => left.createdAt.localeCompare(right.createdAt))
				.slice(-MAX_MARKERS);
			await writeMarkers(next);
		},
	);
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

// Publish whole files by rename so a lock-free reader never sees a torn file.
async function writeMarkers(markers: readonly AnalysisMarker[]): Promise<void> {
	const configDir = getConfigDir();
	const path = getMarkersPath();
	const temporary = `${path}.${process.pid}-${randomUUID()}.tmp`;
	try {
		await writePrivateFile(
			temporary,
			JSON.stringify({ markers, version: 2 }, null, 2),
			configDir,
		);
		await rename(temporary, path);
	} finally {
		await rm(temporary, { force: true });
	}
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
