import { expect, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { UploadRepository } from "../lib/upload-manager-repositories.js";
import { UPLOAD_MANAGER_THEME } from "../lib/upload-manager-theme.js";
import {
	editUploadSelection,
	filterRepositories,
	getAllUploadState,
	getDesiredUploadState,
	getPendingRepositories,
	getRepositoriesToUpload,
	getTableRepositories,
	renderUploadManager,
	reviewUploadSelection,
	toggleUploadRepository,
	type UploadManagerState,
} from "../lib/upload-manager-ui.js";

const TEST_THEME = {
	...UPLOAD_MANAGER_THEME,
	maxWidth: 96,
	padding: 2,
	columnGap: 3,
	showTotals: true,
};

const repositories: UploadRepository[] = Array.from(
	{ length: 80 },
	(_, index) => ({
		key: `github.com/team/repo-${index}`,
		name: `team/repo-${index}`,
		paths: [`/projects/repo-${index}`],
		enabled: index % 2 === 0,
		sessionCount: index,
		sources: [],
		current: index === 0,
	}),
);

test("only desired ON repositories with unuploaded sessions are queued", () => {
	const rows = repositories
		.slice(1, 5)
		.map((repo) => ({ ...repo, uploadedCount: 0 }));
	const state: UploadManagerState = {
		query: "hidden",
		cursor: 0,
		desired: new Map(),
		message: "",
	};
	const [off, on, enable, disable] = rows;
	if (!off || !on || !enable || !disable) throw new Error("Missing fixtures");
	on.uploadedCount = on.sessionCount;
	state.desired.set(enable.key, true);
	state.desired.set(disable.key, false);
	expect(getRepositoriesToUpload(rows, state).map((repo) => repo.key)).toEqual([
		enable.key,
	]);
	state.desired.delete(enable.key);
	on.uploadedCount = 0;
	expect(getRepositoriesToUpload(rows, state)).toHaveLength(0);
});

test("upload counts remain independent of switches and share the table with progress", () => {
	const state: UploadManagerState = {
		query: "",
		cursor: 1,
		desired: new Map(),
		message: "",
		operation: { label: "Uploading", frame: 0 },
	};
	const rows: UploadRepository[] = [
		{
			key: "active",
			name: "active",
			paths: ["/projects/active"],
			enabled: true,
			sessionCount: 1204,
			uploadedCount: 1102,
			upload: { completed: 1102, total: 1204, active: true, failed: 0 },
			sources: [],
			current: false,
		},
		{
			key: "off",
			name: "off",
			paths: [],
			enabled: false,
			sessionCount: 42,
			uploadedCount: 30,
			sources: [],
			current: false,
		},
		{
			key: "unknown",
			name: "unknown",
			paths: [],
			enabled: false,
			sessionCount: 7,
			sources: [],
			current: false,
		},
	];
	const ansi = renderUploadManager(rows, state, 96, 24, TEST_THEME);
	const lines = stripVTControlCharacters(ansi).split("\n");
	expect(lines[2]).toContain("Local sessionsUploaded");
	expect(lines.find((line) => line.includes("active"))).toMatch(
		/1,204\s+⠋ 1,102/u,
	);
	expect(lines.find((line) => line.includes("All repos"))).toMatch(/⠋ 1,132/u);
	expect(
		lines.find((line) => line.includes("[○──] OFF") && line.includes("off")),
	).toMatch(/42\s+30/u);
	expect(lines.find((line) => line.includes("unknown"))).toMatch(/7\s+—/u);
	expect(lines.some((line) => line.trim() === "/projects/active")).toBe(true);
	expect(lines.join("\n")).not.toContain("of 3 repos");
	expect(lines.join("\n")).not.toContain("OFF stops future uploads");
	expect(lines.join("\n")).not.toMatch(/↑↓|Space|Enter|Esc/u);
	const aggregate = ansi.split("\n").find((line) => line.includes("All repos"));
	expect(aggregate).toContain("\u001b[0mAll repos");
	expect(aggregate).toContain("\u001b[0m         1,253");
	state.operation = undefined;
	const active = rows[0];
	if (!active) throw new Error("Missing active fixture");
	active.upload = { completed: 1102, total: 1204, active: false, failed: 1 };
	active.uploadError = "Network unavailable";
	const failed = stripVTControlCharacters(
		renderUploadManager(rows, state, 96, 24, TEST_THEME),
	);
	expect(failed).toMatch(/1,102 !/u);
	expect(failed).toContain("Network unavailable");
	expect(getPendingRepositories(rows, state)).toHaveLength(0);
});

test("an unrelated setup problem is not silently included in pending changes", () => {
	const first = repositories[0];
	if (!first) throw new Error("Missing fixture");
	const rows = [
		{ ...first, problem: "Enter to repair setup for Codex." },
		...repositories.slice(1),
	];
	const state: UploadManagerState = {
		query: "",
		cursor: 0,
		desired: new Map(),
		message: "",
	};
	expect(getPendingRepositories(rows, state)).toHaveLength(0);
	state.desired.set("github.com/team/repo-2", false);
	expect(getPendingRepositories(rows, state).map((row) => row.key)).toEqual([
		"github.com/team/repo-2",
	]);
});

test("filtering retains pending changes and counts changes outside the visible list", () => {
	const state: UploadManagerState = {
		query: "repo-2",
		cursor: 0,
		desired: new Map([["github.com/team/repo-0", false]]),
		message: "",
	};
	expect(filterRepositories(repositories, state.query)).toHaveLength(11);
	expect(
		getPendingRepositories(repositories, state).map((repo) => repo.key),
	).toEqual(["github.com/team/repo-0"]);
	const screen = renderUploadManager(repositories, state, 80, 24, TEST_THEME);
	expect(screen).toContain("1 UNSAVED");
	expect(stripVTControlCharacters(screen)).toContain("39 ON");
	expect(screen).not.toContain("team/repo-0");
	state.query = "";
	expect(
		stripVTControlCharacters(
			renderUploadManager(repositories, state, 80, 24, TEST_THEME),
		),
	).toMatch(/\* team\/repo-0 \(current\)\s+\[○──\] OFF\s+0/u);
	expect(repositories[0]?.enabled).toBe(true);
});

test("long lists keep controls visible at the bottom while the focused repo scrolls", () => {
	const state: UploadManagerState = {
		query: "",
		cursor: 80,
		desired: new Map(),
		message: "",
	};
	const lines = stripVTControlCharacters(
		renderUploadManager(repositories, state, 80, 16, TEST_THEME),
	).split("\n");
	expect(lines).toHaveLength(15);
	expect(lines.join("\n")).toContain("team/repo-79");
	expect(lines.at(-1)).toContain("Enter review   Esc exit");
	expect(lines.join("\n")).toContain("Space toggle");
	expect(lines.join("\n")).not.toContain("team/repo-0");
});

test("no matches and narrow terminals keep cancel available and sanitize repository names", () => {
	const state: UploadManagerState = {
		query: "missing",
		cursor: 50,
		desired: new Map(),
		message: "",
	};
	expect(
		renderUploadManager(repositories, state, 38, 13, TEST_THEME),
	).toContain("No matching repositories");
	expect(renderUploadManager(repositories, state, 30, 8, TEST_THEME)).toContain(
		"Esc cancel",
	);
	state.query = "";
	state.cursor = 0;
	const repository = repositories[0];
	if (!repository) throw new Error("Missing fixture");
	const screen = renderUploadManager(
		[{ ...repository, name: "bad\u001b[2J\nname" }],
		state,
		80,
		24,
		TEST_THEME,
	);
	expect(
		screen
			.split("\u001b")
			.slice(1)
			.every((sequence) => /^\[(?:[\d;]+m|\d+G)/u.test(sequence)),
	).toBe(true);
	expect(screen.split("\n")).toHaveLength(23);
});

test("arriving rows and growing counts keep the focused row and columns fixed", () => {
	const rows = repositories.slice(0, 13).map((repo) => ({ ...repo }));
	const state: UploadManagerState = {
		query: "",
		cursor: 13,
		followScan: false,
		desired: new Map([["github.com/team/repo-12", false]]),
		message: "",
		scan: { frame: 0 },
	};
	const initial = renderUploadManager(rows, state, 80, 24, TEST_THEME);
	const initialLines = stripVTControlCharacters(initial).split("\n");
	const focusedLine = initialLines.findIndex((line) =>
		line.includes("* team/repo-12"),
	);
	expect(focusedLine).toBeGreaterThan(0);
	rows.push(...repositories.slice(13));
	const first = rows[0];
	if (!first) throw new Error("Missing fixture");
	first.sessionCount = 123456789;
	const growing = renderUploadManager(rows, state, 80, 24, TEST_THEME);
	expect(stripVTControlCharacters(growing).split("\n")[focusedLine]).toContain(
		"* team/repo-12",
	);
	expect(growing.split("\n")[2]?.match(/\[\d+G/u)?.[0]).toBe(
		initial.split("\n")[2]?.match(/\[\d+G/u)?.[0],
	);
	expect(stripVTControlCharacters(growing)).toContain("123.5M");
	expect(state.desired.get("github.com/team/repo-12")).toBe(false);
	state.scan = undefined;
	const complete = renderUploadManager(rows, state, 80, 24, TEST_THEME);
	expect(stripVTControlCharacters(complete).split("\n")[focusedLine]).toContain(
		"› * team/repo-12",
	);
	expect(complete.split("\n")[2]?.match(/\[\d+G/u)?.[0]).toBe(
		initial.split("\n")[2]?.match(/\[\d+G/u)?.[0],
	);
	expect(stripVTControlCharacters(complete)).not.toContain("save after scan");
});

test("discovery follows arriving rows with All repos pinned, then yields to navigation", () => {
	const state: UploadManagerState = {
		query: "",
		cursor: 0,
		desired: new Map(),
		message: "",
		scan: { frame: 0 },
	};
	const first = stripVTControlCharacters(
		renderUploadManager(repositories.slice(0, 4), state, 80, 24, TEST_THEME),
	);
	expect(first).toContain("Scanning repos (4)");
	expect(first.split("\n")[0]?.trim()).toBe("Opaline session upload");
	expect(first).not.toContain("sessions in");
	const later = stripVTControlCharacters(
		renderUploadManager(repositories, state, 80, 24, TEST_THEME),
	);
	expect(later).toContain("team/repo-79");
	expect(later).not.toContain("team/repo-0");
	expect(later.split("\n")[4]).toMatch(/All repos.*MIX\s+3,160/u);
	const start = state.viewportStart;
	state.scan = undefined;
	const complete = stripVTControlCharacters(
		renderUploadManager(repositories, state, 80, 24, TEST_THEME),
	);
	expect(complete).toContain("Repository (80)");
	expect(state.viewportStart).toBe(start);
	state.followScan = false;
	state.cursor = 1;
	const manual = stripVTControlCharacters(
		renderUploadManager(repositories, state, 80, 24, TEST_THEME),
	);
	expect(manual).toContain("› team/repo-0 (current)");
	expect(manual).not.toContain("team/repo-79");
});

test("All repos stays locked until scan completion, then stages hidden rows with individual overrides", () => {
	const state: UploadManagerState = {
		query: "repo-1",
		cursor: 0,
		desired: new Map(),
		message: "",
		scan: { frame: 0 },
	};
	const partial = repositories.slice(0, 3);
	expect(getAllUploadState(partial, state)).toBe("mixed");
	toggleUploadRepository(partial, state);
	expect(state.bulkDesired).toBeUndefined();
	expect(state.desired.size).toBe(0);
	state.scan = undefined;
	toggleUploadRepository(partial, state);
	expect(state.bulkDesired).toBe(true);
	expect(getAllUploadState(repositories, state)).toBe("on");
	expect(getPendingRepositories(repositories, state)).toHaveLength(40);
	state.cursor = 1;
	toggleUploadRepository(repositories, state);
	const second = repositories[1];
	if (!second) throw new Error("Missing fixture");
	expect(getDesiredUploadState(second, state)).toBe(false);
	expect(getAllUploadState(repositories, state)).toBe("mixed");
	expect(getPendingRepositories(repositories, state)).toHaveLength(39);
	state.cursor = 0;
	toggleUploadRepository(repositories, state);
	expect(getAllUploadState(repositories, state)).toBe("on");
	toggleUploadRepository(repositories, state);
	expect(getAllUploadState(repositories, state)).toBe("off");
	expect(getPendingRepositories(repositories, state)).toHaveLength(40);
	expect(repositories[0]?.enabled).toBe(true);
	const ansi = renderUploadManager(repositories, state, 80, 24, TEST_THEME);
	expect(ansi).toContain("\u001b[1;7m 40 UNSAVED ");
	expect(ansi).not.toContain("\u001b[33m");
	state.bulkDesired = undefined;
	expect(getPendingRepositories(repositories, state)).toHaveLength(0);
});

test("review groups new, active and deactivated repos while hiding untouched OFF repos", () => {
	const rows = repositories
		.slice(0, 5)
		.map((repo) => ({ ...repo, uploadedCount: repo.sessionCount }));
	const state: UploadManagerState = {
		query: "repo-1",
		cursor: 0,
		desired: new Map([
			["github.com/team/repo-1", true],
			["github.com/team/repo-2", false],
		]),
		message: "",
	};
	reviewUploadSelection(state);
	expect(state.query).toBe("");
	expect(state.cursor).toBe(0);
	expect(getTableRepositories(rows, state).map((repo) => repo.key)).toEqual([
		"github.com/team/repo-1",
		"github.com/team/repo-0",
		"github.com/team/repo-4",
		"github.com/team/repo-2",
	]);
	const screen = stripVTControlCharacters(
		renderUploadManager(rows, state, 96, 24, TEST_THEME),
	);
	expect(screen).toContain("Opaline session upload");
	expect(screen).not.toContain("Review upload");
	expect(screen).toContain("Selected repos");
	expect(screen).toContain("team/repo-0 (current)");
	expect(screen).toContain("team/repo-1 (new)");
	expect(screen).toContain("team/repo-2");
	expect(screen).not.toContain("team/repo-3");
	expect(screen).toContain("Newly added (1)");
	expect(screen).toContain("Already active (2)");
	expect(screen).toContain("Deactivated (1)");
	expect(screen.indexOf("Newly added")).toBeLessThan(
		screen.indexOf("Already active"),
	);
	expect(screen.indexOf("Already active")).toBeLessThan(
		screen.indexOf("Deactivated"),
	);
	expect(
		screen.split("\n").find((line) => line.includes("Selected repos")),
	).toMatch(/ON\s+5\s+5/u);
	expect(screen).toContain("Confirm selection [ENTER]");
	expect(screen).toContain("Go back [ESC]");
	for (const removed of [
		"UNSAVED",
		"Saved",
		"Space",
		"↑↓",
		"A add",
		"1 turning OFF",
		"of 4 repos",
		"/projects/",
		"› ",
	])
		expect(screen).not.toContain(removed);
	expect(state.reviewControls?.map((control) => control.action)).toEqual([
		"confirm",
		"back",
	]);
	expect(rows.map((repo) => repo.enabled)).toEqual([
		true,
		false,
		true,
		false,
		true,
	]);
});

test("review is read-only and returning to the picker preserves staged choices", () => {
	const rows = repositories.slice(0, 4);
	const state: UploadManagerState = {
		query: "",
		cursor: 0,
		desired: new Map([["github.com/team/repo-1", true]]),
		message: "",
	};
	reviewUploadSelection(state);
	const before = [...state.desired];
	for (const cursor of [0, 1, 2]) {
		state.cursor = cursor;
		toggleUploadRepository(rows, state);
		expect([...state.desired]).toEqual(before);
	}
	editUploadSelection(state);
	expect(getTableRepositories(rows, state)).toHaveLength(4);
	expect([...state.desired]).toEqual(before);
	state.cursor = 1;
	toggleUploadRepository(rows, state);
	state.cursor = 4;
	toggleUploadRepository(rows, state);
	reviewUploadSelection(state);
	expect(getTableRepositories(rows, state).map((repo) => repo.key)).toEqual([
		"github.com/team/repo-1",
		"github.com/team/repo-3",
		"github.com/team/repo-2",
		"github.com/team/repo-0",
	]);
	expect(rows[0]?.enabled).toBe(true);
	state.message = "Save failed: Could not sign in.";
	const retry = stripVTControlCharacters(
		renderUploadManager(rows, state, 96, 24, TEST_THEME),
	);
	expect(retry).toContain(state.message);
	expect(retry).toContain("Confirm selection [ENTER]");
});

test("review of an all-OFF selection retains deactivations without queuing uploads", () => {
	const rows = repositories.slice(1, 5);
	const state: UploadManagerState = {
		query: "",
		cursor: 0,
		desired: new Map(),
		bulkDesired: false,
		message: "",
	};
	reviewUploadSelection(state);
	expect(getTableRepositories(rows, state)).toHaveLength(2);
	expect(getPendingRepositories(rows, state)).toHaveLength(2);
	expect(getRepositoriesToUpload(rows, state)).toHaveLength(0);
	const screen = stripVTControlCharacters(
		renderUploadManager(rows, state, 96, 24, TEST_THEME),
	);
	expect(screen).toContain("Deactivated (2)");
	expect(screen).not.toContain("Already active");
	expect(screen).toContain("Confirm selection [ENTER]");
});

test("completion links cover each destination and keep the focused workspace reachable in a short terminal", () => {
	const rows = repositories.slice(0, 2).map((repo, index) => ({
		...repo,
		enabled: true,
		organizationId: `org-${index}`,
	}));
	const state: UploadManagerState = {
		query: "",
		cursor: 2,
		stage: "upload",
		desired: new Map(),
		message: "",
		completion: {
			kind: "sessions",
			dashboards: [
				{
					organizationId: "org-0",
					url: "https://opaline.so/team-one/sessions",
				},
				{
					organizationId: "org-1",
					url: "https://opaline.so/team-two/sessions",
				},
			],
		},
	};
	const full = renderUploadManager(rows, state, 96, 24, TEST_THEME);
	expect(stripVTControlCharacters(full)).not.toMatch(/↑↓|Space|Enter|Esc/u);
	expect(full).toContain("https://opaline.so/team-one/sessions");
	expect(full).toContain("https://opaline.so/team-two/sessions");
	expect(full).not.toContain("/dashboard/sessions");
	const short = renderUploadManager(rows, state, 38, 13, TEST_THEME);
	expect(short.split("\n").length).toBeLessThanOrEqual(12);
	expect(short).toContain("https://opaline.so/team-two/sessions");
	state.cursor = 1;
	const other = renderUploadManager(rows, state, 38, 13, TEST_THEME);
	expect(other).toContain("https://opaline.so/team-one/sessions");
});

test("review pages expose every grouped repository without overflowing short terminals", () => {
	const rows = repositories.slice(0, 20);
	const state: UploadManagerState = {
		query: "",
		cursor: 0,
		desired: new Map([
			["github.com/team/repo-1", true],
			["github.com/team/repo-2", false],
		]),
		message: "",
	};
	reviewUploadSelection(state);
	const grouped = getTableRepositories(rows, state);
	for (const [columns, height] of [
		[38, 13],
		[80, 16],
	]) {
		if (!columns || !height) throw new Error("Missing dimensions");
		const seen: string[] = [];
		state.reviewPage = 0;
		renderUploadManager(rows, state, columns, height, TEST_THEME);
		const pageCount = state.reviewPageCount ?? 0;
		expect(pageCount).toBeGreaterThan(1);
		for (let page = 0; page < pageCount; page++) {
			state.reviewPage = page;
			const screen = stripVTControlCharacters(
				renderUploadManager(rows, state, columns, height, TEST_THEME),
			);
			const lines = screen.split("\n");
			expect(lines.length).toBeLessThanOrEqual(height - 1);
			expect(screen).toContain(`Page ${page + 1} of ${pageCount}`);
			expect(screen).toContain("Confirm selection [ENTER]");
			expect(screen).toContain("Go back [ESC]");
			expect(screen).not.toContain("/projects/");
			const rowCount =
				lines.filter((line) => /\[[─●○]{3}\]/u.test(line)).length - 1;
			seen.push(
				...grouped
					.slice(state.viewportStart, (state.viewportStart ?? 0) + rowCount)
					.map((repo) => repo.key),
			);
			for (const control of state.reviewControls ?? []) {
				expect(control.line).toBeLessThan(height - 1);
				expect(control.column + control.width).toBeLessThan(columns);
			}
			expect(
				state.reviewControls?.find((control) => control.action === "previous")
					?.disabled,
			).toBe(page === 0);
			expect(
				state.reviewControls?.find((control) => control.action === "next")
					?.disabled,
			).toBe(page === pageCount - 1);
		}
		expect(seen).toEqual(grouped.map((repo) => repo.key));
		state.reviewPage = 999;
		renderUploadManager(rows, state, columns, height, TEST_THEME);
		expect(state.reviewPage).toBe(pageCount - 1);
	}
});
