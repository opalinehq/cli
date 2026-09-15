import { expect, test } from "bun:test";
import {
	parseUploadManagerTheme,
	UPLOAD_MANAGER_THEME,
} from "../lib/upload-manager-theme.js";
import { renderUploadManager } from "../lib/upload-manager-ui.js";

test("theme input rejects invalid layout values and terminal control injection", () => {
	for (const override of [
		{ maxWidth: -1 },
		{ padding: 1.5 },
		{ columnGap: 100 },
		{ showTotals: "yes" },
		{ focus: "blink" },
		{ separators: "\u001b[2J" },
		{ accentColor: "\u001b[2J" },
		{ onColor: "#fff" },
		{ offColor: "constructor" },
		{ motionDuration: -1 },
		{ motionDuration: 401 },
		{ copy: { authCode: "Code removed" } },
		{ copy: { authWaiting: "\u001b[2J" } },
		{ copy: { managerEmpty: "Unexpected {secret}" } },
	]) {
		expect(() =>
			parseUploadManagerTheme({ ...UPLOAD_MANAGER_THEME, ...override }),
		).toThrow();
	}
	expect(() => parseUploadManagerTheme(null)).toThrow();
	expect(() => parseUploadManagerTheme({})).toThrow();
});

test("custom themes render RGB colors and focus without changing repository settings", () => {
	const theme = parseUploadManagerTheme({
		...UPLOAD_MANAGER_THEME,
		accentColor: "#017f67",
		focus: "underline",
		separators: "none",
	});
	const repositories = [
		{
			key: "sample",
			name: "sample",
			paths: ["/sample"],
			enabled: false,
			sessionCount: 1234,
			sources: [],
			current: true,
		},
	];
	const state = {
		query: "",
		cursor: 1,
		desired: new Map<string, boolean>(),
		message: "",
	};
	const screen = renderUploadManager(repositories, state, 80, 24, theme);
	expect(screen).toContain("\u001b[1;38;2;1;127;103mOpaline");
	expect(screen).toContain("\u001b[4msample (current)");
	expect(screen).toContain("1,234");
	expect(screen).not.toContain("─────");
	expect(screen.split("\n")).toHaveLength(23);
	expect(repositories[0]?.enabled).toBe(false);
	expect(state.desired.size).toBe(0);
});
