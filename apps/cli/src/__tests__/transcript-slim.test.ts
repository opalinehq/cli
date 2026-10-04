import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { filterKnownSecrets } from "../internal/secret-filter/index.js";
import {
	createTranscriptSlimmer,
	slimTranscriptText,
	stripInlineImagesFromLine,
} from "../lib/transcript-slim.js";

// Fixtures mirror the API's inline-image-strip tests so both implementations
// are pinned to the same inputs, bytes and markers.
const PIXELS = Buffer.from(
	Array.from({ length: 3_001 }, (_, index) => (index * 37 + 11) % 256),
);
const PIXELS_BASE64 = PIXELS.toString("base64");
const PIXELS_SHA256 = createHash("sha256").update(PIXELS).digest("hex");
const PNG_MARKER = `opaline-image-omitted:v1;sha256=${PIXELS_SHA256};bytes=3001;type=image/png`;

function claudeScreenshotLine() {
	return JSON.stringify({
		type: "user",
		message: {
			role: "user",
			content: [
				{
					tool_use_id: "toolu_1",
					type: "tool_result",
					content: [
						{
							type: "image",
							source: {
								type: "base64",
								data: PIXELS_BASE64,
								media_type: "image/png",
							},
						},
					],
				},
			],
		},
		toolUseResult: {
			type: "image",
			file: { base64: PIXELS_BASE64, type: "image/png", originalSize: 3001 },
		},
		timestamp: "2026-10-03T08:10:18.706Z",
	});
}

function codexScreenshotLine() {
	return JSON.stringify({
		timestamp: "2026-06-13T14:30:47.792Z",
		type: "response_item",
		payload: {
			type: "function_call_output",
			call_id: "call_1",
			output: [
				{
					type: "input_image",
					image_url: `data:image/png;base64,${PIXELS_BASE64}`,
					detail: "original",
				},
			],
		},
	});
}

function commandLine(item: Record<string, unknown>) {
	return JSON.stringify({
		timestamp: "2026-09-12T11:31:33.760Z",
		type: "event_msg",
		payload: {
			type: "item_completed",
			thread_id: "thread-1",
			item: {
				type: "CommandExecution",
				id: "exec-1",
				command: ["/bin/zsh", "-lc", "cat log"],
				...item,
			},
			started_at_ms: 1,
		},
	});
}

function responseItem(payload: Record<string, unknown>) {
	return JSON.stringify({
		timestamp: "2026-09-12T11:00:00.000Z",
		type: "response_item",
		payload,
	});
}

function compactedLine(payload: Record<string, unknown>) {
	return JSON.stringify({
		timestamp: "2026-09-12T12:00:00.000Z",
		type: "compacted",
		payload: { message: "", window_number: 1, ...payload },
	});
}

const USER_MESSAGE = {
	type: "message",
	id: "msg_1",
	role: "user",
	content: [{ type: "input_text", text: "fix the build" }],
};
const REASONING = {
	type: "reasoning",
	id: "rs_1",
	summary: [],
	encrypted_content: "gAAAA",
};
const COMPACTION_SUMMARY = {
	type: "compaction",
	id: "cmp_1",
	encrypted_content: "gAAAAsummary",
};

