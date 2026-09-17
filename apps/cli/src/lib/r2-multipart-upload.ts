import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { type FileHandle, open, stat } from "node:fs/promises";
import { join } from "node:path";
import type {
	R2IngestCompletedObject,
	R2IngestUploadObject,
	R2IngestUploadPart,
} from "./r2-ingest-contract.js";
import {
	cleanupOwnedR2StagingDirectory,
	createOwnedR2StagingDirectory,
	R2_PART_STAGING_DIRECTORY_PREFIX,
} from "./r2-staging-cleanup.js";

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 500;
const STREAM_CHUNK_BYTES = 64 * 1024;

export interface R2MultipartProgress {
	readonly attempt: number;
	readonly objectBytesUploaded: number;
	readonly objectKey: string;
	readonly partBytesUploaded: number;
	readonly partNumber: number;
	readonly totalObjectBytes: number;
	readonly totalPartBytes: number;
}

export interface R2MultipartRetry {
	readonly attempt: number;
	readonly error: string;
	readonly maxAttempts: number;
	readonly objectKey: string;
	readonly partNumber: number;
}

export interface R2MultipartUploadSource {
	readonly path: string;
	readonly upload: R2IngestUploadObject;
}

export interface R2MultipartUploadOptions {
	readonly baseDelayMs: number | undefined;
	readonly fetch: typeof globalThis.fetch | undefined;
	readonly maxAttempts: number | undefined;
	readonly onProgress: ((progress: R2MultipartProgress) => void) | undefined;
	readonly onRetry: ((retry: R2MultipartRetry) => void) | undefined;
	readonly sources: readonly R2MultipartUploadSource[];
}

export interface R2MultipartUploadResult {
	readonly attempts: number;
	readonly objects: readonly R2IngestCompletedObject[];
}

export interface FileDigest {
	readonly byteLength: number;
	readonly sha256: string;
}

export interface FilePartRange {
	readonly byteLength: number;
	readonly end: number;
	readonly partNumber: number;
	readonly start: number;
}

interface StreamingRequestInit extends RequestInit {
	readonly duplex: "half";
}

export class R2MultipartUploadError extends Error {
	readonly retryable: boolean;
	readonly status: number | undefined;

	constructor(
		message: string,
		options: {
			readonly retryable: boolean;
			readonly status: number | undefined;
		},
	) {
		super(message);
		this.name = "R2MultipartUploadError";
		this.retryable = options.retryable;
		this.status = options.status;
	}
}

export async function uploadR2MultipartObjects(
	options: R2MultipartUploadOptions,
): Promise<R2MultipartUploadResult> {
	const completedObjects: R2IngestCompletedObject[] = [];
	let attempts = 1;
	for (const source of options.sources) {
		const result = await uploadObject(source, options);
		attempts = Math.max(attempts, result.attempts);
		completedObjects.push(result.completed);
	}
	return { attempts, objects: completedObjects };
}

export async function inspectUploadFile(path: string): Promise<FileDigest> {
	const hash = createHash("sha256");
	let byteLength = 0;
	for await (const chunk of createReadStream(path, {
		highWaterMark: STREAM_CHUNK_BYTES,
	})) {
		if (!(chunk instanceof Uint8Array)) {
			throw new Error("Upload file stream produced a non-binary chunk");
		}
		hash.update(chunk);
		byteLength += chunk.byteLength;
	}
	return { byteLength, sha256: hash.digest("hex") };
}

export function buildFilePartRanges(
	byteLength: number,
	partSizeBytes: number,
): readonly FilePartRange[] {
	if (!Number.isSafeInteger(byteLength) || byteLength <= 0) {
		throw new Error("Upload byte length must be a positive safe integer");
	}
	if (!Number.isSafeInteger(partSizeBytes) || partSizeBytes <= 0) {
		throw new Error("Upload part size must be a positive safe integer");
	}
	const partCount = Math.ceil(byteLength / partSizeBytes);
	return Array.from({ length: partCount }, (_, index) => {
		const start = index * partSizeBytes;
		const partByteLength = Math.min(partSizeBytes, byteLength - start);
		return {
			byteLength: partByteLength,
			end: start + partByteLength - 1,
			partNumber: index + 1,
			start,
		};
	});
}

async function uploadObject(
	source: R2MultipartUploadSource,
	options: R2MultipartUploadOptions,
): Promise<{
	readonly attempts: number;
	readonly completed: R2IngestCompletedObject;
}> {
	await assertUploadObjectMatchesFile(source);
	assertUploadPartManifest(source.upload);
	const completedParts = [];
	let completedBytes = 0;
	let attempts = 1;
	for (const part of source.upload.parts) {
		const uploaded = await uploadPart({
			baseDelayMs: options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS,
			completedBytes,
			fetch: options.fetch ?? globalThis.fetch,
			maxAttempts: options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
			onProgress: options.onProgress,
			onRetry: options.onRetry,
			part,
			path: source.path,
			totalObjectBytes: source.upload.byteLength,
			objectKey: source.upload.objectKey,
		});
		attempts = Math.max(attempts, uploaded.attempts);
		completedBytes += part.byteLength;
		completedParts.push({ etag: uploaded.etag, partNumber: part.partNumber });
	}
	return {
		attempts,
		completed: {
			objectKey: source.upload.objectKey,
			parts: completedParts,
			uploadId: source.upload.uploadId,
		},
	};
}

