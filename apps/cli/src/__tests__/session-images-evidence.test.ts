import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPendingRepositoryEvidence } from "../lib/repository-evidence-pending.js";
import {
	captureAndUploadSessionEvidence,
	retryPendingSessionEvidence,
} from "../lib/session-evidence.js";
import {
	deliverImageBacklog,
	hasImageBacklog,
} from "../lib/session-image-backlog.js";
import {
	type EvidenceProtocolStub,
	startEvidenceProtocolStub,
} from "./helpers/evidence-protocol-stub.js";

/**
 * Session images end to end against the evidence protocol simulator: inline
 * transcript images, MCP screenshots saved as tool results, images inline in
 * a saved output, pasted images in Claude Code's temporary session directory
 * and Codex thread files, with dedupe, deferral and an older server. All
 * bytes are synthetic.
 */

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const uid = process.getuid?.() ?? 0;

function png(seed: number, size = 128): Uint8Array {
	const bytes = new Uint8Array(size);
	bytes.set(PNG_SIGNATURE);
	for (let index = PNG_SIGNATURE.length; index < size; index += 1)
		bytes[index] = (seed * 17 + index) % 241;
	return bytes;
}

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function inlineRecord(image: Uint8Array, timestamp: string): string {
	return JSON.stringify({
		type: "user",
		timestamp,
		message: {
			role: "user",
			content: [
				{ type: "text", text: "What is on this screenshot?" },
				{
					type: "image",
					source: {
						type: "base64",
						media_type: "image/png",
						data: Buffer.from(image).toString("base64"),
					},
				},
			],
		},
	});
}

let home = "";
let stub: EvidenceProtocolStub;
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = [
	"OPALINE_CONFIG_DIR",
	"OPALINE_ALLOW_INSECURE_ENDPOINT",
	"CLAUDE_CODE_TMPDIR",
	"CODEX_HOME",
] as const;

beforeEach(async () => {
	home = await realpath(await mkdtemp(join(tmpdir(), "opaline-images-e2e-")));
	for (const key of ENV_KEYS) saved[key] = process.env[key];
	process.env.OPALINE_CONFIG_DIR = join(home, "config");
	process.env.OPALINE_ALLOW_INSECURE_ENDPOINT = "1";
	process.env.CLAUDE_CODE_TMPDIR = join(home, "tmp");
	process.env.CODEX_HOME = join(home, ".codex");
});

afterEach(async () => {
	stub?.stop();
	for (const key of ENV_KEYS)
		if (saved[key] === undefined) delete process.env[key];
		else process.env[key] = saved[key];
	await rm(home, { force: true, recursive: true });
});

function credentials() {
	return {
		authType: "api-key" as const,
		token: "test",
		apiBaseUrl: stub.base,
		user: { id: "user", email: "test@example.invalid", name: "Test" },
	};
}

async function createRepository(): Promise<string> {
	const repository = join(home, "repository");
	await mkdir(repository, { recursive: true });
	await writeFile(join(repository, "AGENTS.md"), "Instructions\n");
	execFileSync("git", ["init", "--quiet", repository]);
	return repository;
}

/**
 * A Claude Code session with an inline screenshot, an MCP screenshot and a
 * PDF saved as tool results, a saved output holding an image inline and a
 * pasted image in its temporary directory.
 */
async function createClaudeSession(sessionId: string, seed: number) {
	const repository = await createRepository();
	const projects = join(home, "projects", "-repo");
	const toolResults = join(projects, sessionId, "tool-results");
	const pasted = join(
		home,
		"tmp",
		`claude-${uid}`,
		"-repo",
		sessionId,
		"images",
	);
	await mkdir(toolResults, { recursive: true });
	await mkdir(pasted, { recursive: true });
	const images = {
		inline: png(seed),
		screenshot: png(seed + 1),
		savedInline: png(seed + 2),
		pasted: png(seed + 3),
	};
	const pdf = new TextEncoder().encode("%PDF-1.7\n\u0000synthetic");
	await writeFile(
		join(toolResults, "mcp-browser-blob-1.png"),
		images.screenshot,
	);
	await writeFile(join(toolResults, "mcp-docs-blob-2.pdf"), pdf);
	await writeFile(
		join(toolResults, "toolu_shot.json"),
		`${JSON.stringify([
			{ type: "text", text: "Captured" },
			{
				type: "image",
				mimeType: "image/png",
				data: Buffer.from(images.savedInline).toString("base64"),
			},
		])}\n`,
	);
	await writeFile(join(pasted, "1.png"), images.pasted);
	const transcriptPath = join(projects, `${sessionId}.jsonl`);
	await writeFile(
		transcriptPath,
		`${[
			inlineRecord(images.inline, "2026-10-16T10:00:00.000Z"),
			JSON.stringify({
				type: "user",
				timestamp: "2026-10-16T10:00:01.000Z",
				message: {
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: "toolu_shot",
							content: `Output saved to ${toolResults}/toolu_shot.json`,
						},
					],
				},
			}),
		].join("\n")}\n`,
	);
	return { images, pdf, repository, transcriptPath };
}

