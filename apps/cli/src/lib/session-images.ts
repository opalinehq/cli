import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import {
	REPOSITORY_EVIDENCE_IMAGE_MEDIA_TYPE_PATTERN,
	REPOSITORY_EVIDENCE_MAX_IMAGE_BYTES,
	REPOSITORY_EVIDENCE_MAX_IMAGE_OBJECTS,
} from "../contracts/index.js";
import {
	CLAUDE_SESSION_IMAGES_ROOT_ID,
	CLAUDE_TOOL_RESULTS_ROOT_ID,
	CODEX_ATTACHMENTS_ROOT_ID,
	CODEX_GENERATED_IMAGES_ROOT_ID,
} from "../internal/local-context-source/capture-policy.js";
import type {
	SessionImageReference,
	SessionImageSkipReason,
	SessionImages,
} from "../internal/local-context-source/index.js";
import { createRpcClient } from "./api-client.js";
import {
	hasCachedEvidenceImagesCapability,
	rememberEvidenceImagesCapability,
} from "./r2-upload-capability.js";
import {
	extractInlineImagesFromLine,
	type InlineImage,
	slimTranscriptText,
} from "./transcript-slim.js";

/**
 * Session images are delivered as repository-evidence `image` objects: the
 * raw decoded bytes, `objectId` = `sha256:<hex>` (the hash in the transcript's
 * `opaline-image-omitted` marker). Sources:
 *
 * - inline: base64 images in transcript records (the transcript chunks keep
 *   their exact bytes; the session upload has the marker) and in saved tool
 *   outputs, task outputs and Codex text attachments (whose stored text is
 *   slimmed, so the marker is all that is left there);
 * - files: image files in Claude Code's `tool-results` (MCP screenshots) and
 *   in its per-session `images` directory (pasted images), and the files below
 *   Codex's `attachments` and `generated_images` the thread names literally.
 *
 * Images have their own budget per capture, apart from the transcript and
 * the context. The server returns which objects it is missing, so an image it
 * already stores (from any capture of the workspace) is not uploaded again;
 * but every declared image counts against the capture's image budget, so an
 * image a commit has confirmed for this session is not listed by its later
 * captures at all (its transcript marker and the earlier capture say it all).
 * Images over the budget are listed as `deferred` and delivered by a later
 * capture.
 *
 * The secret filter cannot scan image bytes: images are uploaded as they are.
 */

/** One image object: the server's bound. */
export const SESSION_IMAGE_MAX_BYTES = REPOSITORY_EVIDENCE_MAX_IMAGE_BYTES;
/**
 * Image bytes one capture declares. The server takes 256 MiB; a capture is
 * spooled locally (base64, in one JSON file) before delivery, and the spool
 * holds 512 MiB in all, so 64 MiB keeps a capture with a full transcript
 * delivery under ~260 MiB on disk and in memory.
 */
export const SESSION_IMAGES_MAX_BYTES_PER_CAPTURE = 64 * 1024 * 1024;
export const SESSION_IMAGES_MAX_OBJECTS_PER_CAPTURE =
	REPOSITORY_EVIDENCE_MAX_IMAGE_OBJECTS;
/** Bounds on the manifest lists (~250 bytes per reference; the server reads 2048 and 512). */
export const SESSION_IMAGES_MAX_REFERENCES = 1024;
export const SESSION_IMAGES_MAX_SKIPPED = 512;
/** Manifest bytes the `images` field may take, kept free of the transcript. */
export const SESSION_IMAGES_MANIFEST_RESERVE_BYTES = 512 * 1024;
/** Files examined per image root. */
export const SESSION_IMAGE_MAX_FILES_PER_ROOT = 1024;
/** Codex thread files taken per directory kind. */
export const CODEX_THREAD_MAX_FILES = 256;
/** Inline image bytes held from artifact text while the context is collected. */
const ARTIFACT_IMAGE_MAX_HELD_BYTES = SESSION_IMAGES_MAX_BYTES_PER_CAPTURE;
const SNIFF_BYTES = 16;
const BINARY_PROBE_BYTES = 8192;
const PREFLIGHT_TIMEOUT_MS = 5_000;

