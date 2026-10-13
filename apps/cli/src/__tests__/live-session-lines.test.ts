import { expect, test } from "bun:test";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	isLiveSessionsDisabledByEnvironment,
	resolveAgentPid,
} from "../lib/live-session-launch.js";
import {
	hashLiveSessionLine,
	processLiveSessionLine,
	type RawLiveSessionLine,
	readCompleteLines,
} from "../lib/live-session-lines.js";
import { createTranscriptSlimmer } from "../lib/transcript-slim.js";

function run(line: string) {
	return processLiveSessionLine(
		{ bytes: Buffer.from(line), kind: "line" },
		createTranscriptSlimmer(),
	);
}

test("the per-line pipeline is deterministic, filters secrets and slims images", () => {
	const image = Buffer.alloc(64, 7).toString("base64");
	const line = JSON.stringify({
		message: {
			content: [
				{ text: `key ghp_${"b".repeat(36)}`, type: "text" },
				{
					source: { data: image, media_type: "image/png", type: "base64" },
					type: "image",
				},
			],
		},
		type: "user",
	});
	const first = run(line);
	expect(first).toEqual(run(line));
	expect(first.text).not.toContain("ghp_");
	expect(first.text).not.toContain(image);
	expect(first.text).toContain("opaline-image-omitted:v1;");
	expect(first.text.endsWith("\n")).toBe(false);
	expect(first.sha256).toBe(hashLiveSessionLine(first.text));
	expect(first.redactedBytes).toBeGreaterThan(0);
	expect(JSON.parse(first.text).type).toBe("user");
});

test("lines too large to buffer become an omission marker", () => {
	const marker = processLiveSessionLine(
		{ byteLength: 40 * 1024 * 1024, kind: "oversized" },
		createTranscriptSlimmer(),
	);
	expect(JSON.parse(marker.text)).toEqual({
		originalBytes: 40 * 1024 * 1024,
		reason: "too-large",
		type: "opaline-live-omitted",
	});
});

test("reads only complete lines and resumes at the returned offset", async () => {
	const directory = await mkdtemp(join(tmpdir(), "opaline-live-lines-"));
	try {
		const path = join(directory, "t.jsonl");
		const long = "z".repeat(3 * 1024 * 1024);
		await writeFile(path, `a\n${long}\n\nb\npartial`);
		const handle = await open(path, "r");
		try {
			const size = (await handle.stat()).size;
			const lines: (string | number)[] = [];
			const read = await readCompleteLines(
				handle,
				0,
				size,
				(line: RawLiveSessionLine) => {
					// Bytes may alias the read buffer: use them inside the callback.
					lines.push(
						line.kind === "line" ? line.bytes.toString() : line.byteLength,
					);
					return true;
				},
				Buffer.alloc(1024),
			);
			expect(lines).toEqual(["a", long, "", "b"]);
			expect(read).toEqual({
				endOffset: size - "partial".length,
				lineCount: 4,
				stopped: false,
			});
			const stopped = await readCompleteLines(handle, 2, size, () => false);
			expect(stopped).toEqual({
				endOffset: 2 + long.length + 1,
				lineCount: 1,
				stopped: true,
			});
		} finally {
			await handle.close();
		}
	} finally {
		await rm(directory, { force: true, recursive: true });
	}
});

test("the agent process comes from CLAUDE_PID, else the hook's parent", () => {
	expect(resolveAgentPid({ CLAUDE_PID: "4242" }, 7)).toBe(4242);
	expect(resolveAgentPid({ CLAUDE_PID: " 4242 " }, 7)).toBe(4242);
	expect(resolveAgentPid({ CLAUDE_PID: "0" }, 7)).toBe(7);
	expect(resolveAgentPid({ CLAUDE_PID: "-1" }, 7)).toBe(7);
	expect(resolveAgentPid({ CLAUDE_PID: "12abc" }, 7)).toBe(7);
	expect(resolveAgentPid({}, 7)).toBe(7);
});

test("OPALINE_LIVE_SESSIONS turns live updates off locally", () => {
	for (const value of ["0", "false", "off", " OFF "])
		expect(
			isLiveSessionsDisabledByEnvironment({ OPALINE_LIVE_SESSIONS: value }),
		).toBe(true);
	for (const value of [undefined, "", "1", "true"])
		expect(
			isLiveSessionsDisabledByEnvironment({ OPALINE_LIVE_SESSIONS: value }),
		).toBe(false);
});