describe("inline image stripping (parity with the API)", () => {
	test("replaces a Claude image source and its Read result with the exact marker", () => {
		const line = claudeScreenshotLine();

		const stripped = stripInlineImagesFromLine(line);

		expect(stripped).toBe(line.split(PIXELS_BASE64).join(PNG_MARKER));
		const parsed = JSON.parse(stripped);
		expect(parsed.message.content[0].content[0].source).toEqual({
			type: "base64",
			data: PNG_MARKER,
			media_type: "image/png",
		});
		expect(parsed.toolUseResult.file.base64).toBe(PNG_MARKER);
		expect(slimTranscriptText(line)).toBe(stripped);
	});

	test("replaces a Codex image_url data URL with the marker as the value", () => {
		const line = codexScreenshotLine();

		const stripped = slimTranscriptText(line);

		expect(stripped).toBe(
			line.replace(`data:image/png;base64,${PIXELS_BASE64}`, PNG_MARKER),
		);
		expect(JSON.parse(stripped).payload.output[0]).toEqual({
			type: "input_image",
			image_url: PNG_MARKER,
			detail: "original",
		});
	});

	test("replaces an image_url object's data URL", () => {
		const line = JSON.stringify({
			type: "response_item",
			payload: {
				type: "message",
				content: [
					{
						type: "image_url",
						image_url: { url: `data:image/gif;base64,${PIXELS_BASE64}` },
					},
				],
			},
		});

		expect(
			JSON.parse(slimTranscriptText(line)).payload.content[0].image_url.url,
		).toBe(PNG_MARKER.replace("type=image/png", "type=image/gif"));
	});

	test("replaces any string value that is entirely an image data URL", () => {
		const jpegMarker = PNG_MARKER.replace("type=image/png", "type=image/jpeg");
		const line = JSON.stringify({
			type: "event_msg",
			payload: {
				type: "item_completed",
				item: {
					type: "McpToolCall",
					result: {
						_meta: {
							"codex/toolSurface": {
								screenshot: {
									pageUrl: "https://example.com",
									url: `data:image/jpeg;base64,${PIXELS_BASE64}`,
								},
							},
						},
					},
				},
				images: [`data:image/png;base64,${PIXELS_BASE64}`],
			},
		});

		const stripped = slimTranscriptText(line);

		const payload = JSON.parse(stripped).payload;
		expect(payload.item.result._meta["codex/toolSurface"].screenshot).toEqual({
			pageUrl: "https://example.com",
			url: jpegMarker,
		});
		expect(payload.images).toEqual([PNG_MARKER]);
		expect(stripped).toBe(
			line
				.replace(`data:image/jpeg;base64,${PIXELS_BASE64}`, jpegMarker)
				.replace(`data:image/png;base64,${PIXELS_BASE64}`, PNG_MARKER),
		);
	});

	test("replaces base64 inside JSON-encoded tool-output strings", () => {
		const output = JSON.stringify([
			{ type: "input_text", text: "captured" },
			{
				type: "input_image",
				image_url: `data:image/jpeg;base64,${PIXELS_BASE64}`,
			},
		]);
		const line = JSON.stringify({
			type: "response_item",
			payload: { type: "function_call_output", call_id: "c", output },
		});

		const stripped = slimTranscriptText(line);

		const nested = JSON.parse(JSON.parse(stripped).payload.output);
		expect(nested[1].image_url).toBe(
			PNG_MARKER.replace("type=image/png", "type=image/jpeg"),
		);
		expect(nested[0]).toEqual({ type: "input_text", text: "captured" });
		expect(stripped).not.toContain(PIXELS_BASE64);
	});

	test("replaces base64 encoded twice inside tool output", () => {
		const inner = JSON.stringify({
			content: [{ type: "image", data: PIXELS_BASE64, mimeType: "image/png" }],
		});
		const line = JSON.stringify({
			type: "event_msg",
			payload: { type: "tool_output", output: JSON.stringify({ inner }) },
		});

		const stripped = slimTranscriptText(line);

		expect(stripped).toBe(line.replace(PIXELS_BASE64, PNG_MARKER));
		const outer = JSON.parse(JSON.parse(stripped).payload.output);
		expect(JSON.parse(outer.inner).content[0].data).toBe(PNG_MARKER);
	});

	test("replaces MCP image content data", () => {
		const line = JSON.stringify({
			type: "event_msg",
			payload: {
				type: "mcp_tool_call_end",
				result: {
					Ok: {
						content: [
							{ type: "image", data: PIXELS_BASE64, mimeType: "image/webp" },
						],
					},
				},
			},
		});

		expect(
			JSON.parse(slimTranscriptText(line)).payload.result.Ok.content[0].data,
		).toBe(PNG_MARKER.replace("type=image/png", "type=image/webp"));
	});

	test("is idempotent and leaves every other byte unchanged", () => {
		const content = [
			'{"type":"assistant","message":{"content":[{"type":"text","text":"base64 is fine"}]}}',
			claudeScreenshotLine(),
			"not json but mentions base64",
			codexScreenshotLine(),
			"",
		].join("\n");

		const once = slimTranscriptText(content);

		expect(slimTranscriptText(once)).toBe(once);
		expect(once.split("\n")[0]).toBe(content.split("\n")[0]);
		expect(once.split("\n")[2]).toBe("not json but mentions base64");
		expect(once.endsWith("\n")).toBe(true);
		expect(once.split(PNG_MARKER)).toHaveLength(4);
	});

	test("leaves non-image, non-base64 and in-text data URLs unchanged", () => {
		const content = [
			JSON.stringify({
				type: "document",
				source: {
					type: "base64",
					data: PIXELS_BASE64,
					media_type: "application/pdf",
				},
			}),
			JSON.stringify({
				type: "image",
				source: {
					type: "base64",
					data: "not base64!",
					media_type: "image/png",
				},
			}),
			JSON.stringify({ image_url: "https://example.com/a.png" }),
			JSON.stringify({
				image_url: `data:image/png;base64,${PIXELS_BASE64.slice(0, -1)}`,
			}),
			JSON.stringify({
				type: "assistant",
				text: `const fixture = "data:image/png;base64,${PIXELS_BASE64}";`,
			}),
		].join("\n");

		expect(slimTranscriptText(content)).toBe(content);
	});

	test("marker survives secret filtering unchanged", () => {
		const stripped = slimTranscriptText(claudeScreenshotLine());

		expect(filterKnownSecrets(stripped).text).toBe(stripped);
	});
});