export interface SessionImageObject {
	readonly sha256: string;
	readonly mediaType: string;
	readonly bytes: Uint8Array;
}

export interface PlannedSessionImages {
	/** Image objects this capture declares (and uploads when missing). */
	readonly objects: readonly SessionImageObject[];
	readonly manifest: SessionImages;
	/** Distinct images left for a later capture by this capture's budget. */
	readonly deferred: number;
}

/** Where an image sits: its record in a stream, or its file in a root. */

type Location = Omit<
	SessionImageReference,
	"sha256" | "mediaType" | "bytes" | "source"
>;

interface Candidate {
	readonly sha256: string;
	readonly mediaType: string;
	readonly size: number;
	/** Null when the bytes were not kept (they can only be deferred). */
	readonly bytes: Uint8Array | null;
	readonly source: SessionImageReference["source"];
	readonly location: Location;
}

type Discovered =
	| { readonly kind: "candidate"; readonly candidate: Candidate }
	| {
			readonly kind: "skipped";
			readonly sha256: string;
			readonly reason: SessionImageSkipReason;
	  };

/**
 * Collects inline images of saved tool outputs, task outputs and Codex text
 * attachments while the context collector reads them: `transform` is the
 * collector's text transform (the transcript's slimming).
 */
export interface ArtifactImageCollector {
	readonly transform: (
		text: string,
		file: { readonly rootId: string; readonly path: string },
	) => string;
	readonly discovered: () => readonly Discovered[];
}

export function createArtifactImageCollector(): ArtifactImageCollector {
	const discovered: Discovered[] = [];
	const held = new Set<string>();
	let heldBytes = 0;
	return {
		transform: (text, file) => {
			for (const { image } of inlineImages(text)) {
				const keep =
					held.has(image.sha256) ||
					heldBytes + image.bytes.byteLength <= ARTIFACT_IMAGE_MAX_HELD_BYTES;
				if (keep && !held.has(image.sha256)) {
					held.add(image.sha256);
					heldBytes += image.bytes.byteLength;
				}
				discovered.push({
					kind: "candidate",
					candidate: {
						sha256: image.sha256,
						mediaType: image.mediaType,
						size: image.bytes.byteLength,
						bytes: keep ? image.bytes : null,
						// Named by the saved output that held it inline (its stored
						// text has the marker); a record index would read as one of
						// the transcript's.
						source: "file",
						location: {
							agentId: null,
							path: file.path,
							recordIndex: null,
							rootId: file.rootId,
						},
					},
				});
			}
			return slimTranscriptText(text);
		},
		discovered: () => discovered,
	};
}

/** Every inline image of a JSONL text with its 1-based line, lazily. */
function* inlineImages(
	content: string,
): Generator<{ readonly image: InlineImage; readonly recordIndex: number }> {
	let start = 0;
	for (let line = 1; start < content.length; line += 1) {
		const end = content.indexOf("\n", start);
		const text = content.slice(start, end < 0 ? undefined : end);
		start = end < 0 ? content.length : end + 1;
		if (!text.includes("base64") && !text.includes("mimeType")) continue;
		for (const image of extractInlineImagesFromLine(text.replace(/\r$/u, "")))
			yield { image, recordIndex: line };
	}
}

export interface SessionImageFileRoot {
	readonly rootId: string;
	readonly directory: string;
	/** Root-relative files to examine; `"listing"`: the directory's own files. */
	readonly paths: readonly string[] | "listing";
}

/**
 * The capture's images: references to every image found (in transcript,
 * artifact and file order), the objects that fit this capture's budget, and
 * a skip reason for every other image.
 */
