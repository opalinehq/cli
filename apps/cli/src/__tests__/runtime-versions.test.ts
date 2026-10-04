import { describe, expect, test } from "bun:test";
import {
	collectCaptureRuntime,
	readAgentHost,
} from "../lib/runtime-versions.js";

describe("capture runtime versions", () => {
	test("reads the agent version from Claude Code records and Codex session_meta", () => {
		expect(
			readAgentHost(
				[
					JSON.stringify({ type: "summary" }),
					JSON.stringify({
						type: "user",
						version: "2.1.286",
						entrypoint: "cli",
					}),
				].join("\n"),
				"claude_code",
			),
		).toEqual({ name: "claude-code", version: "2.1.286", originator: "cli" });
		expect(
			readAgentHost(
				JSON.stringify({
					type: "session_meta",
					payload: { cli_version: "0.47.0", originator: "codex_cli_rs" },
				}),
				"codex",
			),
		).toEqual({ name: "codex", version: "0.47.0", originator: "codex_cli_rs" });
		expect(readAgentHost("not json", "codex")).toEqual({
			name: "codex",
			version: null,
			originator: null,
		});
		expect(
			readAgentHost(JSON.stringify({ version: "x; rm -rf /" }), "claude_code")
				.version,
		).toBeNull();
	});

	test("records OS, the CLI runtime and tool versions within the probe timeout", async () => {
		const startedAt = performance.now();
		const runtime = await collectCaptureRuntime(undefined, "claude_code");

		expect(performance.now() - startedAt).toBeLessThan(10_000);
		expect(runtime.os).toEqual({
			platform: process.platform,
			release: expect.any(String),
			arch: process.arch,
		});
		expect(runtime.cli.version.length).toBeGreaterThan(0);
		expect(runtime.tools.git).toMatch(/^\d+\.\d+/u);
		expect(runtime.agentHost).toEqual({
			name: "claude-code",
			version: null,
			originator: null,
		});
	});
});