async function uploadPart(input: {
	readonly baseDelayMs: number;
	readonly completedBytes: number;
	readonly fetch: typeof globalThis.fetch;
	readonly maxAttempts: number;
	readonly objectKey: string;
	readonly onProgress: ((progress: R2MultipartProgress) => void) | undefined;
	readonly onRetry: ((retry: R2MultipartRetry) => void) | undefined;
	readonly part: R2IngestUploadPart;
	readonly path: string;
	readonly totalObjectBytes: number;
}): Promise<{ readonly attempts: number; readonly etag: string }> {
	const start = input.completedBytes;
	for (let attempt = 1; attempt <= input.maxAttempts; attempt += 1) {
		try {
			const etag = await putFilePart({ ...input, attempt, start });
			return { attempts: attempt, etag };
		} catch (error) {
			const uploadError = toMultipartUploadError(error);
			if (!uploadError.retryable || attempt === input.maxAttempts) {
				throw uploadError;
			}
			input.onRetry?.({
				attempt,
				error: uploadError.message,
				maxAttempts: input.maxAttempts,
				objectKey: input.objectKey,
				partNumber: input.part.partNumber,
			});
			await delay(input.baseDelayMs * 2 ** (attempt - 1));
		}
	}
	throw new R2MultipartUploadError("Multipart part retries were exhausted", {
		retryable: true,
		status: undefined,
	});
}

async function putFilePart(input: {
	readonly attempt: number;
	readonly completedBytes: number;
	readonly fetch: typeof globalThis.fetch;
	readonly objectKey: string;
	readonly onProgress: ((progress: R2MultipartProgress) => void) | undefined;
	readonly part: R2IngestUploadPart;
	readonly path: string;
	readonly start: number;
	readonly totalObjectBytes: number;
}): Promise<string> {
	let partBytesUploaded = 0;
	const reportChunk = (chunkBytes: number) => {
		partBytesUploaded += chunkBytes;
		input.onProgress?.({
			attempt: input.attempt,
			objectBytesUploaded: input.completedBytes + partBytesUploaded,
			objectKey: input.objectKey,
			partBytesUploaded,
			partNumber: input.part.partNumber,
			totalObjectBytes: input.totalObjectBytes,
			totalPartBytes: input.part.byteLength,
		});
	};
	// Reset this part before a retry so callers can count retransmitted bytes
	// and show progress for the current attempt rather than the failed one.
	reportChunk(0);
	const body = await createFilePartBody(
		input.path,
		input.start,
		input.part.byteLength,
		reportChunk,
	);
	const request: StreamingRequestInit = {
		body: body.value,
		duplex: "half",
		headers: input.part.headers,
		method: "PUT",
	};
	let response: Response;
	try {
		response = await input.fetch(input.part.uploadUrl, request);
	} finally {
		await body.cleanup();
	}
	if (!body.reportsStreamingProgress) {
		reportChunk(input.part.byteLength);
	}
	if (!response.ok) {
		await response.body?.cancel();
		throw new R2MultipartUploadError(
			`R2 part upload failed with ${response.status} ${response.statusText}`,
			{
				retryable: isTransientHttpStatus(response.status),
				status: response.status,
			},
		);
	}
	const etag = response.headers.get("etag")?.trim();
	await response.body?.cancel();
	if (!etag) {
		throw new R2MultipartUploadError(
			"R2 part upload succeeded without an ETag response header",
			{ retryable: false, status: response.status },
		);
	}
	return etag;
}

async function createFilePartBody(
	path: string,
	start: number,
	byteLength: number,
	onChunk: (byteLength: number) => void,
): Promise<{
	readonly cleanup: () => Promise<void>;
	readonly reportsStreamingProgress: boolean;
	readonly value: NonNullable<RequestInit["body"]>;
}> {
	if (hasBunFileFactory()) {
		const materialized = await materializeFilePart(path, start, byteLength);
		const bunFile = getBunFile(materialized.path);
		if (!bunFile) {
			await materialized.cleanup();
			throw new Error("Bun.file did not return a Blob for an upload part");
		}
		return {
			cleanup: materialized.cleanup,
			reportsStreamingProgress: false,
			value: bunFile,
		};
	}
	return {
		cleanup: async () => {},
		reportsStreamingProgress: true,
		value: createFileRangeStream(path, start, byteLength, onChunk),
	};
}

function hasBunFileFactory(): boolean {
	const runtime: unknown = Reflect.get(globalThis, "Bun");
	return isRecord(runtime) && typeof runtime.file === "function";
}

function getBunFile(path: string): Blob | null {
	const runtime: unknown = Reflect.get(globalThis, "Bun");
	if (!isRecord(runtime)) return null;
	const fileFactory = runtime.file;
	if (typeof fileFactory !== "function") return null;
	const file: unknown = Reflect.apply(fileFactory, runtime, [path]);
	return file instanceof Blob ? file : null;
}