describe("Codex command output dedupe", () => {
	test("keeps only aggregated_output when stdout and formatted_output repeat it", () => {
		const line = commandLine({
			stdout: "ok\n",
			stderr: "",
			aggregated_output: "ok\n",
			exit_code: 0,
			formatted_output: "ok\n",
		});

		const slimmed = slimTranscriptText(line);

		const expected = JSON.parse(line);
		delete expected.payload.item.stdout;
		delete expected.payload.item.formatted_output;
		expect(slimmed).toBe(JSON.stringify(expected));
	});

	test("drops formatted_output that is Codex's truncated rendering", () => {
		const aggregated = `${"head\n".repeat(50)}middle\n${"tail\n".repeat(50)}`;
		const formatted = `Warning: truncated output (original token count: 900)\nTotal output lines: 101\n\n${"head\n".repeat(50)}…6 chars truncated…${"tail\n".repeat(50)}`;
		const line = commandLine({
			stdout: aggregated,
			stderr: "",
			aggregated_output: aggregated,
			formatted_output: formatted,
		});

		const item = JSON.parse(slimTranscriptText(line)).payload.item;

		expect(item.aggregated_output).toBe(aggregated);
		expect(item.formatted_output).toBeUndefined();
		expect(item.stdout).toBeUndefined();
	});

	test("never drops a copy that differs from aggregated_output", () => {
		const line = commandLine({
			stdout: "out\n",
			stderr: "warning\n",
			aggregated_output: "out\nwarning\n",
			formatted_output:
				"Warning: truncated output (original token count: 9)\nTotal output lines: 2\n\nnot in aggregated",
		});

		expect(slimTranscriptText(line)).toBe(line);
	});

	test("keeps stdout and formatted_output when aggregated_output is absent", () => {
		const line = commandLine({
			stdout: "only copy\n",
			stderr: "",
			formatted_output: "only copy\n",
		});

		expect(slimTranscriptText(line)).toBe(line);
	});

	test("dedupes legacy exec_command_end events the same way", () => {
		const line = JSON.stringify({
			type: "event_msg",
			payload: {
				type: "exec_command_end",
				call_id: "call_1",
				stdout: "done\n",
				stderr: "",
				aggregated_output: "done\n",
				exit_code: 0,
				formatted_output: "done\n",
			},
		});

		expect(JSON.parse(slimTranscriptText(line)).payload).toEqual({
			type: "exec_command_end",
			call_id: "call_1",
			stderr: "",
			aggregated_output: "done\n",
			exit_code: 0,
		});
	});

	test("leaves a record untouched when re-serializing would change other bytes", () => {
		const line =
			'{"type":"event_msg","payload":{"type":"item_completed","item":{"type":"CommandExecution","stdout":"a","aggregated_output":"a","duration":1.0}}}';

		expect(slimTranscriptText(line)).toBe(line);
	});
});