export async function planSessionImages(input: {
	readonly streams: readonly {
		readonly agentId: string | null;
		readonly content: string;
	}[];
	readonly artifacts?: ArtifactImageCollector;
	readonly files: readonly SessionImageFileRoot[];
	/** Images a commit confirmed for this session: not listed again. */
	readonly delivered: ReadonlySet<string>;
	/** Asked once, and only when there is an image to upload. */
	readonly isSupported: () => Promise<boolean>;
	readonly maxBytes: number;
	readonly maxObjects: number;
	/** Bound on one image (SESSION_IMAGE_MAX_BYTES). */
	readonly maxImageBytes?: number;
	readonly deadlineAt?: number;
}): Promise<PlannedSessionImages> {
	const plan = createPlan(input);
	const maxImageBytes = input.maxImageBytes ?? SESSION_IMAGE_MAX_BYTES;
	// One image at a time, so only the selected images' bytes are held.
	for (const stream of input.streams) {
		for (const { image, recordIndex } of inlineImages(stream.content)) {
			plan.pending.push({
				kind: "candidate",
				candidate: {
					sha256: image.sha256,
					mediaType: image.mediaType,
					size: image.bytes.byteLength,
					bytes: image.bytes,
					source: "inline",
					location: { agentId: stream.agentId, recordIndex },
				},
			});
			await plan.drain();
		}
	}
	plan.pending.push(...(input.artifacts?.discovered() ?? []));
	await plan.drain();
	for (const root of input.files) {
		for await (const item of discoverImageFiles(
			root,
			maxImageBytes,
			input.deadlineAt,
		)) {
			plan.pending.push(item);
			await plan.drain();
		}
	}
	return plan.result();
}

function createPlan(input: {
	readonly delivered: ReadonlySet<string>;
	readonly isSupported: () => Promise<boolean>;
	readonly maxBytes: number;
	readonly maxObjects: number;
	readonly maxImageBytes?: number;
}) {
	const maxImageBytes = input.maxImageBytes ?? SESSION_IMAGE_MAX_BYTES;
	const objects = new Map<string, SessionImageObject>();
	const references: SessionImageReference[] = [];
	const skipped = new Map<string, SessionImageSkipReason>();
	const pending: Discovered[] = [];
	let omitted = 0;
	let bytes = 0;
	let supported: boolean | undefined;
	const reference = (candidate: Candidate) => {
		if (references.length >= SESSION_IMAGES_MAX_REFERENCES) {
			omitted += 1;
			return;
		}
		references.push({
			sha256: candidate.sha256,
			mediaType: candidate.mediaType,
			bytes: candidate.size,
			source: candidate.source,
			...(candidate.location.path === undefined
				? {}
				: { path: candidate.location.path }),
			...(candidate.location.rootId === undefined
				? {}
				: { rootId: candidate.location.rootId }),
			agentId: candidate.location.agentId,
			recordIndex: candidate.location.recordIndex,
		});
	};
	const skip = (sha256: string, reason: SessionImageSkipReason) => {
		if (objects.has(sha256) || input.delivered.has(sha256)) return;
		if (!skipped.has(sha256)) skipped.set(sha256, reason);
	};
	const decide = async (
		candidate: Candidate,
	): Promise<SessionImageSkipReason | null> => {
		if (!REPOSITORY_EVIDENCE_IMAGE_MEDIA_TYPE_PATTERN.test(candidate.mediaType))
			return "unsupported-media-type";
		if (candidate.size > maxImageBytes) return "too-large";
		if (
			candidate.bytes === null ||
			bytes + candidate.size > input.maxBytes ||
			objects.size >= input.maxObjects
		)
			return "deferred";
		supported ??= await input.isSupported();
		return supported ? null : "server-unsupported";
	};
	const consider = async (candidate: Candidate) => {
		const { sha256 } = candidate;
		if (input.delivered.has(sha256)) return;
		if (!objects.has(sha256) && !skipped.has(sha256)) {
			const reason = await decide(candidate);
			if (reason !== null) skipped.set(sha256, reason);
			else if (candidate.bytes !== null) {
				objects.set(sha256, {
					sha256,
					mediaType: candidate.mediaType,
					bytes: candidate.bytes,
				});
				bytes += candidate.size;
			}
		}
		reference(candidate);
	};
	return {
		pending,
		drain: async () => {
			for (const item of pending.splice(0))
				if (item.kind === "candidate") await consider(item.candidate);
				else skip(item.sha256, item.reason);
		},
		result: (): PlannedSessionImages => {
			// Against a server without image objects no later capture can
			// deliver what this one had no room for either.
			const skippedList = [...skipped].map(([sha256, reason]) => ({
				sha256,
				reason:
					supported === false && reason === "deferred"
						? ("server-unsupported" as const)
						: reason,
			}));
			omitted += Math.max(0, skippedList.length - SESSION_IMAGES_MAX_SKIPPED);
			const listed = skippedList.slice(0, SESSION_IMAGES_MAX_SKIPPED);
			// Long paths could make the lists outgrow the manifest bytes the
			// budget reserved for them: the last references go first.
			let size = Buffer.byteLength(
				JSON.stringify({ references, omitted, skipped: listed }),
			);
			while (
				references.length > 0 &&
				size > SESSION_IMAGES_MANIFEST_RESERVE_BYTES
			) {
				size -= Buffer.byteLength(JSON.stringify(references.pop())) + 1;
				omitted += 1;
			}
			return {
				objects: [...objects.values()],
				manifest: { references, omitted, skipped: listed },
				deferred: skippedList.filter((item) => item.reason === "deferred")
					.length,
			};
		},
	};
}

