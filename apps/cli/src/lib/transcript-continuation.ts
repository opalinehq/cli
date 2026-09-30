import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { REPOSITORY_EVIDENCE_MAX_AGGREGATE_BYTES } from "../contracts/index.js";
import {
	type PendingRepositoryEvidence,
	removePendingRepositoryEvidence,
	writePendingRepositoryEvidence,
} from "./repository-evidence-pending.js";
import { buildRepositoryEvidenceContinuation } from "./repository-evidence-upload.js";
import { planTranscriptRevisionFile } from "./transcript-revision.js";

const MAX_SOURCE_BYTES = 512 * 1024 * 1024;
const ENCODE_WINDOW_CHARS = 256 * 1024;

export async function persistTranscriptSource(
	content: string | { readonly path: string },
	configDir: string,
	deadlineAt?: number,
): Promise<string> {
	const directory = join(configDir, "repository-evidence-sources");
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const names = await readdir(directory);
	let used = 0;
	for (const name of names) used += (await stat(join(directory, name))).size;
	if (names.length >= 200)
		throw new Error("Transcript continuation source quota exceeded");
	const sourceId = randomUUID();
	const path = transcriptSourcePath(configDir, sourceId);
	const file = await open(path, "wx", 0o600);
	try {
		for await (const bytes of readTranscriptSource(content, deadlineAt)) {
			if (deadlineAt !== undefined && Date.now() >= deadlineAt)
				throw new Error("Transcript capture exceeded its time budget.");
			used += bytes.length;
			if (used > MAX_SOURCE_BYTES)
				throw new Error("Transcript continuation source quota exceeded");
			await file.writeFile(bytes);
		}
		await file.sync();
	} catch (error) {
		await rm(path, { force: true });
		throw error;
	} finally {
		await file.close();
	}
	return sourceId;
}

async function* readTranscriptSource(
	content: string | { readonly path: string },
	deadlineAt: number | undefined,
): AsyncGenerator<Uint8Array> {
	if (typeof content !== "string") {
		const stream = createReadStream(content.path, {
			highWaterMark: ENCODE_WINDOW_CHARS,
			signal:
				deadlineAt === undefined
					? undefined
					: AbortSignal.timeout(Math.max(1, deadlineAt - Date.now())),
		});
		for await (const bytes of stream) yield bytes;
		return;
	}
	for (let cursor = 0; cursor < content.length; ) {
		let end = Math.min(content.length, cursor + ENCODE_WINDOW_CHARS);
		const lastCode = content.charCodeAt(end - 1);
		if (end < content.length && lastCode >= 0xd800 && lastCode <= 0xdbff) end--;
		yield new TextEncoder().encode(content.slice(cursor, end));
		cursor = end;
	}
}

export async function continueAcceptedTranscript(
	pending: PendingRepositoryEvidence,
	configDir: string,
	maxDeliveryBytes?: number,
): Promise<void> {
	if (pending.continuation) {
		const contextBytes = [...pending.upload.objects.values()]
			.filter((object) => object.descriptor.kind !== "transcript-chunk")
			.reduce((sum, object) => sum + object.bytes.length, 0);
		const plan = await planTranscriptRevisionFile({
			path: transcriptSourcePath(configDir, pending.continuation.sourceId),
			previous: pending.transcriptRevision,
			limits: {
				maxDeliveryBytes:
					maxDeliveryBytes ??
					Math.max(
						0,
						REPOSITORY_EVIDENCE_MAX_AGGREGATE_BYTES -
							contextBytes -
							1024 * 1024,
					),
			},
			scope: pending.transcriptRevision.scope,
			terminal: pending.continuation.terminal,
		});
		if (
			plan.manifest.watermark.byteOffset >
			pending.transcriptRevision.watermark.byteOffset
		) {
			await writePendingRepositoryEvidence(
				{
					repositorySelection: pending.repositorySelection,
					endpoint: pending.endpoint,
					transcriptRevision: plan.manifest,
					upload: buildRepositoryEvidenceContinuation(pending.upload, plan),
					continuation: pending.continuation,
				},
				configDir,
			);
		} else if (plan.delivery.status === "blocked") {
			throw new Error(
				"Transcript continuation is blocked by a record larger than the delivery budget",
			);
		} else {
			await removePendingRepositoryEvidence(pending, configDir);
			await rm(transcriptSourcePath(configDir, pending.continuation.sourceId), {
				force: true,
			});
			return;
		}
	}
	await removePendingRepositoryEvidence(pending, configDir);
}

export function transcriptSourcePath(
	configDir: string,
	sourceId: string,
): string {
	if (!/^[0-9a-f-]{36}$/.test(sourceId))
		throw new Error("Invalid transcript source ID");
	return join(configDir, "repository-evidence-sources", `${sourceId}.jsonl`);
}
