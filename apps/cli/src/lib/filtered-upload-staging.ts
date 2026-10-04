import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { IngestSessionInput } from "../contracts/index.js";
import type { FileBackedUploadRequest } from "../internal/agent-adapters/index.js";
import {
	FILTER_VERSION,
	filterSessionTextFields,
	mergeRedactionCounts,
	type RedactionCounts,
} from "../internal/secret-filter/index.js";
import type { R2IngestMetadata } from "./r2-ingest-contract.js";
import {
	cleanupOwnedR2StagingDirectory,
	createOwnedR2StagingDirectory,
	R2_UPLOAD_STAGING_DIRECTORY_PREFIX,
} from "./r2-staging-cleanup.js";
import {
	createTranscriptSlimmer,
	slimTranscriptText,
	type TranscriptSlimmer,
} from "./transcript-slim.js";

export const MAX_STREAM_RECORD_BYTES = 16 * 1024 * 1024;
/**
 * A raw record read for slimming may be larger: the 16 MiB record limit
 * applies to the slimmed record (an inline screenshot shrinks to a marker).
 * This bound only keeps the read buffer finite.
 */
export const MAX_SLIMMABLE_RECORD_BYTES = 128 * 1024 * 1024;

/*
 * Order: secret filter first, then slimming, per record. This is the order
 * 0.11 and the API produce (the API slims the already filtered upload), so
 * every CLI version and the API derive the same bytes from one transcript.
 * Slimming first would differ where a secret rule matches inside image base64
 * (for example SK + 32 hex): filtering first breaks that base64 and the image
 * stays inline everywhere.
 */
/**
 * Raw transcript files above this size are skipped without reading them. The
 * per-session ingest limit applies to the slimmed, filtered upload instead,
 * so a raw transcript well above it can still fit once images and duplicate
 * output are gone.
 */
export const MAX_RAW_TRANSCRIPT_BYTES = 1024 * 1024 * 1024;

export type TranscriptSource =
	| { readonly content: string; readonly kind: "text" }
	| { readonly kind: "file"; readonly path: string };

export interface FilteredUploadSubagentSource {
	readonly agentId: string;
	readonly source: TranscriptSource;
}

export interface FilteredUploadSources {
	readonly main: TranscriptSource;
	readonly metadata: R2IngestMetadata;
	/** Session uploads are slimmed; repository evidence keeps its exact bytes. */
	readonly slim: boolean;
	readonly subagents: readonly FilteredUploadSubagentSource[];
}

interface StagedUploadObjectBase {
	readonly byteLength: number;
	readonly path: string;
	readonly sha256: string;
}

export type StagedUploadObject =
	| (StagedUploadObjectBase & { readonly kind: "main" })
	| (StagedUploadObjectBase & {
			readonly agentId: string;
			readonly kind: "subagent";
	  });

export interface StagedFilteredUpload {
	readonly aggregateBytes: number;
	readonly directory: string;
	/**
	 * Filtered bytes before slimming. Slimming changed the session when
	 * `aggregateBytes` is smaller. The secret filter runs over the raw
	 * `inputBytes` (its redaction-budget base), as in 0.11 and on the server.
	 */
	readonly unslimmedBytes: number;
	readonly inputBytes: number;
	readonly metadata: R2IngestMetadata;
	readonly objects: readonly StagedUploadObject[];
	readonly redactedBytes: number;
	readonly redactions: RedactionCounts;
}

interface FilteredFileResult {
	readonly byteLength: number;
	readonly unslimmedBytes: number;
	readonly inputBytes: number;
	readonly redactedBytes: number;
	readonly redactions: RedactionCounts;
	readonly sha256: string;
}

export interface FilteredUploadBudget {
	readonly deadlineAt: number;
	readonly maxInputBytes: number;
	readonly maxSources?: number;
	readonly includeEmptySubagents?: boolean;
}

interface SourceBudget {
	readonly limits: FilteredUploadBudget;
	inputBytes: number;
}

function checkBudget(budget: SourceBudget | undefined): void {
	if (!budget) return;
	if (Date.now() >= budget.limits.deadlineAt)
		throw new Error("Transcript capture exceeded its time budget.");
	if (budget.inputBytes > budget.limits.maxInputBytes)
		throw new Error("Transcript capture exceeded its input budget.");
}

export function createFilteredUploadSources(
	request: IngestSessionInput | FileBackedUploadRequest,
	options: { readonly slim: boolean },
): FilteredUploadSources {
	if (isFileBackedUploadRequest(request)) {
		return {
			main: { kind: "file", path: request.transcriptPath },
			metadata: { ...request.metadata, filter_version: FILTER_VERSION },
			slim: options.slim,
			subagents: request.subagents.map((subagent) => ({
				agentId: subagent.agentId,
				source: { kind: "file", path: subagent.path },
			})),
		};
	}
	const { content, subagents, ...metadata } = request;
	return {
		main: { content, kind: "text" },
		metadata: { ...metadata, filter_version: FILTER_VERSION },
		slim: options.slim,
		subagents: (subagents ?? []).map((subagent) => ({
			agentId: subagent.agentId,
			source: { content: subagent.content, kind: "text" },
		})),
	};
}

