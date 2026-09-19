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
	type SessionUploadDetail,
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
	expect(text.replace(/\s+/g, " ")).toContain("1.2 MB / 4.0 MB");
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
				.slice(4, -5)
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

test("oversized sessions show a skip reason and zero transferred bytes", () => {
	const repo = uploadFixture();
	repo.upload = { active: false, completed: 2, total: 10, failed: 1 };
	repo.sessionUploads = [
		{
			sessionId: "oversized-session",
			source: "codex",
			sessionDate: Date.parse("2026-09-17T00:00:00Z"),
			status: "skipped",
			uploadedBytes: 0,
			totalBytes: 150 * 1024 * 1024,
			error:
				"Skipped: session files total 150 MiB, above the 128 MiB per-session limit. No upload attempted.",
		},
	];
	const text = stripVTControlCharacters(
		renderUploadManager(
			[repo],
			{
				query: "",
				cursor: 0,
				desired: new Map(),
				message: "",
				stage: "upload",
				uploadFailed: true,
			},
			120,
			35,
		),
	);
	expect(text).toContain("Skipped · size limit (1)");
	expect(text.replace(/\s+/g, " ")).toContain("0 B / 157.3 MB");
	expect(text.replace(/\s+/g, " ")).toContain("No upload attempted.");
	expect(text).not.toContain("Preparation failed");
});

test("size-limit skips across repositories share one explanation and retain every session", () => {
	const repositories = [
		uploadFixture(),
		{ ...uploadFixture(), key: "second", name: "second" },
	];
	for (const [index, repo] of repositories.entries()) {
		repo.sessionUploads = Array.from({ length: 3 }, (_, session) => ({
			sessionId: `skipped-${index}-${session}`,
			source: "codex",
			sessionDate: Date.parse("2026-09-17"),
			status: "skipped",
			uploadedBytes: 0,
			totalBytes: 150 * 1024 * 1024,
			maxBytes: 128 * 1024 * 1024,
			error: "Duplicated individual size explanation",
			reportError: "Could not save diagnostics.",
		}));
	}
	for (const [columns, rows] of [
		[38, 13],
		[120, 45],
	]) {
		const state: UploadManagerState = {
			query: "",
			cursor: 0,
			desired: new Map(),
			message: "",
			stage: "upload",
			uploadFailed: true,
			followUpload: false,
		};
		let body = "";
		for (let page = 0; page < (state.uploadPageCount ?? 1); page++) {
			state.uploadPage = page;
			const screen = stripVTControlCharacters(
				renderUploadManager(repositories, state, columns, rows),
			);
			expect(screen.split("\n").length).toBeLessThan(rows);
			for (const line of screen.split("\n"))
				expect(line.length).toBeLessThan(columns);
			const lines = screen.split("\n");
			const footer = lines.findIndex((line) => line.includes("6 skipped:"));
			expect(footer).toBeGreaterThan(6);
			const boundary = lines.findLastIndex(
				(line) => line.includes("Page") || line.includes("────"),
			);
			expect(boundary).toBeLessThan(footer);
			const pager = lines.findIndex((line) => line.includes("‹ Page"));
			if (pager >= 0) expect(lines[pager - 1]).toContain("────");
			expect(
				screen.replace(/\s/g, "").match(/Nouploadattempted\./g),
			).toHaveLength(1);
			expect(screen).not.toContain("Retry");
			body += lines
				.slice(4, boundary)
				.filter(
					(line) =>
						!line.includes("Skipped · size limit") && !line.includes("[──●]"),
				)
				.join("");
		}
		const compactBody = body.replace(/\s/g, "");
		expect(compactBody).not.toContain("Nouploadattempted.");
		expect(compactBody.match(/Couldnotsavediagnostics\./g)).toHaveLength(1);
		expect(body).not.toContain("Duplicated individual size explanation");
		for (const repo of repositories)
			for (const detail of repo.sessionUploads ?? [])
				expect(compactBody).toContain(detail.sessionId);
	}
});

