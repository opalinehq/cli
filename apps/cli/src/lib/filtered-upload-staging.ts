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

export const MAX_STREAM_RECORD_BYTES = 16 * 1024 * 1024;

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
	readonly inputBytes: number;
	readonly metadata: R2IngestMetadata;
	readonly objects: readonly StagedUploadObject[];
	readonly redactedBytes: number;
	readonly redactions: RedactionCounts;
}

interface FilteredFileResult {
	readonly byteLength: number;
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
): FilteredUploadSources {
	if (isFileBackedUploadRequest(request)) {
		return {
			main: { kind: "file", path: request.transcriptPath },
			metadata: { ...request.metadata, filter_version: FILTER_VERSION },
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
	let inputBytes = main.inputBytes;
	let redactedBytes = main.redactedBytes;
	let redactions = main.redactions;
	const sortedSubagents = [...sources.subagents].sort((left, right) =>
		left.agentId.localeCompare(right.agentId),
	);

	for (const [index, subagent] of sortedSubagents.entries()) {
		const path = join(directory, `subagent-${index + 1}.jsonl`);
		const result = await stageSource(subagent.source, path, budget);
		aggregateBytes += result.byteLength;
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
	budget: SourceBudget | undefined,
): Promise<FilteredFileResult> {
	checkBudget(budget);
	return source.kind === "text"
		? stageText(source.content, destinationPath, budget)
		: stageFile(source.path, destinationPath, budget);
}

async function stageText(
	content: string,
	destinationPath: string,
	budget: SourceBudget | undefined,
): Promise<FilteredFileResult> {
	if (budget) budget.inputBytes += Buffer.byteLength(content, "utf8");
	checkBudget(budget);
	const filtered = filterSessionTextFields({ content, subagents: undefined });
	checkBudget(budget);
	const byteLength = Buffer.byteLength(filtered.content, "utf8");
	await writeFile(destinationPath, filtered.content, {
		encoding: "utf8",
		flag: "wx",
		mode: 0o600,
	});
	return {
		byteLength,
		inputBytes: Buffer.byteLength(content, "utf8"),
		redactedBytes: filtered.redactedBytes,
		redactions: filtered.counts,
		sha256: createHash("sha256").update(filtered.content, "utf8").digest("hex"),
	};
}

async function stageFile(
	sourcePath: string,
	destinationPath: string,
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
	let inputBytes = 0;
	let redactedBytes = 0;
	let redactions: RedactionCounts = {};

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
				assertRecordWithinLimit(record);
				const result = await filterAndWriteRecord(record, output, hash);
				byteLength += result.byteLength;
				redactedBytes += result.redactedBytes;
				redactions = mergeRedactionCounts(redactions, result.redactions);
				newlineIndex = pending.indexOf("\n");
			}
			assertRecordWithinLimit(pending);
		}

		pending += decoder.end();
		checkBudget(budget);
		if (pending.length > 0) {
			assertRecordWithinLimit(pending);
			const result = await filterAndWriteRecord(pending, output, hash);
			byteLength += result.byteLength;
			redactedBytes += result.redactedBytes;
			redactions = mergeRedactionCounts(redactions, result.redactions);
		}
	} finally {
		input.destroy();
		await output.close();
	}

	return {
		byteLength,
		inputBytes,
		redactedBytes,
		redactions,
		sha256: hash.digest("hex"),
	};
}

async function filterAndWriteRecord(
	record: string,
	output: Awaited<ReturnType<typeof open>>,
	hash: ReturnType<typeof createHash>,
): Promise<{
	readonly byteLength: number;
	readonly redactedBytes: number;
	readonly redactions: RedactionCounts;
}> {
	const filtered = filterSessionTextFields({
		content: record,
		subagents: undefined,
	});
	await output.writeFile(filtered.content, { encoding: "utf8" });
	hash.update(filtered.content, "utf8");
	return {
		byteLength: Buffer.byteLength(filtered.content, "utf8"),
		redactedBytes: filtered.redactedBytes,
		redactions: filtered.counts,
	};
}

function assertRecordWithinLimit(record: string): void {
	const bytes = Buffer.byteLength(record, "utf8");
	if (bytes > MAX_STREAM_RECORD_BYTES) {
		throw new Error(
			`Transcript contains a record larger than ${MAX_STREAM_RECORD_BYTES} bytes; refusing an unbounded secret-filter buffer`,
		);
	}
}

function isFileBackedUploadRequest(
	request: IngestSessionInput | FileBackedUploadRequest,
): request is FileBackedUploadRequest {
	return "kind" in request && request.kind === "file";
}
