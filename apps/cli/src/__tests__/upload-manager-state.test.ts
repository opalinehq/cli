import { expect, test } from "bun:test";
import { createPreview } from "../../playground/model.js";
import {
	activateUploadReview,
	applyUploadKey,
	getTableRepositories,
	type UploadManagerState,
} from "../lib/upload-manager-state.js";
import { UPLOAD_MANAGER_THEME } from "../lib/upload-manager-theme.js";

const previewRequest = {
	theme: UPLOAD_MANAGER_THEME,
	columns: 80,
	rows: 24,
	dataset: "standard",
	state: { query: "", cursor: 0, enabled: {}, desired: {}, message: "" },
};

test("scan locks selection; review pages and Go back preserve the same choices in terminal and browser", () => {
	const preview = createPreview(previewRequest);
	const repositories = preview.selectionRepositories;
	const state: UploadManagerState = {
		...preview.state,
		desired: new Map(),
		scan: { frame: 0 },
	};
	for (const name of ["space", "return", "down", "a"])
		expect(applyUploadKey(repositories, state, { name })).toBe("ignored");
	expect(state.desired.size).toBe(0);
	state.scan = undefined;
	applyUploadKey(repositories, state, { name: "space" });
	expect([...state.desired.values()].every(Boolean)).toBe(true);
	applyUploadKey(repositories, state, { name: "return" });
	expect(state.stage).toBe("review");
	const browser = createPreview({
		...previewRequest,
		screen: "review",
		state: {
			...state,
			enabled: {},
			desired: Object.fromEntries(state.desired),
		},
	});
	expect(browser.repositories.map((repo) => repo.key)).toEqual(
		getTableRepositories(repositories, state).map((repo) => repo.key),
	);
	expect(applyUploadKey(repositories, state, { name: "space" })).toBe(
		"ignored",
	);
	state.reviewPageCount = 3;
	applyUploadKey(repositories, state, { name: "pagedown" });
	expect(state.reviewPage).toBe(1);
	applyUploadKey(repositories, state, { name: "tab" });
	expect(state.reviewAction).toBe("back");
	expect(applyUploadKey(repositories, state, { name: "return" })).toBe(
		"changed",
	);
	expect(state.stage).toBeUndefined();
	expect([...state.desired.values()].every(Boolean)).toBe(true);
	expect(repositories.filter((repo) => repo.enabled)).toHaveLength(5);
	applyUploadKey(repositories, state, { name: "return" });
	expect(activateUploadReview(state, "confirm")).toBe("save");
	expect([...state.desired.values()].every(Boolean)).toBe(true);
});

test("keyboard and clicked review controls produce the same selection state", () => {
	const rows = createPreview(previewRequest).selectionRepositories;
	const keyboard: UploadManagerState = {
		query: "",
		cursor: 0,
		message: "",
		desired: new Map(),
		stage: "review",
		reviewPageCount: 4,
	};
	const clicked = structuredClone(keyboard);
	applyUploadKey(rows, keyboard, { name: "pagedown" });
	activateUploadReview(clicked, "next");
	expect(keyboard).toEqual(clicked);
	applyUploadKey(rows, keyboard, { name: "escape" });
	activateUploadReview(clicked, "back");
	expect(keyboard).toEqual(clicked);
});

test("a running upload cannot change the selection and paired completion cannot start another upload", () => {
	const rows = createPreview(previewRequest).selectionRepositories;
	const state: UploadManagerState = {
		query: "",
		cursor: 0,
		message: "",
		desired: new Map(),
		stage: "upload",
		operation: { frame: 0, label: "Uploading" },
		singleRun: true,
	};
	for (const name of ["space", "return", "a", "tab"])
		expect(applyUploadKey(rows, state, { name })).toBe("ignored");
	expect(applyUploadKey(rows, state, { name: "escape" })).toBe("cancel");
	state.operation = undefined;
	expect(applyUploadKey(rows, state, { name: "return" })).toBe("cancel");
	expect(applyUploadKey(rows, state, { name: "space" })).toBe("ignored");
	expect(state.desired.size).toBe(0);
});
