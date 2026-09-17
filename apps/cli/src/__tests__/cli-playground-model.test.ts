import { expect, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { createPreview } from "../../playground/model.js";
import { SCREENS } from "../../playground/screens.js";
import { cliMessage } from "../lib/cli-messages.js";
import {
	parseUploadManagerTheme,
	UPLOAD_MANAGER_THEME,
} from "../lib/upload-manager-theme.js";

const fixture = {
	theme: UPLOAD_MANAGER_THEME,
	columns: 80,
	rows: 24,
	dataset: "standard",
	state: { query: "", cursor: 0, enabled: {}, desired: {}, message: "" },
};

test("upload playback advances existing counts, preserves OFF repositories and keeps completed totals", () => {
	const off = "github.com/team/website";
	const active = "github.com/team/ios-app";
	const start = createPreview({ ...fixture, screen: "saving", progress: 0 });
	expect(start.uploading).toBe(true);
	expect(stripVTControlCharacters(start.ansi).replace(/\s+/g, " ")).toContain(
		"0 B / —",
	);
	expect(stripVTControlCharacters(start.ansi)).toContain("Queued");
	expect(start.state.uploadKeys).toContain(active);
	expect(start.state.uploadKeys).not.toContain(off);
	const partial = createPreview({
		...fixture,
		screen: "saving",
		progress: 45,
		state: start.state,
	});
	expect(partial.state.uploaded?.[active]).toBeGreaterThan(1100);
	expect(partial.state.uploaded?.[active]).toBeLessThan(1204);
	expect(partial.state.uploaded?.[off]).toBeUndefined();
	expect(stripVTControlCharacters(partial.ansi)).toContain("Uploaded");
	expect(partial.visibleRows.length).toBeGreaterThan(1);
	expect(stripVTControlCharacters(partial.ansi)).not.toContain(
		"Successfully uploaded sessions",
	);
	const complete = createPreview({
		...fixture,
		screen: "saving",
		progress: 100,
		state: partial.state,
	});
	expect(complete.uploading).toBe(false);
	expect(complete.state.uploaded?.[active]).toBe(1204);
	expect(stripVTControlCharacters(complete.ansi)).toContain(
		"Successfully uploaded sessions",
	);
	expect(complete.ansi).toContain("https://opaline.so/acme/sessions");
	const saved = createPreview({
		...fixture,
		screen: "saved",
		state: complete.state,
	});
	expect(saved.state.uploaded?.[active]).toBe(1204);
	expect(saved.uploadTotal).toBe(0);
	expect(stripVTControlCharacters(saved.ansi)).not.toContain("stop upload");
	expect(stripVTControlCharacters(saved.ansi)).toContain(
		"Successfully uploaded sessions",
	);
});

test("each flow can be opened independently using sample data", () => {
	for (const screen of SCREENS) {
		const preview = createPreview({ ...fixture, screen: screen.id });
		expect(preview.screen).toBe(screen.id);
		expect(
			stripVTControlCharacters(preview.ansi).trim().length,
		).toBeGreaterThan(0);
		if (!screen.manager) expect(preview.visibleRows).toHaveLength(0);
	}
	const destination = createPreview({
		...fixture,
		screen: "destination",
		choice: 2,
	});
	expect(destination.choices).toHaveLength(3);
	expect(stripVTControlCharacters(destination.ansi)).toContain(
		"●  Design studio",
	);
	expect(() => createPreview({ ...fixture, screen: "unknown" })).toThrow();
	expect(() => createPreview({ ...fixture, progress: 101 })).toThrow();
});

test("new-user completion links to browser setup without a dashboard link or navigation legend", () => {
	for (const [columns, rows] of [
		[80, 24],
		[38, 13],
	]) {
		const result = createPreview({
			...fixture,
			columns,
			rows,
			screen: "saved-new",
			state: { ...fixture.state, uploadSucceeded: true },
		});
		const text = stripVTControlCharacters(result.ansi);
		expect(result.state.stage).toBe("upload");
		expect(text).toContain("Successfully uploaded sessions");
		expect(text).toContain("Continue your setup in the browser");
		expect(result.ansi).toContain("\u001b]8;;https://opaline.so/welcome\u0007");
		expect(text).not.toContain("acme/sessions");
		expect(text).not.toMatch(/↑↓|Space|Enter|Esc/u);
		expect(text.split("\n").length).toBeLessThanOrEqual((rows ?? 0) - 1);
	}
});

test("copy keeps dynamic values and is shared by CLI output and flow previews", () => {
	const theme = parseUploadManagerTheme({
		...UPLOAD_MANAGER_THEME,
		copy: {
			...UPLOAD_MANAGER_THEME.copy,
			scanHeading: "Discovering repos",
			authCode: "Approve code {code}",
		},
	});
	const preview = createPreview({
		...fixture,
		theme,
		screen: "scan",
		progress: 100,
	});
	expect(stripVTControlCharacters(preview.ansi)).toContain("Repository (15)");
	const scanning = createPreview({
		...fixture,
		theme,
		screen: "scan",
		progress: 50,
	});
	expect(stripVTControlCharacters(scanning.ansi)).toMatch(
		/Discovering repos \(\d+\)/u,
	);
	const login = createPreview({ ...fixture, theme, screen: "login" });
	expect(stripVTControlCharacters(login.ansi)).toContain(
		"Approve code DEMO-1234",
	);
	expect(
		cliMessage("authCode", { code: "bad\u001b[2Jcode" }, theme),
	).not.toContain("\u001b");
});

test("discovery fills the same table and preserves choices through completion", () => {
	const empty = createPreview({ ...fixture, screen: "scan", progress: 0 });
	expect(empty.scanning).toBe(true);
	expect(empty.visibleRows).toEqual([
		{ line: 4, index: 0, key: "all-repos", name: "All repos" },
	]);
	expect(stripVTControlCharacters(empty.ansi)).toContain(
		"Finding repositories",
	);
	expect(stripVTControlCharacters(empty.ansi)).not.toMatch(
		/Select repos after scan|cancel scan/u,
	);
	const partial = createPreview({ ...fixture, screen: "scan", progress: 20 });
	expect(partial.repositories.length).toBeGreaterThan(0);
	expect(partial.repositories.length).toBeLessThan(15);
	const state = {
		...partial.state,
		desired: { "github.com/team/opaline": false },
		cursor: 1,
	};
	const later = createPreview({
		...fixture,
		state,
		screen: "scan",
		progress: 60,
	});
	expect(later.repositories.slice(0, partial.repositories.length)).toEqual(
		partial.repositories,
	);
	expect(later.state.desired).toEqual(state.desired);
	expect(later.state.cursor).toBe(1);
	const complete = createPreview({
		...fixture,
		state: later.state,
		screen: "scan",
		progress: 100,
	});
	expect(complete.scanning).toBe(false);
	expect(complete.repositories).toHaveLength(15);
	expect(complete.pendingCount).toBe(1);
	expect(complete.state.cursor).toBe(1);
	expect(complete.state.desired).toEqual(state.desired);
	expect(stripVTControlCharacters(complete.ansi)).toMatch(/All repos.*1,911/u);
	expect(stripVTControlCharacters(complete.ansi)).toContain("Enter review");
	expect(stripVTControlCharacters(complete.ansi)).not.toContain("after scan");
});

test("All repos choices survive preview updates and keep the pending footer", () => {
	const initial = createPreview(fixture);
	const desired = Object.fromEntries(initial.allKeys.map((key) => [key, true]));
	const complete = createPreview({
		...fixture,
		state: { ...fixture.state, desired },
	});
	expect(complete.allState).toBe("on");
	expect(complete.pendingCount).toBe(10);
	expect(complete.state.desired).toEqual(desired);
	const edited = createPreview({
		...fixture,
		screen: "saved",
		state: { ...fixture.state, desired },
	});
	expect(stripVTControlCharacters(edited.ansi)).toContain("10 changes pending");
	expect(stripVTControlCharacters(edited.ansi)).not.toContain(
		"Saved 2 changes",
	);
});

test("review keeps saved ON repos and new choices visible without saving or uploading", () => {
	const off = "github.com/team/payments-api";
	const added = "github.com/team/website";
	const existing = "github.com/team/opaline";
	const review = createPreview({
		...fixture,
		screen: "review",
		state: { ...fixture.state, desired: { [added]: true } },
	});
	expect(review.state.enabled).toEqual({});
	expect(review.state.desired).toEqual({ [added]: true });
	expect(review.state.uploaded).toEqual({});
	expect(review.uploading).toBe(false);
	expect(review.reviewControls.map((control) => control.action)).toEqual([
		"confirm",
		"back",
	]);
	expect(review.repositories.map((repo) => repo.key)).toContain(existing);
	expect(review.repositories.map((repo) => repo.key)).toContain(added);
	expect(review.repositories.map((repo) => repo.key)).not.toContain(off);
	expect(review.uploadKeys).not.toContain(existing);
	expect(stripVTControlCharacters(review.ansi)).toContain("website (new)");
	expect(stripVTControlCharacters(review.ansi)).not.toContain(
		"opaline (current) (new)",
	);
	const edit = createPreview({
		...fixture,
		screen: "repositories",
		state: review.state,
	});
	expect(edit.repositories).toHaveLength(15);
	expect(edit.state.desired).toEqual({ [added]: true });
	const upload = createPreview({
		...fixture,
		screen: "saving",
		progress: 45,
		state: { ...review.state, enabled: { [added]: true }, desired: {} },
	});
	expect(upload.repositories.map((repo) => repo.key)).not.toContain(off);
	expect(upload.repositories.map((repo) => repo.key)).toContain(existing);
	expect(upload.state.uploaded?.[added]).toBeGreaterThan(0);
});

test("review page metadata stays aligned with visible rows and selected actions", () => {
	let preview = createPreview({
		...fixture,
		screen: "review",
		dataset: "long",
		rows: 13,
		columns: 38,
	});
	const seen: string[] = [];
	const pages = preview.state.reviewPageCount ?? 0;
	expect(pages).toBeGreaterThan(1);
	for (let page = 0; page < pages; page++) {
		preview = createPreview({
			...fixture,
			screen: "review",
			dataset: "long",
			rows: 13,
			columns: 38,
			state: { ...preview.state, reviewPage: page, reviewAction: "back" },
		});
		expect(preview.state.reviewPage).toBe(page);
		expect(preview.state.reviewAction).toBe("back");
		const lines = stripVTControlCharacters(preview.ansi).split("\n");
		for (const row of preview.visibleRows.filter((row) => row.index > 0)) {
			seen.push(row.key);
			expect(lines[row.line]).toContain("[──●]");
			expect(preview.repositories[row.index - 1]?.key).toBe(row.key);
		}
		for (const control of preview.reviewControls.filter((control) =>
			["confirm", "back"].includes(control.action),
		))
			expect(
				lines[control.line]
					?.slice(control.column, control.column + control.width)
					.trim(),
			).toBe(control.label);
	}
	expect(seen).toEqual(preview.repositories.map((repo) => repo.key));
});