function claudeCapture(
	session: { readonly repository: string; readonly transcriptPath: string },
	sessionId: string,
	options: Partial<Parameters<typeof captureAndUploadSessionEvidence>[0]> = {},
) {
	return captureAndUploadSessionEvidence({
		backgroundDelivery: "none",
		credentials: credentials(),
		hookReceivedAt: new Date().toISOString(),
		lifecycle: "end",
		organizationId: "org",
		request: {
			kind: "file",
			metadata: {
				projectPath: session.repository,
				sessionId,
				source: "claude_code",
			},
			subagentDiscovery: { omittedCount: 0, reason: null, status: "complete" },
			subagents: [],
			transcriptPath: session.transcriptPath,
		},
		terminalTranscript: true,
		...options,
	});
}

function imageObjects(stub: EvidenceProtocolStub, contextId: string) {
	const committed = stub.committed.get(contextId);
	assert(committed);
	return committed.input.objects
		.filter((object) => object.kind === "image")
		.map((object) => [object.sha256, object.mediaType, object.filterVersion]);
}

describe("session images in repository evidence", () => {
	test("every source becomes an image object once; later captures list none again, and a repeat elsewhere is not uploaded", async () => {
		stub = startEvidenceProtocolStub();
		const sessionId = "images-session";
		const session = await createClaudeSession(sessionId, 1);
		const { images } = session;
		const first = await claudeCapture(session, sessionId);
		assert(first);
		const delivered = stub.committed.get(first.contextId);
		assert(delivered);
		expect(imageObjects(stub, first.contextId)).toEqual([
			[sha256(images.inline), "image/png", null],
			[sha256(images.savedInline), "image/png", null],
			[sha256(images.screenshot), "image/png", null],
			[sha256(images.pasted), "image/png", null],
		]);
		for (const image of Object.values(images)) {
			const stored = delivered.objects.get(`sha256:${sha256(image)}`);
			assert(stored);
			expect(Buffer.from(stored).equals(Buffer.from(image))).toBe(true);
		}
		const manifestImages = delivered.manifest.localContext.images;
		assert(manifestImages);
		expect(manifestImages.references).toEqual([
			{
				sha256: sha256(images.inline),
				mediaType: "image/png",
				bytes: images.inline.byteLength,
				source: "inline",
				agentId: null,
				recordIndex: 1,
			},
			{
				sha256: sha256(images.savedInline),
				mediaType: "image/png",
				bytes: images.savedInline.byteLength,
				source: "file",
				path: "toolu_shot.json",
				rootId: "claude-tool-results",
				agentId: null,
				recordIndex: null,
			},
			{
				sha256: sha256(images.screenshot),
				mediaType: "image/png",
				bytes: images.screenshot.byteLength,
				source: "file",
				path: "mcp-browser-blob-1.png",
				rootId: "claude-tool-results",
				agentId: null,
				recordIndex: null,
			},
			{
				sha256: sha256(images.pasted),
				mediaType: "image/png",
				bytes: images.pasted.byteLength,
				source: "file",
				path: "1.png",
				rootId: "claude-session-images",
				agentId: null,
				recordIndex: null,
			},
		]);
		// The PDF is not an image object: listed with its reason, never dropped.
		expect(manifestImages.skipped).toEqual([
			{ sha256: sha256(session.pdf), reason: "unsupported-media-type" },
		]);
		// The saved output's stored text has the marker, not the base64.
		const saved = delivered.manifest.localContext.entries.find(
			(entry) =>
				entry.rootId === "claude-tool-results" &&
				entry.path === "toolu_shot.json",
		);
		assert(saved?.content?.blobId);
		const savedText = new TextDecoder().decode(
			delivered.objects.get(saved.content.blobId),
		);
		expect(savedText).toContain(`sha256=${sha256(images.savedInline)}`);
		expect(savedText).not.toContain(
			Buffer.from(images.savedInline).toString("base64"),
		);
		// The transcript chunk keeps its exact bytes.
		const chunk = delivered.input.objects.find(
			(object) => object.kind === "transcript-chunk",
		);
		assert(chunk);
		expect(
			new TextDecoder().decode(delivered.objects.get(chunk.objectId)),
		).toContain(Buffer.from(images.inline).toString("base64"));
		expect(await hasImageBacklog(join(home, "config"))).toBe(false);

		// A later capture of the session: the confirmed images are not listed.
		const uploads = stub.uploadedObjectIds.length;
		const second = await claudeCapture(session, sessionId, {
			captureReason: "task-output-sweep",
			lifecycle: "checkpoint",
			requireDeliveredTranscript: true,
		});
		assert(second);
		expect(imageObjects(stub, second.contextId)).toEqual([]);
		const continued = stub.committed.get(second.contextId);
		expect(continued?.manifest.localContext.images?.references ?? []).toEqual(
			[],
		);
		expect(
			stub.uploadedObjectIds
				.slice(uploads)
				.filter((id) =>
					Object.values(images).some(
						(image) => id === `sha256:${sha256(image)}`,
					),
				),
		).toEqual([]);

		// Another session with the same screenshot declares it, and the
		// server, which has it, does not ask for its bytes again.
		const otherId = "other-session";
		const other = await createClaudeSession(otherId, 1);
		const before = stub.uploadedObjectIds.length;
		const third = await claudeCapture(other, otherId);
		assert(third);
		expect(imageObjects(stub, third.contextId)).toHaveLength(4);
		expect(
			stub.uploadedObjectIds
				.slice(before)
				.filter((id) => id === `sha256:${sha256(images.screenshot)}`),
		).toEqual([]);
		expect(
			stub.uploadedObjectIds.filter(
				(id) => id === `sha256:${sha256(images.screenshot)}`,
			),
		).toHaveLength(1);
	}, 60_000);

	test("images over a capture's budget wait in the backlog and a follow-up capture delivers them, sending no transcript byte again", async () => {
		stub = startEvidenceProtocolStub();
		const sessionId = "backlog-session";
		const session = await createClaudeSession(sessionId, 20);
		const configDir = join(home, "config");
		// The follow-up applies the hooks' gates: the folder is bound to the
		// workspace.
		await mkdir(configDir, { recursive: true });
		await writeFile(
			join(configDir, "projects.json"),
			JSON.stringify({
				projects: { [session.repository]: { organizationId: "org" } },
			}),
		);
		const limits = { maxObjectsPerCapture: 2 };
		// A capture spooled and delivered later carries its images too.
		await expect(
			claudeCapture(session, sessionId, {
				hookReceivedAt: new Date(Date.now() - 120_000).toISOString(),
				imageLimits: limits,
			}),
		).rejects.toThrow();
		const [pending] = await readPendingRepositoryEvidence(configDir);
		assert(pending);
		expect(
			pending.upload.input.objects.filter((object) => object.kind === "image"),
		).toHaveLength(2);
		expect(await hasImageBacklog(configDir)).toBe(true);
		// The backlog waits while the session's capture is pending.
		const waiting = await deliverImageBacklog({
			capture: () => Promise.reject(new Error("must wait")),
			configDir,
			credentials: credentials(),
		});
		expect(waiting).toMatchObject({ waiting: 1, captured: 0 });
		expect(await retryPendingSessionEvidence(credentials())).toBe(1);
		const [firstCommit] = [...stub.committed.values()];
		assert(firstCommit);
		expect(firstCommit.manifest.localContext.images?.skipped).toEqual(
			expect.arrayContaining([
				{ sha256: sha256(session.images.screenshot), reason: "deferred" },
				{ sha256: sha256(session.images.pasted), reason: "deferred" },
			]),
		);
		// Follow-ups through the deliverer's backlog step until none remain.
		const warnings: string[] = [];
		for (let run = 0; run < 3 && (await hasImageBacklog(configDir)); run += 1)
			await deliverImageBacklog({
				capture: (input) =>
					captureAndUploadSessionEvidence({ ...input, imageLimits: limits }),
				configDir,
				credentials: credentials(),
				onWarning: (warning) => warnings.push(warning),
			});
		expect(warnings).toEqual([]);
		expect(await hasImageBacklog(configDir)).toBe(false);
		const commits = [...stub.committed.values()];
		expect(commits).toHaveLength(2);
		const followUp = commits[1];
		assert(followUp);
		expect(followUp.manifest.localContext.captureReason).toBe("image-backlog");
		expect(
			followUp.input.objects.filter(
				(object) => object.kind === "transcript-chunk",
			),
		).toEqual([]);
		expect(
			followUp.input.objects
				.filter((object) => object.kind === "image")
				.map((object) => object.sha256)
				.sort(),
		).toEqual(
			[sha256(session.images.screenshot), sha256(session.images.pasted)].sort(),
		);
		const all = commits.flatMap((commit) =>
			commit.input.objects
				.filter((object) => object.kind === "image")
				.map((object) => object.sha256),
		);
		expect(new Set(all).size).toBe(4);
		expect(all).toHaveLength(4);
	}, 60_000);

	test("a server without image objects gets none, and the capture is still accepted", async () => {
		stub = startEvidenceProtocolStub({ withoutImageCapability: true });
		const sessionId = "older-server";
		const session = await createClaudeSession(sessionId, 40);
		const receipt = await claudeCapture(session, sessionId);
		assert(receipt);
		expect(imageObjects(stub, receipt.contextId)).toEqual([]);
		const images = stub.committed.get(receipt.contextId)?.manifest.localContext
			.images;
		expect(images?.skipped.map((item) => item.reason).sort()).toEqual([
			"server-unsupported",
			"server-unsupported",
			"server-unsupported",
			"server-unsupported",
			"unsupported-media-type",
		]);
		expect(await hasImageBacklog(join(home, "config"))).toBe(false);
	}, 60_000);

	test("a Codex thread's generated images and attachments it names are captured; other threads' are not", async () => {
		stub = startEvidenceProtocolStub();
		const repository = await createRepository();
		const codexHome = join(home, ".codex");
		const threadId = "019f64f7-03fd-7aa2-b210-e606f70c601d";
		const generatedDirectory = join(codexHome, "generated_images", threadId);
		const attachmentDirectory = join(
			codexHome,
			"attachments",
			"3f25b0b7-beed-4b8b-bf96-e831d2a92a9d",
		);
		await mkdir(generatedDirectory, { recursive: true });
		await mkdir(attachmentDirectory, { recursive: true });
		const generated = png(60);
		const unrelated = png(61);
		const pastedImage = png(62);
		await writeFile(join(generatedDirectory, "exec-1.png"), generated);
		await writeFile(join(generatedDirectory, "exec-2.png"), unrelated);
		await writeFile(join(attachmentDirectory, "Pasted image.png"), pastedImage);
		await writeFile(
			join(attachmentDirectory, "pasted-text.txt"),
			"pasted notes\n",
		);
		const inline = png(63);
		const content = `${[
			JSON.stringify({ type: "session_meta", payload: { id: threadId } }),
			JSON.stringify({
				type: "response_item",
				payload: {
					type: "message",
					role: "user",
					content: [
						{
							type: "input_text",
							text: `see ${attachmentDirectory}/Pasted image.png and ${attachmentDirectory}/pasted-text.txt`,
						},
						{
							type: "input_image",
							image_url: `data:image/png;base64,${Buffer.from(inline).toString("base64")}`,
						},
					],
				},
			}),
			JSON.stringify({
				type: "event_msg",
				payload: { saved_path: `${generatedDirectory}/exec-1.png` },
			}),
		].join("\n")}\n`;
		const receipt = await captureAndUploadSessionEvidence({
			backgroundDelivery: "none",
			credentials: credentials(),
			hookReceivedAt: new Date().toISOString(),
			lifecycle: "checkpoint",
			organizationId: "org",
			request: {
				content,
				projectPath: repository,
				sessionId: threadId,
				source: "codex",
				upload_mode: "hook",
			},
			terminalTranscript: false,
		});
		assert(receipt);
		expect(imageObjects(stub, receipt.contextId).map(([hash]) => hash)).toEqual(
			[sha256(inline), sha256(pastedImage), sha256(generated)],
		);
		const committed = stub.committed.get(receipt.contextId);
		assert(committed);
		const references = committed.manifest.localContext.images?.references;
		expect(
			references?.map((reference) => [
				reference.source,
				reference.rootId,
				reference.path,
				reference.recordIndex,
			]),
		).toEqual([
			["inline", undefined, undefined, 2],
			[
				"file",
				"codex-attachments",
				"3f25b0b7-beed-4b8b-bf96-e831d2a92a9d/Pasted image.png",
				null,
			],
			["file", "codex-generated-images", `${threadId}/exec-1.png`, null],
		]);
		// The text attachment is captured as text; the unnamed image is not
		// part of this thread.
		const text = committed.manifest.localContext.entries.find(
			(entry) =>
				entry.rootId === "codex-attachments" &&
				entry.path.endsWith("pasted-text.txt"),
		);
		assert(text?.content?.blobId);
		expect(
			new TextDecoder().decode(committed.objects.get(text.content.blobId)),
		).toBe("pasted notes\n");
		expect(
			committed.manifest.localContext.entries.some((entry) =>
				entry.path.endsWith("exec-2.png"),
			),
		).toBe(false);
		expect(
			[...committed.objects.keys()].includes(`sha256:${sha256(unrelated)}`),
		).toBe(false);
	}, 60_000);
});
