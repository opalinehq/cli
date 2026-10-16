import { afterAll, describe, expect, test } from "bun:test";
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RepositoryEvidenceObjectDescriptorSchema } from "../contracts/repository-evidence.js";
import {
	CLAUDE_SESSION_IMAGES_ROOT_ID,
	CLAUDE_TOOL_RESULTS_ROOT_ID,
	SESSION_TOOL_RESULT_MAX_FILE_BYTES,
} from "../internal/local-context-source/capture-policy.js";
import {
	collectLocalContextBundle,
	createLocalContextSourceEnv,
	getDefaultLocalContextCollectionOptions,
} from "../internal/local-context-source/index.js";
import { resolveClaudeSessionImagesDirectory } from "../lib/claude-task-outputs.js";
import {
	deliverImageBacklog,
	hasImageBacklog,
	IMAGE_BACKLOG_MAX_FOLLOW_UPS,
	type ImageBacklogItem,
	readImageBacklogItem,
	writeImageBacklogItem,
} from "../lib/session-image-backlog.js";
import {
	DELIVERED_IMAGE_LEDGER_MAX_ENTRIES,
	readDeliveredImages,
	recordDeliveredImages,
} from "../lib/session-image-ledger.js";
import {
	createArtifactImageCollector,
	findCodexThreadFiles,
	planSessionImages,
	SESSION_IMAGES_MAX_REFERENCES,
	sniffMediaType,
} from "../lib/session-images.js";
import {
	extractInlineImagesFromLine,
	INLINE_IMAGE_MARKER_PREFIX,
	stripInlineImagesFromLine,
} from "../lib/transcript-slim.js";
import {
	readUserAgentSources,
	resolveUserContextRoots,
} from "../lib/user-context.js";

const directories: string[] = [];
afterAll(async () => {
	for (const directory of directories)
		await rm(directory, { force: true, recursive: true });
});