async function materializeFilePart(
	path: string,
	start: number,
	byteLength: number,
): Promise<{ readonly cleanup: () => Promise<void>; readonly path: string }> {
	const directory = await createOwnedR2StagingDirectory(
		R2_PART_STAGING_DIRECTORY_PREFIX,
	);
	const partPath = join(directory, "part.bin");
	let source: FileHandle | undefined;
	let destination: FileHandle | undefined;
	try {
		source = await open(path, "r");
		destination = await open(partPath, "wx", 0o600);
		let copiedBytes = 0;
		while (copiedBytes < byteLength) {
			const buffer = Buffer.allocUnsafe(
				Math.min(STREAM_CHUNK_BYTES, byteLength - copiedBytes),
			);
			const { bytesRead } = await source.read(
				buffer,
				0,
				buffer.byteLength,
				start + copiedBytes,
			);
			if (bytesRead === 0) {
				throw new Error("Upload file ended before the signed part length");
			}
			await writeCompleteBuffer(destination, buffer.subarray(0, bytesRead));
			copiedBytes += bytesRead;
		}
	} catch (error) {
		await closeFiles(source, destination);
		await cleanupOwnedR2StagingDirectory(directory);
		throw error;
	}
	await closeFiles(source, destination);
	return {
		cleanup: () => cleanupOwnedR2StagingDirectory(directory),
		path: partPath,
	};
}

async function closeFiles(
	...files: readonly (FileHandle | undefined)[]
): Promise<void> {
	await Promise.allSettled(files.map((file) => file?.close()));
}

async function writeCompleteBuffer(
	file: FileHandle,
	buffer: Uint8Array,
): Promise<void> {
	let offset = 0;
	while (offset < buffer.byteLength) {
		const { bytesWritten } = await file.write(
			buffer,
			offset,
			buffer.byteLength - offset,
		);
		if (bytesWritten === 0) {
			throw new Error("Could not write the complete temporary upload part");
		}
		offset += bytesWritten;
	}
}

function createFileRangeStream(
	path: string,
	start: number,
	byteLength: number,
	onChunk: (byteLength: number) => void,
): ReadableStream<Uint8Array> {
	let file: FileHandle | undefined;
	let offset = 0;
	let closed = false;

	async function closeFile(): Promise<void> {
		if (closed) return;
		closed = true;
		await file?.close();
	}

	return new ReadableStream<Uint8Array>({
		async cancel() {
			await closeFile();
		},
		async pull(controller) {
			try {
				if (!file) file = await open(path, "r");
				const remaining = byteLength - offset;
				if (remaining === 0) {
					await closeFile();
					controller.close();
					return;
				}
				const buffer = Buffer.allocUnsafe(
					Math.min(STREAM_CHUNK_BYTES, remaining),
				);
				const { bytesRead } = await file.read(
					buffer,
					0,
					buffer.byteLength,
					start + offset,
				);
				if (bytesRead === 0) {
					throw new Error("Upload file ended before the signed part length");
				}
				offset += bytesRead;
				onChunk(bytesRead);
				controller.enqueue(buffer.subarray(0, bytesRead));
				if (offset === byteLength) {
					await closeFile();
					controller.close();
				}
			} catch (error) {
				await closeFile();
				controller.error(error);
			}
		},
	});
}

async function assertUploadObjectMatchesFile(
	source: R2MultipartUploadSource,
): Promise<void> {
	const file = await stat(source.path);
	if (!file.isFile()) {
		throw new Error(`R2 upload source is not a regular file: ${source.path}`);
	}
	if (file.size !== source.upload.byteLength) {
		throw new Error(
			`R2 upload source size changed: expected ${source.upload.byteLength} bytes, found ${file.size}`,
		);
	}
}

function assertUploadPartManifest(upload: R2IngestUploadObject): void {
	let totalBytes = 0;
	for (const [index, part] of upload.parts.entries()) {
		const expectedPartNumber = index + 1;
		if (part.partNumber !== expectedPartNumber) {
			throw new Error(
				`R2 upload part numbers must be sequential from 1; received ${part.partNumber}`,
			);
		}
		if (part.headers["Content-Length"] !== part.byteLength.toString()) {
			throw new Error(
				`R2 signed Content-Length does not match part ${part.partNumber}`,
			);
		}
		totalBytes += part.byteLength;
	}
	if (totalBytes !== upload.byteLength) {
		throw new Error(
			`R2 part manifest totals ${totalBytes} bytes, expected ${upload.byteLength}`,
		);
	}
}

function toMultipartUploadError(error: unknown): R2MultipartUploadError {
	if (error instanceof R2MultipartUploadError) return error;
	const message = error instanceof Error ? error.message : "network failure";
	return new R2MultipartUploadError(
		`R2 part upload failed before a response: ${message}`,
		{ retryable: true, status: undefined },
	);
}

function isTransientHttpStatus(status: number): boolean {
	return status === 408 || status === 425 || status === 429 || status >= 500;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

async function delay(milliseconds: number): Promise<void> {
	if (milliseconds <= 0) return;
	await new Promise((resolve) => setTimeout(resolve, milliseconds));
}