/**
 * Image files of one root. Regular files only (symlinks are never read),
 * opened without following links; the media type comes from the file's
 * signature, not its name.
 */
async function* discoverImageFiles(
	root: SessionImageFileRoot,
	maxImageBytes: number,
	deadlineAt: number | undefined,
): AsyncGenerator<Discovered> {
	const paths =
		root.paths === "listing"
			? await listFiles(root.directory)
			: root.paths.slice(0, SESSION_IMAGE_MAX_FILES_PER_ROOT);
	for (const path of paths) {
		if (deadlineAt !== undefined && Date.now() >= deadlineAt) return;
		const item = await examineFile(root, path, maxImageBytes);
		if (item !== null) yield item;
	}
}

async function listFiles(directory: string): Promise<readonly string[]> {
	const details = await lstat(directory).catch(() => null);
	if (details === null || !details.isDirectory()) return [];
	const entries = await readdir(directory, { withFileTypes: true }).catch(
		() => [],
	);
	return entries
		.filter((entry) => entry.isFile())
		.map((entry) => entry.name)
		.sort()
		.slice(0, SESSION_IMAGE_MAX_FILES_PER_ROOT);
}

async function examineFile(
	root: SessionImageFileRoot,
	path: string,
	maxImageBytes: number,
): Promise<Discovered | null> {
	let handle: Awaited<ReturnType<typeof open>>;
	try {
		handle = await open(
			join(root.directory, path),
			constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
		);
	} catch {
		return null;
	}
	try {
		const details = await handle.stat();
		if (!details.isFile() || details.size === 0) return null;
		const probe = Buffer.alloc(Math.min(details.size, BINARY_PROBE_BYTES));
		await handle.read(probe, 0, probe.byteLength, 0);
		const mediaType = sniffMediaType(probe.subarray(0, SNIFF_BYTES));
		const isImage = mediaType?.startsWith("image/") ?? false;
		// Text (saved outputs, pasted text, SVG) is context the collector
		// captures; any other binary file is listed as not uploaded.
		if (mediaType === null && !probe.includes(0)) return null;
		if (!isImage || mediaType === null)
			return {
				kind: "skipped",
				sha256: await hashHandle(handle),
				reason: "unsupported-media-type",
			};
		const location = {
			agentId: null,
			path,
			recordIndex: null,
			rootId: root.rootId,
		};
		if (details.size > maxImageBytes)
			return {
				kind: "candidate",
				candidate: {
					sha256: await hashHandle(handle),
					mediaType,
					size: details.size,
					bytes: null,
					source: "file",
					location,
				},
			};
		const bytes = new Uint8Array(details.size);
		let offset = 0;
		while (offset < bytes.byteLength) {
			const { bytesRead } = await handle.read(
				bytes,
				offset,
				bytes.byteLength - offset,
				offset,
			);
			if (bytesRead === 0) break;
			offset += bytesRead;
		}
		const content = bytes.subarray(0, offset);
		return {
			kind: "candidate",
			candidate: {
				sha256: createHash("sha256").update(content).digest("hex"),
				mediaType,
				size: content.byteLength,
				bytes: content,
				source: "file",
				location,
			},
		};
	} catch {
		return null;
	} finally {
		await handle.close();
	}
}

