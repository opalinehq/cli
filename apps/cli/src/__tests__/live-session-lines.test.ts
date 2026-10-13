import { expect, test } from "bun:test";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	isCodexExecutableName,
	isLiveSessionsDisabledByEnvironment,
	resolveClaudeAgentPid,
} from "../lib/live-session-launch.js";
import {
	hashLiveSessionLine,
	processLiveSessionLine,
	type RawLiveSessionLine,
	readCompleteLines,
} from "../lib/live-session-lines.js";
import {
	listLiveSessionRegistrations,
	removeLiveSessionRegistration,
	writeLiveSessionRegistration,
} from "../lib/live-session-registry.js";
import {
	parseProcStat,
	readProcessStartIdentities,
} from "../lib/process-identity.js";
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

test("the Claude Code process comes from CLAUDE_PID, else the hook's parent", () => {
	const env = { pid: 4242, pidSource: "env" } as const;
	const parent = { pid: 7, pidSource: "parent" } as const;
	expect(resolveClaudeAgentPid({ CLAUDE_PID: "4242" }, 7)).toEqual(env);
	expect(resolveClaudeAgentPid({ CLAUDE_PID: " 4242 " }, 7)).toEqual(env);
	expect(resolveClaudeAgentPid({ CLAUDE_PID: "0" }, 7)).toEqual(parent);
	expect(resolveClaudeAgentPid({ CLAUDE_PID: "-1" }, 7)).toEqual(parent);
	expect(resolveClaudeAgentPid({ CLAUDE_PID: "12abc" }, 7)).toEqual(parent);
	expect(resolveClaudeAgentPid({}, 7)).toEqual(parent);
});

test("the Codex process is an ancestor named codex", () => {
	for (const name of ["codex", "codex.exe", "CODEX.EXE"])
		expect(isCodexExecutableName(name)).toBe(true);
	for (const name of ["node", "codex-notify", "opaline", "xcodex"])
		expect(isCodexExecutableName(name)).toBe(false);
});

test("reads Linux process start times, also for names with spaces and parentheses", () => {
	const fields = Array.from({ length: 50 }, (_, index) => String(index + 3));
	fields[1] = "77"; // ppid (field 4)
	fields[19] = "123456"; // starttime (field 22)
	expect(parseProcStat(`42 (my (odd) name) ${fields.join(" ")}`)).toEqual({
		comm: "my (odd) name",
		ppid: 77,
		startTime: "123456",
	});
	expect(parseProcStat("garbage")).toBeNull();
});

test.skipIf(process.platform !== "linux" && process.platform !== "darwin")(
	"reads this process's start identity",
	async () => {
		const identities = await readProcessStartIdentities([process.pid]);
		expect(identities.get(process.pid)).toStartWith(`${process.platform}:`);
		expect(
			(await readProcessStartIdentities([process.pid])).get(process.pid),
		).toBe(identities.get(process.pid));
	},
);

test("registrations are atomic, validated, and removed only when unchanged", async () => {
	const configDir = await mkdtemp(join(tmpdir(), "opaline-live-registry-"));
	try {
		const registration = {
			agentPid: 4242,
			agentPidSource: "ancestor" as const,
			agentStartIdentity: null,
			cwd: "/project",
			organizationId: "org",
			sessionId: "019a0000-0000-7000-8000-000000000001",
			source: "codex" as const,
			startedAt: 1_000,
			transcriptPath: "/rollout.jsonl",
			version: 1 as const,
		};
		await writeLiveSessionRegistration(configDir, registration);
		await writeLiveSessionRegistration(
			configDir,
			{ ...registration, startedAt: 2_000 },
			{ onlyIfChanged: true },
		);
		const [stored] = await listLiveSessionRegistrations(configDir);
		expect(stored?.startedAt).toBe(1_000);
		await writeLiveSessionRegistration(configDir, {
			...registration,
			startedAt: 3_000,
		});
		await removeLiveSessionRegistration(stored as NonNullable<typeof stored>);
		expect(await listLiveSessionRegistrations(configDir)).toHaveLength(1);
		await writeFile(
			join(configDir, "live-sessions", "sessions", `${"0".repeat(64)}-1.json`),
			"{",
		);
		expect(await listLiveSessionRegistrations(configDir)).toHaveLength(1);
		await expect(
			writeLiveSessionRegistration(configDir, {
				...registration,
				sessionId: "../escape",
			}),
		).rejects.toThrow();
	} finally {
		await rm(configDir, { force: true, recursive: true });
	}
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