async function createDirectory(): Promise<string> {
	const directory = await realpath(
		await mkdtemp(join(tmpdir(), "opaline-session-images-")),
	);
	directories.push(directory);
	return directory;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Synthetic image bytes: a real signature, then a pattern from `seed`. */
function png(seed: number, size = 96): Uint8Array {
	const bytes = new Uint8Array(size);
	bytes.set(PNG_SIGNATURE);
	for (let index = PNG_SIGNATURE.length; index < size; index += 1)
		bytes[index] = (seed * 31 + index) % 251;
	return bytes;
}

function jpeg(seed: number): Uint8Array {
	const bytes = png(seed);
	bytes.set([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
	return bytes;
}

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function base64(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("base64");
}

const supported = () => Promise.resolve(true);
const unbounded = { maxBytes: 1024 * 1024, maxObjects: 64 };

describe("inline image extraction", () => {
	const image = png(1);
	const payload = base64(image);
	const lines: Record<string, unknown> = {
		"Claude base64 source": {
			type: "user",
			message: {
				role: "user",
				content: [
					{
						type: "image",
						source: { type: "base64", media_type: "image/png", data: payload },
					},
				],
			},
		},
		"MCP image content": {
			type: "user",
			message: {
				content: [
					{
						type: "tool_result",
						tool_use_id: "toolu_1",
						content: [{ type: "image", mimeType: "image/png", data: payload }],
					},
				],
			},
		},
		"Read image result": {
			type: "user",
			toolUseResult: {
				type: "image",
				file: { type: "image/png", base64: payload },
			},
		},
		"Codex image_url data URL": {
			type: "response_item",
			payload: {
				type: "message",
				content: [
					{
						type: "input_image",
						image_url: `data:image/png;base64,${payload}`,
					},
				],
			},
		},
		"data URL in image_url.url": {
			type: "event_msg",
			payload: { image_url: { url: `data:image/png;base64,${payload}` } },
		},
		"JSON-encoded tool output": {
			type: "user",
			message: {
				content: [
					{
						type: "tool_result",
						tool_use_id: "toolu_2",
						content: JSON.stringify([
							{ type: "image", mimeType: "image/png", data: payload },
						]),
					},
				],
			},
		},
	};
	for (const [name, record] of Object.entries(lines)) {
		test(`${name}: the decoded bytes behind the marker`, () => {
			const line = JSON.stringify(record);
			const images = extractInlineImagesFromLine(line);
			expect(images).toHaveLength(1);
			const [found] = images;
			assert(found);
			expect(found.sha256).toBe(sha256(image));
			expect(found.mediaType).toBe("image/png");
			expect(Buffer.from(found.bytes).equals(Buffer.from(image))).toBe(true);
			const stripped = stripInlineImagesFromLine(line);
			expect(stripped).toContain(
				`${INLINE_IMAGE_MARKER_PREFIX}sha256=${found.sha256};bytes=${image.byteLength};type=image/png`,
			);
		});
	}

	test("an image the slimming keeps (in longer text) is not extracted", () => {
		const line = JSON.stringify({
			type: "user",
			message: {
				content: `see <img src="data:image/png;base64,${payload}"> here`,
			},
		});
		expect(stripInlineImagesFromLine(line)).toBe(line);
		expect(extractInlineImagesFromLine(line)).toEqual([]);
	});

	test("one entry per image, in marker order", () => {
		const other = png(2);
		const line = JSON.stringify({
			content: [
				{ type: "image", mimeType: "image/png", data: base64(other) },
				{ type: "image", mimeType: "image/png", data: payload },
				{ type: "image", mimeType: "image/png", data: base64(other) },
			],
		});
		expect(
			extractInlineImagesFromLine(line).map((item) => item.sha256),
		).toEqual([sha256(other), sha256(image)]);
	});
});

describe("planning a capture's images", () => {
	const record = (images: Uint8Array[]) =>
		JSON.stringify({
			type: "user",
			message: {
				content: images.map((bytes) => ({
					type: "image",
					source: {
						type: "base64",
						media_type: "image/png",
						data: base64(bytes),
					},
				})),
			},
		});

	test("one object per image, a reference per record, and children by stream", async () => {
		const [first, second] = [png(1), png(2)];
		const planned = await planSessionImages({
			streams: [
				{
					agentId: null,
					content: `${record([first])}\n{"type":"assistant"}\n${record([first, second])}\n`,
				},
				{ agentId: "agent-1", content: `${record([second])}\n` },
			],
			files: [],
			delivered: new Set(),
			isSupported: supported,
			...unbounded,
		});
		expect(planned.objects.map((object) => object.sha256)).toEqual([
			sha256(first),
			sha256(second),
		]);
		expect(
			planned.manifest.references.map((reference) => [
				reference.sha256,
				reference.agentId,
				reference.recordIndex,
				reference.source,
			]),
		).toEqual([
			[sha256(first), null, 1, "inline"],
			[sha256(first), null, 3, "inline"],
			[sha256(second), null, 3, "inline"],
			[sha256(second), "agent-1", 1, "inline"],
		]);
		expect(planned.manifest.skipped).toEqual([]);
		expect(planned.deferred).toBe(0);
	});

	test("an image a commit confirmed for the session is not listed again", async () => {
		const [first, second] = [png(1), png(2)];
		const planned = await planSessionImages({
			streams: [{ agentId: null, content: `${record([first, second])}\n` }],
			files: [],
			delivered: new Set([sha256(first)]),
			isSupported: supported,
			...unbounded,
		});
		expect(planned.objects.map((object) => object.sha256)).toEqual([
			sha256(second),
		]);
		expect(
			planned.manifest.references.map((reference) => reference.sha256),
		).toEqual([sha256(second)]);
	});

	test("images over the byte or object budget are deferred, never dropped", async () => {
		const images = [png(1), png(2), png(3)];
		const byObjects = await planSessionImages({
			streams: [{ agentId: null, content: `${record(images)}\n` }],
			files: [],
			delivered: new Set(),
			isSupported: supported,
			maxBytes: 1024 * 1024,
			maxObjects: 2,
		});
		expect(byObjects.objects).toHaveLength(2);
		expect(byObjects.manifest.skipped).toEqual([
			{ sha256: sha256(images[2] ?? png(0)), reason: "deferred" },
		]);
		expect(byObjects.deferred).toBe(1);
		// Its record is still named, so the server knows where it was.
		expect(byObjects.manifest.references).toHaveLength(3);
		const byBytes = await planSessionImages({
			streams: [{ agentId: null, content: `${record(images)}\n` }],
			files: [],
			delivered: new Set(),
			isSupported: supported,
			maxBytes: 96 * 2,
			maxObjects: 64,
		});
		expect(byBytes.objects).toHaveLength(2);
		expect(byBytes.deferred).toBe(1);
	});

	test("an image larger than one object may be is skipped as too large", async () => {
		const large = png(1, 512);
		const planned = await planSessionImages({
			streams: [{ agentId: null, content: `${record([large, png(2)])}\n` }],
			files: [],
			delivered: new Set(),
			isSupported: supported,
			maxImageBytes: 256,
			...unbounded,
		});
		expect(planned.objects.map((object) => object.sha256)).toEqual([
			sha256(png(2)),
		]);
		expect(planned.manifest.skipped).toEqual([
			{ sha256: sha256(large), reason: "too-large" },
		]);
		expect(planned.deferred).toBe(0);
	});

	test("a server without image objects gets none, and nothing is left for later", async () => {
		let asked = 0;
		const planned = await planSessionImages({
			streams: [{ agentId: null, content: `${record([png(1), png(2)])}\n` }],
			files: [],
			delivered: new Set(),
			isSupported: () => {
				asked += 1;
				return Promise.resolve(false);
			},
			maxBytes: 1024 * 1024,
			maxObjects: 1,
		});
		expect(asked).toBe(1);
		expect(planned.objects).toEqual([]);
		expect(planned.manifest.skipped.map((item) => item.reason)).toEqual([
			"server-unsupported",
			"server-unsupported",
		]);
		expect(planned.deferred).toBe(0);
	});

	test("the server is not asked when there is nothing to upload", async () => {
		const planned = await planSessionImages({
			streams: [{ agentId: null, content: '{"type":"user"}\n' }],
			files: [],
			delivered: new Set(),
			isSupported: () => Promise.reject(new Error("asked")),
			...unbounded,
		});
		expect(planned.manifest).toEqual({
			references: [],
			omitted: 0,
			skipped: [],
		});
	});

	test("references beyond the manifest bound are counted, not listed", async () => {
		const image = png(1);
		const content = `${Array.from(
			{ length: SESSION_IMAGES_MAX_REFERENCES + 3 },
			() => record([image]),
		).join("\n")}\n`;
		const planned = await planSessionImages({
			streams: [{ agentId: null, content }],
			files: [],
			delivered: new Set(),
			isSupported: supported,
			...unbounded,
		});
		expect(planned.manifest.references).toHaveLength(
			SESSION_IMAGES_MAX_REFERENCES,
		);
		expect(planned.manifest.omitted).toBe(3);
		expect(planned.objects).toHaveLength(1);
	});

	test("image files: by signature, regular files only; other binaries are listed as not uploaded", async () => {
		const directory = await createDirectory();
		const screenshot = png(5);
		const photo = jpeg(6);
		const pdf = new TextEncoder().encode("%PDF-1.7\n\u0000binary");
		await writeFile(join(directory, "mcp-browser-blob-1.png"), screenshot);
		await writeFile(join(directory, "renamed.dat"), photo);
		await writeFile(join(directory, "mcp-docs-blob-2.pdf"), pdf);
		await writeFile(join(directory, "toolu_1.txt"), "plain saved output\n");
		await writeFile(join(directory, "archive.bin"), new Uint8Array([1, 0, 2]));
		await symlink(
			join(directory, "mcp-browser-blob-1.png"),
			join(directory, "link.png"),
		);
		const planned = await planSessionImages({
			streams: [],
			files: [
				{
					rootId: CLAUDE_TOOL_RESULTS_ROOT_ID,
					directory,
					paths: "listing",
				},
			],
			delivered: new Set(),
			isSupported: supported,
			...unbounded,
		});
		expect(
			planned.objects.map((object) => [object.sha256, object.mediaType]),
		).toEqual([
			[sha256(screenshot), "image/png"],
			[sha256(photo), "image/jpeg"],
		]);
		expect(planned.manifest.references).toEqual([
			{
				sha256: sha256(screenshot),
				mediaType: "image/png",
				bytes: screenshot.byteLength,
				source: "file",
				path: "mcp-browser-blob-1.png",
				rootId: CLAUDE_TOOL_RESULTS_ROOT_ID,
				agentId: null,
				recordIndex: null,
			},
			{
				sha256: sha256(photo),
				mediaType: "image/jpeg",
				bytes: photo.byteLength,
				source: "file",
				path: "renamed.dat",
				rootId: CLAUDE_TOOL_RESULTS_ROOT_ID,
				agentId: null,
				recordIndex: null,
			},
		]);
		expect(planned.manifest.skipped).toEqual([
			{
				sha256: sha256(new Uint8Array([1, 0, 2])),
				reason: "unsupported-media-type",
			},
			{ sha256: sha256(pdf), reason: "unsupported-media-type" },
		]);
	});

	test("an image file over the bound is hashed and named, not read", async () => {
		const directory = await createDirectory();
		const large = png(7, 4096);
		await writeFile(join(directory, "1.png"), large);
		const planned = await planSessionImages({
			streams: [],
			files: [
				{ rootId: CLAUDE_SESSION_IMAGES_ROOT_ID, directory, paths: "listing" },
			],
			delivered: new Set(),
			isSupported: supported,
			maxImageBytes: 1024,
			...unbounded,
		});
		expect(planned.objects).toEqual([]);
		expect(planned.manifest.references[0]?.path).toBe("1.png");
		expect(planned.manifest.skipped).toEqual([
			{ sha256: sha256(large), reason: "too-large" },
		]);
	});

	test("images inline in saved outputs are named by their file, whose text keeps the marker", async () => {
		const collector = createArtifactImageCollector();
		const image = png(8);
		const saved = JSON.stringify([
			{ type: "text", text: "Screenshot taken" },
			{ type: "image", mimeType: "image/png", data: base64(image) },
		]);
		const stored = collector.transform(`${saved}\n`, {
			rootId: CLAUDE_TOOL_RESULTS_ROOT_ID,
			path: "toolu_9.json",
		});
		expect(stored).toContain(`sha256=${sha256(image)}`);
		expect(stored).not.toContain(base64(image));
		const planned = await planSessionImages({
			streams: [],
			artifacts: collector,
			files: [],
			delivered: new Set(),
			isSupported: supported,
			...unbounded,
		});
		expect(planned.objects.map((object) => object.sha256)).toEqual([
			sha256(image),
		]);
		expect(planned.manifest.references).toEqual([
			{
				sha256: sha256(image),
				mediaType: "image/png",
				bytes: image.byteLength,
				source: "file",
				path: "toolu_9.json",
				rootId: CLAUDE_TOOL_RESULTS_ROOT_ID,
				agentId: null,
				recordIndex: null,
			},
		]);
	});

	test("signatures", () => {
		expect(sniffMediaType(png(1))).toBe("image/png");
		expect(sniffMediaType(jpeg(1))).toBe("image/jpeg");
		expect(sniffMediaType(new TextEncoder().encode("GIF89a......"))).toBe(
			"image/gif",
		);
		expect(
			sniffMediaType(
				new TextEncoder().encode("RIFF\u0000\u0000\u0000\u0000WEBPVP8 "),
			),
		).toBe("image/webp");
		expect(
			sniffMediaType(
				new TextEncoder().encode("\u0000\u0000\u0000\u001cftypavif"),
			),
		).toBe("image/avif");
		expect(sniffMediaType(new TextEncoder().encode("%PDF-1.4"))).toBe(
			"application/pdf",
		);
		expect(sniffMediaType(new TextEncoder().encode("<svg xmlns="))).toBeNull();
	});

	test("image objects pass the evidence contract: raw image/* bytes up to 32 MiB", () => {
		const image = png(1);
		const descriptor = (overrides: Record<string, unknown> = {}) => ({
			byteLength: image.byteLength,
			contentEncoding: "identity",
			filterVersion: null,
			kind: "image",
			mediaType: "image/png",
			objectId: `sha256:${sha256(image)}`,
			sha256: sha256(image),
			...overrides,
		});
		const parse = (overrides?: Record<string, unknown>) =>
			RepositoryEvidenceObjectDescriptorSchema.safeParse(descriptor(overrides))
				.success;
		expect(parse()).toBe(true);
		expect(parse({ mediaType: "application/pdf" })).toBe(false);
		expect(parse({ contentEncoding: "gzip" })).toBe(false);
		expect(parse({ byteLength: 32 * 1024 * 1024 + 1 })).toBe(false);
	});
});

describe("Codex thread files", () => {
	test("only files the rollout names by their full path, names with spaces included", async () => {
		const codexHome = await createDirectory();
		const attachment = join(
			codexHome,
			"attachments",
			"3f25b0b7-beed-4b8b-bf96-e831d2a92a9d",
		);
		const generated = join(
			codexHome,
			"generated_images",
			"019f64f7-03fd-7aa2-b210-e606f70c601d",
		);
		await mkdir(attachment, { recursive: true });
		await mkdir(generated, { recursive: true });
		await writeFile(join(attachment, "Pasted image 1.png"), png(1));
		await writeFile(join(attachment, "Pasted image 2.png"), png(2));
		await writeFile(join(generated, "exec-1.png"), png(3));
		await writeFile(join(generated, "exec-2.png"), png(4));
		await mkdir(join(codexHome, "attachments", "unnamed"), { recursive: true });
		await writeFile(join(codexHome, "attachments", "unnamed", "x.png"), png(5));
		const content = [
			JSON.stringify({
				type: "response_item",
				payload: {
					type: "message",
					content: [
						{
							type: "input_text",
							text: `look at ${attachment}/Pasted image 1.png please`,
						},
					],
				},
			}),
			JSON.stringify({
				type: "event_msg",
				payload: { saved_path: `${generated}/exec-2.png` },
			}),
		].join("\n");
		expect(await findCodexThreadFiles([{ content }], codexHome)).toEqual({
			attachments: ["3f25b0b7-beed-4b8b-bf96-e831d2a92a9d/Pasted image 1.png"],
			generatedImages: ["019f64f7-03fd-7aa2-b210-e606f70c601d/exec-2.png"],
		});
		expect(await findCodexThreadFiles([{ content: "" }], codexHome)).toEqual({
			attachments: [],
			generatedImages: [],
		});
	});
});

describe("delivered image ledger", () => {
	const scope = {
		endpoint: "https://api.example.invalid/rpc",
		organizationId: "org",
		source: "claude_code",
		sessionId: "session-1",
	};

	test("is kept per session and bounded", async () => {
		const configDir = await createDirectory();
		await recordDeliveredImages(configDir, scope, ["a".repeat(64), "not-hex"]);
		await recordDeliveredImages(configDir, scope, [
			"a".repeat(64),
			"b".repeat(64),
		]);
		expect([...(await readDeliveredImages(configDir, scope))]).toEqual([
			"a".repeat(64),
			"b".repeat(64),
		]);
		expect(
			(await readDeliveredImages(configDir, { ...scope, sessionId: "other" }))
				.size,
		).toBe(0);
		const many = Array.from(
			{ length: DELIVERED_IMAGE_LEDGER_MAX_ENTRIES },
			(_, index) => createHash("sha256").update(String(index)).digest("hex"),
		);
		await recordDeliveredImages(configDir, scope, many);
		const kept = await readDeliveredImages(configDir, scope);
		expect(kept.size).toBeLessThan(DELIVERED_IMAGE_LEDGER_MAX_ENTRIES);
		expect(kept.has(many.at(-1) ?? "")).toBe(true);
		expect(kept.has("a".repeat(64))).toBe(false);
	});
});

describe("image backlog", () => {
	const credentials = {
		apiBaseUrl: "https://api.example.invalid",
		authType: "api-key" as const,
		token: "test",
		user: { id: "user-1", email: "test@example.invalid", name: "Test" },
	};

	async function item(
		configDir: string,
		overrides: Partial<ImageBacklogItem> = {},
	): Promise<ImageBacklogItem> {
		const home = await createDirectory();
		const transcriptPath = join(home, "session-1.jsonl");
		await writeFile(transcriptPath, "{}\n");
		const value: ImageBacklogItem = {
			version: 1,
			endpoint: "https://api.example.invalid/rpc",
			organizationId: "org",
			actorId: "user-1",
			source: "claude_code",
			sessionId: "session-1",
			transcriptPath,
			projectPath: home,
			followUps: 0,
			deferred: 2,
			updatedAt: new Date().toISOString(),
			...overrides,
		};
		await writeImageBacklogItem(configDir, value);
		return value;
	}

	test("an item past its follow-up bound is dropped with a warning, not captured", async () => {
		const configDir = await createDirectory();
		const value = await item(configDir, {
			followUps: IMAGE_BACKLOG_MAX_FOLLOW_UPS,
		});
		const warnings: string[] = [];
		const result = await deliverImageBacklog({
			capture: () => Promise.reject(new Error("must not capture")),
			configDir,
			credentials,
			onWarning: (warning) => warnings.push(warning),
		});
		expect(result.removed).toBe(1);
		expect(result.captured).toBe(0);
		expect(await readImageBacklogItem(configDir, value)).toBeUndefined();
		expect(await hasImageBacklog(configDir)).toBe(false);
		expect(warnings.join("\n")).toContain("stay listed as deferred");
	});

	test("an item without a delivered transcript to continue is dropped", async () => {
		const configDir = await createDirectory();
		const previous = process.env.OPALINE_CONFIG_DIR;
		process.env.OPALINE_CONFIG_DIR = configDir;
		try {
			const value = await item(configDir);
			execFileSync("git", ["init", "--quiet", value.projectPath]);
			await writeFile(
				join(configDir, "projects.json"),
				JSON.stringify({
					projects: { [value.projectPath]: { organizationId: "org" } },
				}),
			);
			const result = await deliverImageBacklog({
				capture: () => Promise.reject(new Error("must not capture")),
				configDir,
				credentials,
			});
			expect(result).toMatchObject({ captured: 0, removed: 1, failed: 0 });
			expect(await hasImageBacklog(configDir)).toBe(false);
		} finally {
			if (previous === undefined) delete process.env.OPALINE_CONFIG_DIR;
			else process.env.OPALINE_CONFIG_DIR = previous;
		}
	});

	test("another user's or endpoint's items are left alone", async () => {
		const configDir = await createDirectory();
		await item(configDir, { actorId: "someone-else" });
		const result = await deliverImageBacklog({
			capture: () => Promise.reject(new Error("must not capture")),
			configDir,
			credentials,
		});
		expect(result).toMatchObject({ captured: 0, removed: 0 });
		expect(await hasImageBacklog(configDir)).toBe(true);
	});
});

describe("capture roots and saved output caps", () => {
	test("the Claude session's images directory is located like its tasks directory", async () => {
		const home = await createDirectory();
		const uid = process.getuid?.() ?? 0;
		const sessionId = "1077056d-be5a-4927-8cce-10a029a84982";
		const images = join(
			home,
			"tmp",
			`claude-${uid}`,
			"-repo",
			sessionId,
			"images",
		);
		await mkdir(images, { recursive: true });
		expect(
			await resolveClaudeSessionImagesDirectory({
				sessionId,
				streams: [],
				transcriptPath: join(home, "projects", "-repo", `${sessionId}.jsonl`),
				env: { CLAUDE_CODE_TMPDIR: join(home, "tmp") },
			}),
		).toBe(images);
		// A pasted image's path in the transcript names the directory too.
		const elsewhere = join(
			home,
			"other",
			`claude-${uid}`,
			"-moved",
			sessionId,
			"images",
		);
		await mkdir(elsewhere, { recursive: true });
		expect(
			await resolveClaudeSessionImagesDirectory({
				sessionId,
				streams: [
					{
						agentId: null,
						content: JSON.stringify({
							text: `[Image: source: ${elsewhere}/1.png]`,
						}),
					},
				],
				transcriptPath: join(home, "projects", "-repo", `${sessionId}.jsonl`),
				env: { CLAUDE_CODE_TMPDIR: join(home, "other") },
			}),
		).toBe(elsewhere);
	});

	test("an oversized saved output is slimmed whole, keeps its head and records the truncation", async () => {
		const home = await createDirectory();
		const repository = join(home, "repo");
		const toolResults = join(home, "tool-results");
		const images = join(home, "images");
		await mkdir(repository, { recursive: true });
		await mkdir(toolResults, { recursive: true });
		await mkdir(images, { recursive: true });
		execFileSync("git", ["init", "-q"], { cwd: repository });
		const image = png(9, 4096);
		const imageLine = JSON.stringify([
			{ type: "image", mimeType: "image/png", data: base64(image) },
		]);
		const line = "build output line ✓\n";
		const filler = line.repeat(
			Math.ceil((SESSION_TOOL_RESULT_MAX_FILE_BYTES * 1.25) / line.length),
		);
		const original = `${imageLine}\n${filler}`;
		await writeFile(join(toolResults, "toolu_big.txt"), original);
		await writeFile(join(images, "1.png"), image);
		const locations = { home, codexHome: join(home, ".codex") };
		const repositoryRoot = await realpath(repository);
		const collector = createArtifactImageCollector();
		const bundle = await collectLocalContextBundle(
			repositoryRoot,
			{
				...getDefaultLocalContextCollectionOptions(),
				additionalRoots: await resolveUserContextRoots({
					locations,
					repositoryRoot,
					sources: await readUserAgentSources(locations, repositoryRoot),
					toolResultsDirectory: toolResults,
					sessionImagesDirectory: images,
				}),
				capturePolicy: "session-evidence",
				transformToolResultText: collector.transform,
			},
			createLocalContextSourceEnv(),
		);
		const entry = bundle.manifest.entries.find(
			(candidate) =>
				candidate.rootId === CLAUDE_TOOL_RESULTS_ROOT_ID &&
				candidate.path === "toolu_big.txt",
		);
		assert(entry?.kind === "file" && entry.content.status === "available");
		expect(entry.content.truncation).toEqual({
			kept: "head",
			originalByteLength: Buffer.byteLength(original),
		});
		const blobId = entry.content.blobId;
		const text = bundle.blobs.find((blob) => blob.id === blobId)?.content ?? "";
		expect(Buffer.byteLength(text)).toBeLessThanOrEqual(
			SESSION_TOOL_RESULT_MAX_FILE_BYTES,
		);
		expect(
			text.startsWith(
				`[{"type":"image","mimeType":"image/png","data":"${INLINE_IMAGE_MARKER_PREFIX}`,
			),
		).toBe(true);
		expect(text.endsWith(line)).toBe(true);
		// The pasted image is inventoried (hash only) in its own root.
		const pasted = bundle.manifest.entries.find(
			(candidate) =>
				candidate.rootId === CLAUDE_SESSION_IMAGES_ROOT_ID &&
				candidate.path === "1.png",
		);
		assert(pasted?.kind === "file");
		expect(pasted.hash).toMatchObject({
			status: "available",
			value: sha256(image),
		});
		const planned = await planSessionImages({
			streams: [],
			artifacts: collector,
			files: [],
			delivered: new Set(),
			isSupported: supported,
			...unbounded,
		});
		expect(planned.objects.map((object) => object.sha256)).toEqual([
			sha256(image),
		]);
		expect(await readFile(join(images, "1.png"))).toEqual(Buffer.from(image));
	});
});