async function hashHandle(
	handle: Awaited<ReturnType<typeof open>>,
): Promise<string> {
	const hash = createHash("sha256");
	const window = Buffer.alloc(1024 * 1024);
	for (let position = 0; ; ) {
		const { bytesRead } = await handle.read(window, 0, window.length, position);
		if (bytesRead === 0) break;
		hash.update(window.subarray(0, bytesRead));
		position += bytesRead;
	}
	return hash.digest("hex");
}

/**
 * The media type from a file signature: raster images, and PDF (a binary
 * session file that is not an image). Null for anything else.
 */
export function sniffMediaType(header: Uint8Array): string | null {
	const ascii = (start: number, text: string) =>
		[...text].every(
			(character, index) => header[start + index] === character.charCodeAt(0),
		);
	if (
		header[0] === 0x89 &&
		ascii(1, "PNG") &&
		header[4] === 0x0d &&
		header[5] === 0x0a &&
		header[6] === 0x1a &&
		header[7] === 0x0a
	)
		return "image/png";
	if (header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff)
		return "image/jpeg";
	if (ascii(0, "GIF87a") || ascii(0, "GIF89a")) return "image/gif";
	if (ascii(0, "RIFF") && ascii(8, "WEBP")) return "image/webp";
	if (ascii(0, "II") && header[2] === 0x2a && header[3] === 0x00)
		return "image/tiff";
	if (ascii(0, "MM") && header[2] === 0x00 && header[3] === 0x2a)
		return "image/tiff";
	if (ascii(4, "ftyp")) {
		if (ascii(8, "avif") || ascii(8, "avis")) return "image/avif";
		if (ascii(8, "heic") || ascii(8, "heix") || ascii(8, "mif1"))
			return "image/heic";
	}
	if (ascii(0, "%PDF-")) return "application/pdf";
	return null;
}

/** The image file roots of a Claude Code session capture. */
export function getClaudeImageFileRoots(input: {
	readonly toolResultsDirectory: string | null;
	readonly sessionImagesDirectory: string | null;
}): readonly SessionImageFileRoot[] {
	return [
		...(input.toolResultsDirectory === null
			? []
			: [
					{
						rootId: CLAUDE_TOOL_RESULTS_ROOT_ID,
						directory: input.toolResultsDirectory,
						paths: "listing" as const,
					},
				]),
		...(input.sessionImagesDirectory === null
			? []
			: [
					{
						rootId: CLAUDE_SESSION_IMAGES_ROOT_ID,
						directory: input.sessionImagesDirectory,
						paths: "listing" as const,
					},
				]),
	];
}

export interface CodexThreadFiles {
	/** Relative to `$CODEX_HOME/attachments`. */
	readonly attachments: readonly string[];
	/** Relative to `$CODEX_HOME/generated_images`. */
	readonly generatedImages: readonly string[];
}

export function getCodexImageFileRoots(
	codexHome: string,
	files: CodexThreadFiles,
): readonly SessionImageFileRoot[] {
	return [
		{
			rootId: CODEX_ATTACHMENTS_ROOT_ID,
			directory: join(codexHome, "attachments"),
			paths: files.attachments,
		},
		{
			rootId: CODEX_GENERATED_IMAGES_ROOT_ID,
			directory: join(codexHome, "generated_images"),
			paths: files.generatedImages,
		},
	];
}

