import { createHash, randomUUID } from "node:crypto";
import {
	chmod,
	mkdir,
	readdir,
	readFile,
	rename,
	rm,
	stat,
	utimes,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { RepositoryEvidenceInitInputSchema } from "../contracts/index.js";
import { FILTER_VERSION } from "../internal/secret-filter/index.js";
import {
	createRepositorySpoolBinding,
	createRepositorySpoolEnv,
	markRepositorySpoolCaptureAbandoned,
} from "./repo-spool.js";
import type {
	BuiltRepositoryEvidenceUpload,
	RepositoryEvidenceBytes,
} from "./repository-evidence-upload.js";
import type { TranscriptRevisionManifest } from "./transcript-revision.js";
import { hasValidTranscriptRevisionIntegrity } from "./transcript-revision.js";

const PENDING_VERSION = 4;
const UNSCOPED_PENDING_VERSION = 3;

export interface PendingRepositoryEvidenceQuota {
	readonly maxFiles: number;
	readonly maxTotalBytes: number;
}

export const DEFAULT_PENDING_REPOSITORY_EVIDENCE_QUOTA: PendingRepositoryEvidenceQuota =
	{ maxFiles: 200, maxTotalBytes: 512 * 1024 * 1024 };

export interface PendingRepositoryEvidence {
	readonly repositorySelection?: {
		readonly repoKey: string;
		readonly legacyKeys: readonly string[];
		readonly source: "claude_code" | "codex";
	};
	readonly continuation?: {
		readonly sourceId: string;
		readonly terminal: boolean;
	};
	readonly endpoint: string;
	readonly transcriptRevision: TranscriptRevisionManifest;
	readonly upload: BuiltRepositoryEvidenceUpload;
}

class IncompatiblePendingFilterError extends Error {
	constructor(readonly pending: PendingRepositoryEvidence) {
		super(
			`Repository evidence capture ${pending.upload.input.capture.contextId} uses an incompatible secret filter version and was quarantined (not uploaded). Recollect the session with the current CLI before retrying.`,
		);
		this.name = "IncompatiblePendingFilterError";
	}
}

export async function writePendingRepositoryEvidence(
	pending: PendingRepositoryEvidence,
	configDir: string,
	quota: PendingRepositoryEvidenceQuota = DEFAULT_PENDING_REPOSITORY_EVIDENCE_QUOTA,
): Promise<string> {
	assertInitialRevisionClosure(
		pending.transcriptRevision,
		pending.upload.objects,
	);
	const directory = pendingDirectory(configDir);
	await mkdir(directory, { mode: 0o700, recursive: true });
	if (process.platform !== "win32") await chmod(directory, 0o700);
	const path = join(directory, pendingFileName(pending));
	await assertPendingQuota(directory, path, pending, quota);
	const temporary = `${path}.${randomUUID()}.tmp`;
	const value = {
		repositorySelection: pending.repositorySelection,
		continuation: pending.continuation,
		version: PENDING_VERSION,
		endpoint: pending.endpoint,
		input: pending.upload.input,
		objects: [...pending.upload.objects.values()].map((object) => ({
			bytes: Buffer.from(object.bytes).toString("base64"),
			descriptor: object.descriptor,
		})),
		transcriptRevision: pending.transcriptRevision,
	};
	try {
		await writeFile(temporary, `${JSON.stringify(value)}\n`, {
			encoding: "utf8",
			flag: "wx",
			mode: 0o600,
		});
		await rename(temporary, path);
		if (process.platform !== "win32") await chmod(path, 0o600);
	} finally {
		await rm(temporary, { force: true });
	}
	return path;
}

async function assertPendingQuota(
	directory: string,
	path: string,
	pending: PendingRepositoryEvidence,
	quota: PendingRepositoryEvidenceQuota,
): Promise<void> {
	const incomingBytes =
		[...pending.upload.objects.values()].reduce(
			(total, object) => total + Math.ceil(object.bytes.byteLength / 3) * 4,
			0,
		) +
		64 * 1024;
	let files = 0;
	let totalBytes = 0;
	for (const name of await readdir(directory)) {
		if (!name.endsWith(".json")) continue;
		const existing = join(directory, name);
		if (existing === path) continue;
		try {
			totalBytes += (await stat(existing)).size;
			files += 1;
		} catch (error) {
			if (!isErrorCode(error, "ENOENT")) throw error;
		}
	}
	if (
		files + 1 > quota.maxFiles ||
		totalBytes + incomingBytes > quota.maxTotalBytes
	) {
		throw new Error(
			`Pending repository evidence quota exceeded (${files} captures, ${totalBytes} bytes stored; limit ${quota.maxFiles} captures and ${quota.maxTotalBytes} bytes). Deliver or discard pending evidence before capturing more.`,
		);
	}
}

export async function readPendingRepositoryEvidence(
	configDir: string,
	options: {
		readonly actorId?: string;
		readonly endpoint?: string;
		readonly excludeOperationIds?: ReadonlySet<string>;
		readonly maxItems?: number;
		readonly isEligible?: (pending: PendingRepositoryEvidence) => boolean;
		readonly onError?: (error: unknown) => void;
		readonly onWarning?: (warning: Error) => void;
	} = {},
): Promise<readonly PendingRepositoryEvidence[]> {
	const quarantinedLegacyItems = await quarantineUnscopedPending(configDir);
	if (quarantinedLegacyItems > 0) {
		options.onWarning?.(legacyPendingQuarantined(quarantinedLegacyItems));
	}
	const directory = pendingDirectory(configDir);
	let names: readonly string[];
	try {
		const prefix = pendingFilePrefix(options.actorId, options.endpoint);
		names = (await readdir(directory))
			.filter((name) => name.endsWith(".json") && name.startsWith(prefix))
			.sort();
	} catch (error) {
		if (isErrorCode(error, "ENOENT")) return [];
		throw error;
	}
	const paths = [];
	for (const name of names) {
		const path = join(directory, name);
		try {
			paths.push({ modifiedAt: (await stat(path)).mtimeMs, path });
		} catch (error) {
			if (!isErrorCode(error, "ENOENT")) throw error;
		}
	}
	paths.sort((left, right) => left.modifiedAt - right.modifiedAt);
	const pending: PendingRepositoryEvidence[] = [];
	const maxItems = options.maxItems ?? Number.POSITIVE_INFINITY;
	for (const entry of paths) {
		if (pending.length >= maxItems) break;
		let text: string;
		try {
			text = await readFile(entry.path, "utf8");
		} catch (error) {
			if (isErrorCode(error, "ENOENT")) continue;
			throw error;
		}
		let value: PendingRepositoryEvidence;
		try {
			value = parsePending(text, options.actorId, options.endpoint);
		} catch (error) {
			if (error instanceof IncompatiblePendingFilterError) {
				await abandonPendingRepositoryCapture(error.pending, configDir);
				await quarantinePending(entry.path, directory);
				options.onWarning?.(error);
				continue;
			}
			await quarantinePending(entry.path, directory);
			if (!options.onError) throw error;
			options.onError(error);
			continue;
		}
		if (options.excludeOperationIds?.has(value.upload.input.operationId))
			continue;
		if (options.isEligible && !options.isEligible(value)) continue;
		pending.push(value);
	}
	return pending;
}

async function abandonPendingRepositoryCapture(
	pending: PendingRepositoryEvidence,
	configDir: string,
): Promise<void> {
	const binding = await createRepositorySpoolBinding({
		accountId: pending.transcriptRevision.scope.actorId,
		apiBaseUrl: pending.endpoint,
		localIdentity: pending.upload.input.repository.local,
		workspaceId: pending.upload.input.organizationId,
	});
	await markRepositorySpoolCaptureAbandoned(
		binding,
		pending.upload.input.capture.contextId,
		"local-context",
		createRepositorySpoolEnv(configDir),
	);
}

async function quarantinePending(
	path: string,
	directory: string,
): Promise<void> {
	const quarantine = join(directory, "quarantine");
	await mkdir(quarantine, { mode: 0o700, recursive: true });
	if (process.platform !== "win32") await chmod(quarantine, 0o700);
	try {
		await rename(path, join(quarantine, `${randomUUID()}.json`));
	} catch (error) {
		if (!isErrorCode(error, "ENOENT")) throw error;
	}
}

export async function deferPendingRepositoryEvidence(
	pending: PendingRepositoryEvidence,
	configDir: string,
): Promise<void> {
	const now = new Date();
	try {
		await utimes(
			join(pendingDirectory(configDir), pendingFileName(pending)),
			now,
			now,
		);
	} catch (error) {
		if (!isErrorCode(error, "ENOENT")) throw error;
	}
}

export async function removePendingRepositoryEvidence(
	pending: PendingRepositoryEvidence,
	configDir: string,
): Promise<void> {
	await rm(join(pendingDirectory(configDir), pendingFileName(pending)), {
		force: true,
	});
}

function pendingFileName(pending: PendingRepositoryEvidence): string {
	return `${pendingFilePrefix(
		pending.transcriptRevision.scope.actorId,
		pending.endpoint,
	)}${pending.upload.input.operationId}.json`;
}

function pendingFilePrefix(actorId?: string, endpoint?: string): string {
	const actor = actorId ? shortHash(actorId) : "";
	const destination = endpoint
		? shortHash(normalizeRepositoryEvidenceEndpoint(endpoint))
		: "";
	if (actor && destination) return `${actor}.${destination}.`;
	if (actor) return `${actor}.`;
	return "";
}

function shortHash(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function parsePending(
	text: string,
	actorId: string | undefined,
	endpoint: string | undefined,
): PendingRepositoryEvidence {
	const value: unknown = JSON.parse(text);
	if (typeof value !== "object" || value === null) throw invalidPending();
	const record = value as Record<string, unknown>;
	if (
		record.version !== PENDING_VERSION ||
		typeof record.endpoint !== "string" ||
		!Array.isArray(record.objects) ||
		!isTranscriptRevisionManifest(record.transcriptRevision)
	) {
		throw invalidPending();
	}
	const input = RepositoryEvidenceInitInputSchema.parse(record.input);
	let repositorySelection: PendingRepositoryEvidence["repositorySelection"];
	if (record.repositorySelection !== undefined) {
		const selection = record.repositorySelection;
		if (
			typeof selection !== "object" ||
			selection === null ||
			!("repoKey" in selection) ||
			typeof selection.repoKey !== "string" ||
			!selection.repoKey ||
			!("legacyKeys" in selection) ||
			!Array.isArray(selection.legacyKeys) ||
			!selection.legacyKeys.every((key: unknown) => typeof key === "string") ||
			!("source" in selection) ||
			selection.source !== input.session.source
		)
			throw invalidPending();
		repositorySelection = {
			repoKey: selection.repoKey,
			legacyKeys: selection.legacyKeys,
			source: input.session.source,
		};
	}
	let continuation: PendingRepositoryEvidence["continuation"];
	if (record.continuation !== undefined) {
		const value = record.continuation;
		if (
			typeof value !== "object" ||
			value === null ||
			!("sourceId" in value) ||
			typeof value.sourceId !== "string" ||
			!/^[0-9a-f-]{36}$/.test(value.sourceId) ||
			!("terminal" in value) ||
			typeof value.terminal !== "boolean"
		)
			throw invalidPending();
		continuation = { sourceId: value.sourceId, terminal: value.terminal };
	}
	const objects = new Map<string, RepositoryEvidenceBytes>();
	for (const value of record.objects) {
		if (typeof value !== "object" || value === null) throw invalidPending();
		const object = value as Record<string, unknown>;
		if (typeof object.bytes !== "string") throw invalidPending();
		const descriptor = input.objects.find(
			(candidate) =>
				typeof object.descriptor === "object" &&
				object.descriptor !== null &&
				"objectId" in object.descriptor &&
				object.descriptor.objectId === candidate.objectId,
		);
		if (
			!descriptor ||
			JSON.stringify(descriptor) !== JSON.stringify(object.descriptor)
		) {
			throw invalidPending();
		}
		const bytes = new Uint8Array(Buffer.from(object.bytes, "base64"));
		const sha256 = createHash("sha256").update(bytes).digest("hex");
		if (
			bytes.byteLength !== descriptor.byteLength ||
			sha256 !== descriptor.sha256
		) {
			throw invalidPending();
		}
		objects.set(descriptor.objectId, { bytes, descriptor });
	}
	if (objects.size !== input.objects.length) throw invalidPending();
	assertInitialRevisionClosure(record.transcriptRevision, objects);
	const pending = {
		repositorySelection,
		continuation,
		endpoint: normalizeRepositoryEvidenceEndpoint(record.endpoint),
		transcriptRevision: record.transcriptRevision,
		upload: { input, objects },
	};
	if (
		(actorId && pending.transcriptRevision.scope.actorId !== actorId) ||
		(endpoint &&
			pending.endpoint !== normalizeRepositoryEvidenceEndpoint(endpoint))
	) {
		throw invalidPending();
	}
	if (input.objects.some((object) => object.filterVersion !== FILTER_VERSION)) {
		throw new IncompatiblePendingFilterError(pending);
	}
	return pending;
}

function assertInitialRevisionClosure(
	revision: TranscriptRevisionManifest,
	objects: ReadonlyMap<string, RepositoryEvidenceBytes>,
): void {
	if (
		revision.parentRevisionId === undefined &&
		revision.chunks.some((chunk) => !objects.has(`sha256:${chunk.sha256}`))
	) {
		throw invalidPending();
	}
}

async function quarantineUnscopedPending(configDir: string): Promise<number> {
	const legacyDirectory = join(
		configDir,
		"repository-evidence-pending",
		`v${UNSCOPED_PENDING_VERSION}`,
	);
	let names: readonly string[];
	try {
		names = (await readdir(legacyDirectory)).filter((name) =>
			name.endsWith(".json"),
		);
	} catch (error) {
		if (isErrorCode(error, "ENOENT")) return 0;
		throw error;
	}
	if (names.length === 0) return 0;
	const quarantine = join(pendingDirectory(configDir), "quarantine");
	await mkdir(quarantine, { mode: 0o700, recursive: true });
	if (process.platform !== "win32") await chmod(quarantine, 0o700);
	for (const name of names) {
		try {
			await rename(
				join(legacyDirectory, name),
				join(quarantine, `v${UNSCOPED_PENDING_VERSION}.${randomUUID()}.json`),
			);
		} catch (error) {
			if (!isErrorCode(error, "ENOENT")) throw error;
		}
	}
	return names.length;
}

export function normalizeRepositoryEvidenceEndpoint(endpoint: string): string {
	const url = new URL(endpoint);
	url.hash = "";
	url.search = "";
	url.pathname = url.pathname.replace(/\/{2,}/gu, "/");
	if (url.pathname.length > 1)
		url.pathname = url.pathname.replace(/\/+$/gu, "");
	return url.toString();
}

function isTranscriptRevisionManifest(
	value: unknown,
): value is TranscriptRevisionManifest {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Partial<TranscriptRevisionManifest>;
	return (
		record.version === 1 &&
		typeof record.revisionId === "string" &&
		typeof record.generation === "number" &&
		typeof record.terminal === "boolean" &&
		typeof record.scope === "object" &&
		record.scope !== null &&
		Array.isArray(record.chunks) &&
		typeof record.watermark === "object" &&
		record.watermark !== null &&
		hasValidTranscriptRevisionIntegrity(record as TranscriptRevisionManifest)
	);
}

function pendingDirectory(configDir: string): string {
	return join(configDir, "repository-evidence-pending", `v${PENDING_VERSION}`);
}

function invalidPending(): Error {
	return new Error("Stored pending repository evidence is invalid.");
}

function legacyPendingQuarantined(count: number): Error {
	return new Error(
		`Retained ${count} repository evidence capture(s) from an earlier CLI version in quarantine because their destination-scoped transcript baseline cannot be verified. Run a new session capture to recreate them safely.`,
	);
}

function isErrorCode(error: unknown, code: string): boolean {
	return (
		error instanceof Error &&
		"code" in error &&
		(error as { readonly code?: unknown }).code === code
	);
}
