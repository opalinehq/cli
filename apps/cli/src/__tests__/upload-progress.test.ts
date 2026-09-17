import { expect, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { UploadRepository } from "../lib/upload-manager-repositories.js";
import {
	applyUploadKey,
	type UploadManagerState,
} from "../lib/upload-manager-state.js";
import { renderUploadManager } from "../lib/upload-manager-ui.js";
import {
	formatUploadBytes,
	recordUploadBytes,
	type UploadSpeed,
	uploadBytesPerSecond,
} from "../lib/upload-progress.js";

test("recent transfer speed includes retry bytes, stays bounded and falls to zero during a stall", () => {
	const speed: UploadSpeed = { startedAt: 0, samples: [] };
	recordUploadBytes(speed, 1_000_000, 100);
	recordUploadBytes(speed, 1_000_000, 200);
	expect(uploadBytesPerSecond(speed, 2_000)).toBe(1_000_000);
	expect(uploadBytesPerSecond(speed, 6_000)).toBe(0);
	for (let at = 6_000; at < 20_000; at++) recordUploadBytes(speed, 1, at);
	expect(speed.samples.length).toBeLessThanOrEqual(51);
	expect(formatUploadBytes(undefined)).toBe("—");
	expect(formatUploadBytes(1_200_000)).toBe("1.2 MB");
});

test("active uploads show dated session IDs, bytes and explicit failures without selection hints", () => {
	const repo = uploadFixture();
	const state: UploadManagerState = {
		query: "",
		cursor: 1,
		desired: new Map([[repo.key, true]]),
		message: "",
		stage: "upload",
		operation: { label: "Uploading", frame: 0 },
	};
	const ansi = renderUploadManager([repo], state, 120, 35);
	const text = stripVTControlCharacters(ansi);
	expect(text).toContain("2026-09-17 · session-uploading");
	expect(text).toContain("1.2 MB / 4.0 MB");
	expect(text).toContain("Processing on server");
	expect(text).toContain("✗ Failed");
	expect(text).toContain("503 Service unavailable");
	expect(text).toContain("/s");
	expect(text).not.toMatch(
		/Enter to review|repair setup|pending|Space|\/projects\/active/,
	);
	const header = ansi
		.split("\n")
		.find((line) => line.includes("active (current)"));
	expect(header).toContain("\u001b[36m     ⠋ 2\u001b[0m");
});

test("failed session IDs and full reasons remain accessible on small terminal pages", () => {
	const repo = uploadFixture();
	repo.sessionUploads = Array.from({ length: 8 }, (_, index) => ({
		sessionId: `019cb958-d947-7901-916f-ac59e2d3731${index}`,
		source: "codex",
		sessionDate: Date.parse("2026-09-17T00:00:00Z"),
		status: "failed",
		uploadedBytes: 4_000_000,
		totalBytes: 4_000_000,
		error: `Failure ${index}: ${"server detail ".repeat(12)}end-${index}`,
	}));
	const state: UploadManagerState = {
		query: "",
		cursor: 0,
		desired: new Map(),
		message: "8 sessions need attention.",
		stage: "upload",
		uploadFailed: true,
		followUpload: false,
	};
	const pages: string[] = [];
	for (let page = 0; page < (state.uploadPageCount ?? 1); page++) {
		state.uploadPage = page;
		const screen = stripVTControlCharacters(
			renderUploadManager([repo], state, 38, 13),
		);
		pages.push(screen);
		expect(screen.split("\n").length).toBeLessThan(13);
		for (const line of screen.split("\n")) expect(line.length).toBeLessThan(38);
		expect(screen).toContain("Retry [Enter]");
	}
	const body = pages
		.map((page) =>
			page
				.split("\n")
				.slice(6, -4)
				.filter((line) => !line.includes("[──●]"))
				.join(""),
		)
		.join("")
		.replace(/\s/g, "");
	for (const detail of repo.sessionUploads) {
		expect(body).toContain(detail.sessionId);
		expect(body).toContain(detail.error?.replace(/\s/g, "") ?? "missing");
	}
	expect(applyUploadKey([repo], state, { name: "up" })).toBe("changed");
	expect(applyUploadKey([repo], state, { name: "return" })).toBe("save");
	state.singleRun = true;
	expect(applyUploadKey([repo], state, { name: "return" })).toBe("save");
	expect(applyUploadKey([repo], state, { name: "escape" })).toBe("cancel");
});

test("scan distinguishes local discovery from upload-history checks", () => {
	const state: UploadManagerState = {
		query: "",
		cursor: 0,
		desired: new Map(),
		message: "",
		scan: {
			frame: 0,
			progress: { phase: "sessions", sessions: 1_917, repositories: 0 },
		},
	};
	const reading = stripVTControlCharacters(
		renderUploadManager([], state, 120, 24),
	);
	expect(reading).toContain("Reading sessions");
	expect(reading).toContain("1,917");
	state.scan = {
		frame: 0,
		progress: { phase: "history", sessions: 1_917, repositories: 1 },
	};
	expect(
		stripVTControlCharacters(
			renderUploadManager([uploadFixture()], state, 120, 24),
		),
	).toContain("Checking uploads (1)");
});

test("partial success keeps failure pages, continuation links and explicit retry without row selection", () => {
	for (const singleRun of [true, false]) {
		for (const completion of [
			{ kind: "setup", url: "https://opaline.so/welcome?connect=test" },
			{
				kind: "sessions",
				dashboards: [
					{ organizationId: "acme", url: "https://opaline.so/acme/sessions" },
				],
			},
		] satisfies NonNullable<UploadManagerState["completion"]>[]) {
			const repo = uploadFixture();
			repo.upload = { active: false, completed: 2, total: 10, failed: 1 };
			repo.sessionUploads = repo.sessionUploads?.filter(
				(detail) => detail.status === "failed",
			);
			const state: UploadManagerState = {
				singleRun,
				completion,
				query: "",
				cursor: 0,
				desired: new Map(),
				message: "2 uploaded · 1 failed",
				stage: "upload",
				uploadFailed: true,
			};
			for (const [width, height] of [
				[38, 13],
				[120, 30],
			]) {
				const screen = renderUploadManager([repo], state, width, height);
				expect(screen).toContain("Continue [Enter]");
				expect(screen).toContain("Retry failed [R]");
				expect(screen).toContain(
					completion.kind === "setup"
						? completion.url
						: (completion.dashboards[0]?.url ?? "missing"),
				);
				expect(screen.split("\n").length).toBeLessThan(height);
				expect(screen).not.toMatch(/Space|toggle|move/);
			}
			expect(applyUploadKey([repo], state, { name: "down" })).toBe("changed");
			expect(state.cursor).toBe(0);
			expect(state.followUpload).toBe(false);
			expect(applyUploadKey([repo], state, { name: "space" })).toBe("ignored");
			expect(applyUploadKey([repo], state, { name: "r" })).toBe("save");
			expect(applyUploadKey([repo], state, { name: "return" })).toBe("cancel");
			expect(applyUploadKey([repo], state, { name: "escape" })).toBe("cancel");
		}
	}
});

function uploadFixture(): UploadRepository {
	return {
		key: "active",
		name: "active",
		paths: ["/projects/active"],
		enabled: true,
		sessionCount: 10,
		uploadedCount: 2,
		sources: ["codex"],
		current: true,
		problem: "Enter to repair setup for Codex.",
		upload: { active: true, completed: 2, total: 10, failed: 1 },
		sessionUploads: [
			{
				sessionId: "session-uploading",
				source: "codex",
				sessionDate: Date.parse("2026-09-17"),
				status: "uploading",
				uploadedBytes: 1_200_000,
				totalBytes: 4_000_000,
			},
			{
				sessionId: "session-processing",
				source: "codex",
				sessionDate: Date.parse("2026-09-17"),
				status: "processing",
				uploadedBytes: 4_000_000,
				totalBytes: 4_000_000,
			},
			{
				sessionId: "session-failed",
				source: "codex",
				sessionDate: Date.parse("2026-09-17"),
				status: "failed",
				uploadedBytes: 0,
				totalBytes: 4_000_000,
				error: "503 Service unavailable",
			},
		],
	};
}