const CODEX_DIRECTORY_SEGMENT = /^[A-Za-z0-9_-]{1,64}(?=\/)/u;

/**
 * Files below `$CODEX_HOME/attachments/<id>/` and
 * `$CODEX_HOME/generated_images/<id>/` that the thread's rollout names by
 * their full path: both directories hold every thread's files, so only a
 * literal path ties one to this thread. Each named `<id>` directory is
 * listed, and a file is taken when the text right after its directory starts
 * with its name (names may contain spaces, so the text alone does not say
 * where a name ends).
 */
export async function findCodexThreadFiles(
	streams: readonly { readonly content: string }[],
	codexHome: string,
): Promise<CodexThreadFiles> {
	const homes = [
		...new Set([codexHome, await realpath(codexHome).catch(() => codexHome)]),
	];
	const find = async (directory: string): Promise<readonly string[]> => {
		// What follows `<home>/<directory>/` at each occurrence, per id.
		const followers = new Map<string, string[]>();
		for (const home of homes) {
			const needle = `${home}/${directory}/`;
			for (const { content } of streams) {
				for (
					let index = content.indexOf(needle);
					index >= 0;
					index = content.indexOf(needle, index + needle.length)
				) {
					const rest = content.slice(
						index + needle.length,
						index + needle.length + 512,
					);
					const id = CODEX_DIRECTORY_SEGMENT.exec(rest)?.[0];
					if (id === undefined) continue;
					const list = followers.get(id) ?? [];
					if (list.length < 64) list.push(rest.slice(id.length + 1));
					followers.set(id, list);
				}
			}
		}
		const found: string[] = [];
		for (const [id, rests] of [...followers].sort(([left], [right]) =>
			left.localeCompare(right),
		)) {
			const names = (
				await readdir(join(codexHome, directory, id), {
					withFileTypes: true,
				}).catch(() => [])
			)
				.filter((entry) => entry.isFile())
				.map((entry) => entry.name)
				.sort();
			for (const name of names) {
				if (found.length >= CODEX_THREAD_MAX_FILES) return found;
				if (rests.some((rest) => rest.startsWith(name)))
					found.push(`${id}/${name}`);
			}
		}
		return found;
	};
	return {
		attachments: await find("attachments"),
		generatedImages: await find("generated_images"),
	};
}

// In-process answers, also negative ones; only positive answers persist.
const capabilityAnswers = new Map<string, Promise<boolean>>();

/**
 * Whether the server accepts `image` evidence objects: `cli.authStatus`
 * reports `capabilities.repositoryEvidenceImages`. An older server would
 * reject the whole capture, so it gets none (each image is skipped as
 * `server-unsupported`). Unreachable servers count as unsupported.
 */
export function supportsRepositoryEvidenceImages(
	rpcUrl: URL,
	authType: "api-key" | "bearer",
	token: string,
): Promise<boolean> {
	if (hasCachedEvidenceImagesCapability(rpcUrl, authType, token))
		return Promise.resolve(true);
	const key = `${rpcUrl.href}\u0000${authType}\u0000${token}`;
	const known = capabilityAnswers.get(key);
	if (known !== undefined) return known;
	const answer = (async () => {
		try {
			const status = await createRpcClient({
				authType,
				rpcUrl: rpcUrl.toString(),
				token,
			}).cli.authStatus(undefined, {
				signal: AbortSignal.timeout(PREFLIGHT_TIMEOUT_MS),
			});
			if (status.capabilities?.repositoryEvidenceImages !== true) return false;
			await rememberEvidenceImagesCapability(rpcUrl, authType, token);
			return true;
		} catch {
			return false;
		}
	})();
	capabilityAnswers.set(key, answer);
	return answer;
}