test("size-only skips offer Continue to the existing success screen, never Retry", () => {
	for (const singleRun of [true, false]) {
		for (const uploadedCount of [0, 2]) {
			for (const columns of [38, 80, 120]) {
				const repo = uploadFixture();
				repo.uploadedCount = uploadedCount;
				repo.upload = {
					active: false,
					completed: uploadedCount,
					total: 10,
					failed: 0,
				};
				repo.sessionUploads = [
					{
						sessionId: "too-large",
						source: "codex",
						sessionDate: Date.parse("2026-09-17"),
						status: "skipped",
						uploadedBytes: 0,
						totalBytes: 150 * 1024 * 1024,
					},
				];
				const state: UploadManagerState = {
					query: "",
					cursor: 0,
					desired: new Map(),
					stage: "upload",
					uploadFailed: true,
					singleRun,
					message: `${uploadedCount} uploaded · 1 skipped`,
					completion: singleRun
						? { kind: "setup", url: "https://opaline.so/welcome?connect=test" }
						: {
								kind: "sessions",
								dashboards: [
									{
										organizationId: "acme",
										url: "https://opaline.so/acme/sessions",
									},
								],
							},
				};
				const results = stripVTControlCharacters(
					renderUploadManager([repo], state, columns, 13),
				);
				expect(results).not.toContain("Retry");
				expect(results).toContain("Continue [Enter]");
				expect(results.indexOf("Continue [Enter]")).toBeGreaterThan(
					results.indexOf("No upload attempted."),
				);
				expect(results.split("\n").length).toBeLessThan(13);
				expect(applyUploadKey([repo], state, { name: "r" })).toBe("ignored");
				expect(applyUploadKey([repo], state, { name: "return" })).toBe(
					"changed",
				);
				const success = renderUploadManager([repo], state, columns, 13);
				expect(success).toContain(
					uploadedCount
						? "Successfully uploaded sessions"
						: "Auto upload enabled",
				);
				expect(success).toContain(
					singleRun
						? "https://opaline.so/welcome?connect=test"
						: "https://opaline.so/acme/sessions",
				);
				expect(success).not.toMatch(/Retry|Continue \[Enter\]/u);
				expect(success.split("\n").length).toBeLessThan(13);
				expect(applyUploadKey([repo], state, { name: "return" })).toBe(
					"cancel",
				);
			}
		}
	}
});

test("session rows and transfer columns stay fixed from queued through completion", () => {
	for (const columns of [38, 80, 120]) {
		const repo = uploadFixture();
		const detail: SessionUploadDetail = {
			sessionId: "019cb958-d947-7901-916f-ac59e2d37310",
			source: "codex",
			sessionDate: Date.parse("2026-09-17"),
			status: "queued",
			uploadedBytes: 0,
			totalBytes: undefined,
		};
		repo.sessionUploads = [detail, { ...detail, sessionId: "next-session" }];
		const state: UploadManagerState = {
			query: "",
			cursor: 0,
			desired: new Map(),
			message: "",
			stage: "upload",
			operation: { label: "Uploading", frame: 0 },
			followUpload: false,
		};
		const positions: Array<{
			next: number;
			transfer: number;
			slash: number;
			pages: number | undefined;
		}> = [];
		for (const status of [
			"queued",
			"preparing",
			"uploading",
			"retrying",
			"processing",
			"uploaded",
		] as const) {
			detail.status = status;
			detail.attempt = 2;
			detail.maxAttempts = 3;
			detail.error =
				status === "retrying" ? "Temporary transport error" : undefined;
			if (status === "uploading") {
				detail.totalBytes = 128_000_000;
				detail.uploadedBytes = 123_000_000;
			}
			const screen = stripVTControlCharacters(
				renderUploadManager([repo], state, columns, 45),
			);
			const lines = screen.split("\n");
			const transfer = lines.findIndex((line) => line.includes(" / "));
			expect(transfer).toBeGreaterThan(6);
			expect(screen).not.toContain("Temporary transport error");
			for (const line of lines) expect(line.length).toBeLessThan(columns);
			positions.push({
				next: lines.findIndex((line) => line.includes("next-session")),
				transfer,
				slash: lines[transfer]?.indexOf(" / ") ?? -1,
				pages: state.uploadPageCount,
			});
		}
		for (const position of positions) expect(position).toEqual(positions[0]);
	}
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

test("partial success keeps failure pages and retries, then Continue opens completion", () => {
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
				expect(screen.split("\n").length).toBeLessThan(height);
				expect(screen).not.toMatch(/Space|toggle|move/);
			}
			expect(applyUploadKey([repo], state, { name: "down" })).toBe("changed");
			expect(state.cursor).toBe(0);
			expect(state.followUpload).toBe(false);
			expect(applyUploadKey([repo], state, { name: "space" })).toBe("ignored");
			expect(applyUploadKey([repo], state, { name: "r" })).toBe("save");
			expect(applyUploadKey([repo], state, { name: "return" })).toBe("changed");
			const completed = renderUploadManager([repo], state, 120, 30);
			expect(completed).toContain("Successfully uploaded sessions");
			expect(completed).toContain(
				completion.kind === "setup"
					? completion.url
					: (completion.dashboards[0]?.url ?? "missing"),
			);
			expect(completed).not.toContain("Retry");
			expect(applyUploadKey([repo], state, { name: "return" })).toBe("cancel");
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