export async function stageFilteredUpload(
	sources: FilteredUploadSources,
	limits?: FilteredUploadBudget,
): Promise<StagedFilteredUpload> {
	const budget = limits ? { limits, inputBytes: 0 } : undefined;
	checkBudget(budget);
	if (limits && sources.subagents.length + 1 > (limits.maxSources ?? 256))
		throw new Error("Transcript capture exceeded its source-count budget.");
	if (budget) {
		for (const source of [
			sources.main,
			...sources.subagents.map((child) => child.source),
		]) {
			checkBudget(budget);
			budget.inputBytes +=
				source.kind === "text"
					? Buffer.byteLength(source.content, "utf8")
					: (await stat(source.path)).size;
			checkBudget(budget);
		}
		budget.inputBytes = 0;
	}
	const directory = await createOwnedR2StagingDirectory(
		R2_UPLOAD_STAGING_DIRECTORY_PREFIX,
	);
	try {
		return await stageSourcesIntoDirectory(sources, directory, budget);
	} catch (error) {
		await cleanupOwnedR2StagingDirectory(directory);
		throw error;
	}
}

export async function cleanupStagedUpload(
	staged: StagedFilteredUpload,
): Promise<void> {
	await cleanupOwnedR2StagingDirectory(staged.directory);
}

async function stageSourcesIntoDirectory(
	sources: FilteredUploadSources,
	directory: string,
	budget: SourceBudget | undefined,
): Promise<StagedFilteredUpload> {
	const main = await stageSource(
		sources.main,
		join(directory, "main.jsonl"),
		sources.slim,
		budget,
	);
	const objects: StagedUploadObject[] = [
		{
			byteLength: main.byteLength,
			kind: "main",
			path: join(directory, "main.jsonl"),
			sha256: main.sha256,
		},
	];
	let aggregateBytes = main.byteLength;
	let unslimmedBytes = main.unslimmedBytes;
	let inputBytes = main.inputBytes;
	let redactedBytes = main.redactedBytes;
	let redactions = main.redactions;
	const sortedSubagents = [...sources.subagents].sort((left, right) =>
		left.agentId.localeCompare(right.agentId),
	);

	for (const [index, subagent] of sortedSubagents.entries()) {
		const path = join(directory, `subagent-${index + 1}.jsonl`);
		const result = await stageSource(
			subagent.source,
			path,
			sources.slim,
			budget,
		);
		aggregateBytes += result.byteLength;
		unslimmedBytes += result.unslimmedBytes;
		inputBytes += result.inputBytes;
		redactedBytes += result.redactedBytes;
		redactions = mergeRedactionCounts(redactions, result.redactions);
		if (result.byteLength === 0 && !budget?.limits.includeEmptySubagents)
			continue;
		objects.push({
			agentId: subagent.agentId,
			byteLength: result.byteLength,
			kind: "subagent",
			path,
			sha256: result.sha256,
		});
	}

	checkBudget(budget);
	return {
		aggregateBytes,
		directory,
		unslimmedBytes,
		inputBytes,
		metadata: sources.metadata,
		objects,
		redactedBytes,
		redactions,
	};
}

async function stageSource(
	source: TranscriptSource,
	destinationPath: string,
	slim: boolean,
	budget: SourceBudget | undefined,
): Promise<FilteredFileResult> {
	checkBudget(budget);
	return source.kind === "text"
		? stageText(source.content, destinationPath, slim, budget)
		: stageFile(
				source.path,
				destinationPath,
				slim ? createTranscriptSlimmer() : undefined,
				budget,
			);
}

async function stageText(
	content: string,
	destinationPath: string,
	slim: boolean,
	budget: SourceBudget | undefined,
): Promise<FilteredFileResult> {
	if (budget) budget.inputBytes += Buffer.byteLength(content, "utf8");
	checkBudget(budget);
	const filtered = filterSessionTextFields({
		content,
		subagents: undefined,
	});
	const output = slim ? slimTranscriptText(filtered.content) : filtered.content;
	checkBudget(budget);
	const byteLength = Buffer.byteLength(output, "utf8");
	await writeFile(destinationPath, output, {
		encoding: "utf8",
		flag: "wx",
		mode: 0o600,
	});
	return {
		byteLength,
		unslimmedBytes: Buffer.byteLength(filtered.content, "utf8"),
		inputBytes: Buffer.byteLength(content, "utf8"),
		redactedBytes: filtered.redactedBytes,
		redactions: filtered.counts,
		sha256: createHash("sha256").update(output, "utf8").digest("hex"),
	};
}