describe("Codex compaction replay", () => {
	test("drops a history whose every item already appeared earlier", () => {
		const content = [
			responseItem(USER_MESSAGE),
			responseItem(REASONING),
			compactedLine({
				replacement_history: [USER_MESSAGE, COMPACTION_SUMMARY],
				guardian_history: [USER_MESSAGE, REASONING],
			}),
		].join("\n");

		const compacted = JSON.parse(
			slimTranscriptText(content).split("\n")[2] ?? "",
		);

		expect(compacted.payload.guardian_history).toBeUndefined();
		expect(compacted.payload.replacement_history).toEqual([
			USER_MESSAGE,
			COMPACTION_SUMMARY,
		]);
		expect(compacted.payload.window_number).toBe(1);
	});

	test("matches an item whose copy omits a field written as null", () => {
		const content = [
			responseItem(REASONING),
			compactedLine({ guardian_history: [{ ...REASONING, content: null }] }),
		].join("\n");

		const compacted = JSON.parse(
			slimTranscriptText(content).split("\n")[1] ?? "",
		);

		expect(compacted.payload.guardian_history).toBeUndefined();
	});

	test("keeps a history whose items only appear later in the stream", () => {
		const content = [
			compactedLine({ guardian_history: [USER_MESSAGE] }),
			responseItem(USER_MESSAGE),
		].join("\n");

		expect(slimTranscriptText(content)).toBe(content);
	});

	test("counts history retained by an earlier compaction as present", () => {
		const first = compactedLine({
			replacement_history: [COMPACTION_SUMMARY],
		});
		const second = compactedLine({
			replacement_history: [COMPACTION_SUMMARY],
		});

		const slimmed = slimTranscriptText(`${first}\n${second}`).split("\n");

		expect(slimmed[0]).toBe(first);
		expect(JSON.parse(slimmed[1] ?? "").payload.replacement_history).toBe(
			undefined,
		);
	});

	test("drops a summary message carried in the compaction message", () => {
		const summary = {
			type: "message",
			role: "user",
			content: [{ type: "input_text", text: "Summary of the work so far" }],
		};
		const content = [
			responseItem(USER_MESSAGE),
			compactedLine({
				message: "Summary of the work so far",
				replacement_history: [USER_MESSAGE, summary],
			}),
		].join("\n");

		const compacted = JSON.parse(
			slimTranscriptText(content).split("\n")[1] ?? "",
		);

		expect(compacted.payload).toEqual({
			message: "Summary of the work so far",
			window_number: 1,
		});
	});
});

describe("transcript slimming", () => {
	const mixed = [
		responseItem(USER_MESSAGE),
		codexScreenshotLine(),
		commandLine({
			stdout: "ok\n",
			stderr: "",
			aggregated_output: "ok\n",
			formatted_output: "ok\n",
		}),
		compactedLine({ guardian_history: [USER_MESSAGE] }),
		claudeScreenshotLine(),
		"{not json",
		"",
	].join("\n");

	test("is idempotent and keeps every line valid JSON", () => {
		const once = slimTranscriptText(mixed);

		expect(slimTranscriptText(once)).toBe(once);
		expect(once.split("\n")).toHaveLength(mixed.split("\n").length);
		for (const [index, line] of once.split("\n").entries()) {
			const original = mixed.split("\n")[index] ?? "";
			if (line === "" || line === "{not json") {
				expect(line).toBe(original);
				continue;
			}
			expect(() => JSON.parse(line)).not.toThrow();
		}
		expect(Buffer.byteLength(once)).toBeLessThan(Buffer.byteLength(mixed));
	});

	test("streaming records gives the same bytes as slimming the whole text", () => {
		const slimmer = createTranscriptSlimmer();
		const streamed = mixed
			.split("\n")
			.map((line, index, lines) =>
				slimmer.slimRecord(index < lines.length - 1 ? `${line}\n` : line),
			)
			.join("");

		expect(streamed).toBe(slimTranscriptText(mixed));
	});

	test("keeps CRLF line terminators", () => {
		const line = commandLine({ stdout: "x", aggregated_output: "x" });
		const slimmer = createTranscriptSlimmer();

		const slimmed = slimmer.slimRecord(`${line}\r\n`);

		expect(slimmed.endsWith("}\r\n")).toBe(true);
		expect(JSON.parse(slimmed).payload.item.stdout).toBeUndefined();
	});
});

// Byte-exact fixtures shared with the Opaline API's slimming port
// (packages/api-routes/src/__fixtures__/transcript-slim). One line is CRLF;
// .gitattributes keeps both files unconverted.
describe("parity fixtures shared with the API", () => {
	const fixtureUrl = (name: string) =>
		new URL(`./fixtures/transcript-slim/${name}`, import.meta.url);

	test("slims the shared input to exactly the shared expected bytes", async () => {
		const input = await Bun.file(fixtureUrl("input.jsonl")).text();
		const expected = await Bun.file(fixtureUrl("expected.jsonl")).text();

		expect(input.includes("\r\n")).toBe(true);
		expect(slimTranscriptText(input)).toBe(expected);
		expect(slimTranscriptText(expected)).toBe(expected);
	});

	test("streams the shared input record by record to the same bytes", async () => {
		const input = await Bun.file(fixtureUrl("input.jsonl")).text();
		const expected = await Bun.file(fixtureUrl("expected.jsonl")).text();
		const slimmer = createTranscriptSlimmer();

		const streamed = (input.match(/[^\n]*\n|[^\n]+$/gu) ?? [])
			.map((record) => slimmer.slimRecord(record))
			.join("");

		expect(streamed).toBe(expected);
	});
});