async function stageFile(
	sourcePath: string,
	destinationPath: string,
	slimmer: TranscriptSlimmer | undefined,
	budget: SourceBudget | undefined,
): Promise<FilteredFileResult> {
	const input = createReadStream(sourcePath, {
		highWaterMark: 64 * 1024,
		signal: budget
			? AbortSignal.timeout(Math.max(1, budget.limits.deadlineAt - Date.now()))
			: undefined,
	});
	const output = await open(destinationPath, "wx", 0o600);
	const decoder = new StringDecoder("utf8");
	const hash = createHash("sha256");
	let pending = "";
	let byteLength = 0;
	let unslimmedBytes = 0;
	let inputBytes = 0;
	let redactedBytes = 0;
	let redactions: RedactionCounts = {};

	const rawRecordLimit = slimmer
		? MAX_SLIMMABLE_RECORD_BYTES
		: MAX_STREAM_RECORD_BYTES;
	try {
		for await (const chunk of input) {
			if (!(chunk instanceof Uint8Array)) {
				throw new Error("Transcript stream produced a non-binary chunk");
			}
			inputBytes += chunk.byteLength;
			if (budget) budget.inputBytes += chunk.byteLength;
			checkBudget(budget);
			pending += decoder.write(chunk);
			let newlineIndex = pending.indexOf("\n");
			while (newlineIndex >= 0) {
				checkBudget(budget);
				const record = pending.slice(0, newlineIndex + 1);
				pending = pending.slice(newlineIndex + 1);
				assertRecordWithinLimit(record, rawRecordLimit);
				const result = await filterSlimAndWriteRecord(
					record,
					slimmer,
					output,
					hash,
				);
				byteLength += result.byteLength;
				unslimmedBytes += result.unslimmedBytes;
				redactedBytes += result.redactedBytes;
				redactions = mergeRedactionCounts(redactions, result.redactions);
				newlineIndex = pending.indexOf("\n");
			}
			assertRecordWithinLimit(pending, rawRecordLimit);
		}

		pending += decoder.end();
		checkBudget(budget);
		if (pending.length > 0) {
			assertRecordWithinLimit(pending, rawRecordLimit);
			const result = await filterSlimAndWriteRecord(
				pending,
				slimmer,
				output,
				hash,
			);
			byteLength += result.byteLength;
			unslimmedBytes += result.unslimmedBytes;
			redactedBytes += result.redactedBytes;
			redactions = mergeRedactionCounts(redactions, result.redactions);
		}
	} finally {
		input.destroy();
		await output.close();
	}

	return {
		byteLength,
		unslimmedBytes,
		inputBytes,
		redactedBytes,
		redactions,
		sha256: hash.digest("hex"),
	};
}

/**
 * Filters one raw record, slims the filtered record, and writes it. The
 * 16 MiB record limit applies to what is written (the slimmed record).
 */
async function filterSlimAndWriteRecord(
	record: string,
	slimmer: TranscriptSlimmer | undefined,
	output: Awaited<ReturnType<typeof open>>,
	hash: ReturnType<typeof createHash>,
): Promise<{
	readonly byteLength: number;
	readonly unslimmedBytes: number;
	readonly redactedBytes: number;
	readonly redactions: RedactionCounts;
}> {
	const filtered = filterSessionTextFields({
		content: record,
		subagents: undefined,
	});
	const written = slimmer
		? slimmer.slimRecord(filtered.content)
		: filtered.content;
	assertRecordWithinLimit(written, MAX_STREAM_RECORD_BYTES);
	await output.writeFile(written, { encoding: "utf8" });
	hash.update(written, "utf8");
	return {
		byteLength: Buffer.byteLength(written, "utf8"),
		unslimmedBytes: Buffer.byteLength(filtered.content, "utf8"),
		redactedBytes: filtered.redactedBytes,
		redactions: filtered.counts,
	};
}

function assertRecordWithinLimit(record: string, limit: number): void {
	// UTF-8 needs at least one byte per UTF-16 code unit: most records are
	// decided without encoding them.
	if (record.length <= limit / 3) return;
	const bytes = Buffer.byteLength(record, "utf8");
	if (bytes > limit) {
		throw new Error(
			`Transcript contains a record larger than ${limit} bytes; refusing an unbounded secret-filter buffer`,
		);
	}
}

function isFileBackedUploadRequest(
	request: IngestSessionInput | FileBackedUploadRequest,
): request is FileBackedUploadRequest {
	return "kind" in request && request.kind === "file";
}
