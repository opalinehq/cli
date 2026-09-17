import {
	activateUploadReview,
	applyUploadKey,
	toggleUploadRepository,
	type UploadKey,
	type UploadManagerState,
} from "../src/lib/upload-manager-state.js";
import {
	parseUploadManagerTheme,
	UPLOAD_MANAGER_THEME,
	type UploadManagerTheme,
} from "../src/lib/upload-manager-theme.js";
import type { DemoState, PreviewRequest, PreviewResponse } from "./model.js";
import { animateScreen, animateSwitches, captureSwitches } from "./motion.js";
import {
	getUploadFlow,
	isUploadCompleteScreen,
	SCREENS,
	screenById,
} from "./screens.js";
import {
	renderAnsiLines,
	type TerminalMode,
	terminalPalette,
} from "./terminal.js";

const DRAFT_KEY = "opaline-cli-playground-v1";
const PLAYBACK = {
	tick: 100,
	screen: 1800,
	scan: 2400,
	login: 2600,
	saving: 30_000,
};
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const terminal = element("terminal", HTMLDivElement);
const terminalWindow = element("terminal-window", HTMLDivElement);
const saveStatus = element("save-status", HTMLParagraphElement);
const applyButton = element("apply-theme", HTMLButtonElement);
const errorNotice = element("error", HTMLDivElement);
let savedTheme = structuredClone(UPLOAD_MANAGER_THEME);
let theme = structuredClone(savedTheme);
let state: DemoState = emptyDemo();
let preview: PreviewResponse | undefined;
let mode: TerminalMode = "dark";
let closed = false;
let applying = false;
let justApplied = false;
let requestVersion = 0;
let previewTimer = 0;
let interactions = Promise.resolve();
let currentScreen = "scan";
let displayedScreen = "";
let choice = 0;
let frame = 0;
let progress = 0;
let playback: "flow" | "screen" | "save" | undefined;
let playbackTimer = 0;
let playbackVersion = 0;
let interactionVersion = 0;
let savedChangeCount = 2;
let savedUploadCount = 0;
let showSavedConfirmation = true;
let stopAfterScan = false;

await boot().catch(showError);

async function boot() {
	if (window.matchMedia("(max-width: 780px)").matches)
		input("columns").value = "38";
	savedTheme = parseUploadManagerTheme(await requestJson("/api/theme"));
	theme = structuredClone(savedTheme);
	try {
		const draft: unknown = JSON.parse(
			localStorage.getItem(DRAFT_KEY) ?? "null",
		);
		if (
			typeof draft === "object" &&
			draft !== null &&
			"base" in draft &&
			"theme" in draft &&
			draft.base === JSON.stringify(savedTheme)
		)
			theme = parseUploadManagerTheme(draft.theme);
	} catch {
		localStorage.removeItem(DRAFT_KEY);
	}
	bindControls();
	populateScreens();
	syncScreen();
	syncControls();
	await refreshPreview();
	startPlayback("screen");
}

function bindControls() {
	const sliders: ("maxWidth" | "padding" | "columnGap" | "motionDuration")[] = [
		"maxWidth",
		"padding",
		"columnGap",
		"motionDuration",
	];
	for (const key of sliders)
		input(key).addEventListener("input", () => {
			theme[key] = input(key).valueAsNumber;
			themeChanged();
		});
	const toggles: (
		| "showSummary"
		| "showTotals"
		| "showRepoIdentity"
		| "dimSecondary"
	)[] = ["showSummary", "showTotals", "showRepoIdentity", "dimSecondary"];
	for (const key of toggles)
		input(key).addEventListener("change", () => {
			theme[key] = input(key).checked;
			themeChanged();
		});
	const colors: ("accentColor" | "onColor" | "offColor")[] = [
		"accentColor",
		"onColor",
		"offColor",
	];
	for (const key of colors)
		input(key).addEventListener("input", () => {
			theme[key] = input(key).value;
			themeChanged();
		});
	select("separators").addEventListener("change", () => {
		const value = select("separators").value;
		if (value === "line" || value === "dots" || value === "none")
			theme.separators = value;
		themeChanged();
	});
	select("focus").addEventListener("change", () => {
		const value = select("focus").value;
		if (value === "inverse" || value === "bold" || value === "underline")
			theme.focus = value;
		themeChanged();
	});
	for (const key of ["columns", "rows"])
		input(key).addEventListener("input", () => {
			if (input(key).checkValidity()) schedulePreview();
		});
	select("font-size").addEventListener("change", () => redrawTerminal());
	select("dataset").addEventListener("change", () => {
		stopPlayback();
		requestVersion++;
		interactionVersion++;
		state = emptyDemo();
		closed = false;
		schedulePreview();
	});
	select("workspaces").addEventListener("change", () => {
		stopPlayback();
		populateScreens();
		if (currentScreen === "destination" && workspaceCount() === 1)
			changeScreen("review", false);
		else syncScreen();
		schedulePreview();
	});
	button("dark").addEventListener("click", () => setMode("dark"));
	button("light").addEventListener("click", () => setMode("light"));
	button("terminal-colors").addEventListener("click", () => {
		theme.accentColor = "cyan";
		theme.onColor = "green";
		theme.offColor = "red";
		themeChanged();
	});
	button("reset-theme").addEventListener("click", () => {
		theme = structuredClone(savedTheme);
		themeChanged();
	});
	button("reset-demo").addEventListener("click", () =>
		interact(() => {
			changeScreen(currentScreen);
		}),
	);
	button("save-demo").addEventListener("click", () => interact(saveDemo));
	button("edit-repos").addEventListener("click", () => interact(editSelection));
	select("screen").addEventListener("change", () => {
		stopPlayback();
		changeScreen(select("screen").value);
		if (currentScreen === "scan") startPlayback("screen");
		else schedulePreview();
	});
	button("previous-screen").addEventListener("click", () => navigateScreen(-1));
	button("next-screen").addEventListener("click", () => navigateScreen(1));
	button("play-flow").addEventListener("click", () => {
		if (playback) stopPlayback();
		else {
			changeScreen("scan");
			startPlayback("flow");
		}
	});
	button("replay-motion").addEventListener("click", () => {
		stopPlayback();
		if (screenById(currentScreen).loading) startPlayback("screen");
		else if (screenById(currentScreen).manager) interact(toggleFocused);
		else redrawTerminal(true);
	});
	input("progress").addEventListener("input", () => {
		stopPlayback();
		progress = input("progress").valueAsNumber;
		requestVersion++;
		schedulePreview();
	});
	input("screen-duration").addEventListener("input", () => {
		element("screen-duration-value", HTMLOutputElement).textContent =
			`${input("screen-duration").value} ms`;
		redrawTerminal(true);
	});
	reducedMotion.addEventListener("change", () => {
		if (reducedMotion.matches)
			for (const animation of terminal.getAnimations({ subtree: true }))
				animation.cancel();
	});
	applyButton.addEventListener("click", () => {
		void applyTheme().catch(showError);
	});
	button("copy-theme").addEventListener("click", () => {
		void navigator.clipboard
			.writeText(JSON.stringify(theme, null, 2))
			.then(() => {
				element("copy-status", HTMLSpanElement).textContent = "Copied";
			})
			.catch(showError);
	});
	terminal.addEventListener(
		"wheel",
		(event) => {
			if (closed || state.stage !== "upload") return;
			event.preventDefault();
			interact(() =>
				handleManagerKey({ name: event.deltaY > 0 ? "pagedown" : "pageup" }),
			);
		},
		{ passive: false },
	);
	terminal.addEventListener("keydown", (event) => {
		if (closed) return;
		if (["Shift", "Control", "Alt", "Meta"].includes(event.key)) return;
		if (event.key === "Tab" && state.stage !== "review") return;
		if (
			event.metaKey ||
			event.altKey ||
			(event.ctrlKey && event.key !== "u" && event.key !== "c")
		)
			return;
		event.preventDefault();
		if (
			isScanning() &&
			event.key !== "Escape" &&
			!(event.ctrlKey && event.key === "c")
		)
			return;
		interact(() => {
			if (!screenById(currentScreen).manager) {
				if (
					currentScreen === "destination" &&
					["ArrowDown", "ArrowUp"].includes(event.key)
				)
					choice = (choice + (event.key === "ArrowDown" ? 1 : 2)) % 3;
				else if (event.key === "Enter") advanceFlow();
				else if (event.key === "Escape") changeScreen("repositories");
				return;
			}
			const keys: Record<string, string> = {
				Enter: "return",
				Escape: "escape",
				ArrowUp: "up",
				ArrowDown: "down",
				ArrowLeft: "left",
				ArrowRight: "right",
				PageUp: "pageup",
				PageDown: "pagedown",
				Tab: "tab",
				Backspace: "backspace",
				" ": "space",
			};
			handleManagerKey({
				name: keys[event.key] ?? event.key,
				text: event.key.length === 1 ? event.key : undefined,
				ctrl: event.ctrlKey,
				meta: event.metaKey,
			});
		});
	});
}

function themeChanged() {
	justApplied = false;
	element("copy-status", HTMLSpanElement).textContent = "";
	syncControls();
	try {
		localStorage.setItem(
			DRAFT_KEY,
			JSON.stringify({ base: JSON.stringify(savedTheme), theme }),
		);
	} catch {
		/* Browser storage is optional. */
	}
	schedulePreview();
}

function syncControls() {
	for (const key of [
		"maxWidth",
		"padding",
		"columnGap",
		"motionDuration",
	] satisfies (keyof UploadManagerTheme)[]) {
		input(key).value = String(theme[key]);
		element(`${key}-value`, HTMLOutputElement).textContent =
			`${theme[key]} ${key === "motionDuration" ? "ms" : "cols"}`;
	}
	for (const key of [
		"showSummary",
		"showTotals",
		"showRepoIdentity",
		"dimSecondary",
	] satisfies (keyof UploadManagerTheme)[])
		input(key).checked = theme[key];
	select("focus").value = theme.focus;
	select("separators").value = theme.separators;
	const palette = terminalPalette(mode);
	const terminalColors: Record<string, string> = {
		yellow: palette.colors[3] ?? "#e5bf73",
		blue: palette.colors[4] ?? "#82a9dd",
		magenta: palette.colors[5] ?? "#c798cd",
		white: palette.colors[7] ?? "#dddcd7",
		cyan: palette.colors[6] ?? "#80c9d4",
		green: palette.colors[2] ?? "#8ccc91",
		red: palette.colors[1] ?? "#eb7b7b",
	};
	for (const key of [
		"accentColor",
		"onColor",
		"offColor",
	] satisfies (keyof UploadManagerTheme)[]) {
		input(key).value = terminalColors[theme[key]] ?? theme[key];
		element(`${key}-value`, HTMLOutputElement).textContent = theme[
			key
		].startsWith("#")
			? theme[key].toUpperCase()
			: `Terminal ${theme[key]}`;
	}
	element("theme-json", HTMLPreElement).textContent = JSON.stringify(
		theme,
		null,
		2,
	);
	const dirty = JSON.stringify(theme) !== JSON.stringify(savedTheme);
	element("theme-status", HTMLParagraphElement).textContent = dirty
		? "Unapplied changes"
		: "Current CLI theme";
	saveStatus.textContent = applying
		? "Building local CLI…"
		: dirty
			? "Changes previewed locally"
			: justApplied
				? "Applied to local CLI"
				: "Matches local CLI";
	applyButton.disabled = applying;
	applyButton.textContent = applying ? "Applying…" : "Apply to CLI ↗";
	for (const { key } of screenById(currentScreen).copy) {
		const field = document.getElementById(`copy-${key}`);
		if (
			field instanceof HTMLTextAreaElement &&
			document.activeElement !== field
		)
			field.value = theme.copy[key];
	}
}

function schedulePreview() {
	clearTimeout(previewTimer);
	previewTimer = window.setTimeout(() => {
		void refreshPreview().catch(showError);
	}, 60);
}

async function refreshPreview() {
	const version = ++requestVersion;
	const body: PreviewRequest = {
		theme,
		columns: input("columns").valueAsNumber,
		rows: input("rows").valueAsNumber,
		dataset: select("dataset").value,
		state:
			isUploadCompleteScreen(currentScreen) && showSavedConfirmation
				? {
						...state,
						message: savedUploadCount
							? theme.copy.uploadSummary.replace(
									"{count}",
									String(savedUploadCount),
								)
							: theme.copy.saveSummary.replace(
									"{changes}",
									`${savedChangeCount} change${savedChangeCount === 1 ? "" : "s"}`,
								),
					}
				: state,
		screen: currentScreen,
		progress,
		frame,
		choice,
	};
	const next = await requestJson<PreviewResponse>("/api/preview", body);
	if (version !== requestVersion) return;
	preview = next;
	state = next.state;
	button("save-demo").disabled = next.scanning || next.uploading;
	button("save-demo").textContent = next.uploading
		? "Uploading…"
		: state.error || state.uploadFailed
			? "Retry upload"
			: next.scanning
				? "Review after scan"
				: currentScreen === "review"
					? "Confirm upload"
					: "Review selection";
	button("save-demo").hidden =
		!screenById(currentScreen).manager || state.stage === "review";
	button("edit-repos").hidden =
		!state.stage ||
		state.stage === "review" ||
		next.uploading ||
		state.uploadFailed === true;
	// The saved confirmation is derived from the current theme on every preview.
	if (isUploadCompleteScreen(currentScreen) && showSavedConfirmation)
		state.message = "";
	errorNotice.hidden = true;
	redrawTerminal();
}

function redrawTerminal(replay = false) {
	if (!preview) return;
	const previous = captureSwitches(terminal);
	const changedScreen =
		displayedScreen !== preview.screen &&
		!(
			displayedScreen &&
			screenById(displayedScreen).manager &&
			screenById(preview.screen).manager
		);
	displayedScreen = preview.screen;
	const palette = terminalPalette(mode);
	const fontSize = Number(select("font-size").value);
	terminalWindow.style.setProperty("--terminal-bg", palette.background);
	terminalWindow.style.setProperty("--terminal-fg", palette.foreground);
	terminalWindow.style.setProperty("--terminal-size", `${fontSize}px`);
	terminalWindow.style.setProperty(
		"--terminal-line",
		`${Math.round(fontSize * 1.57)}px`,
	);
	terminal.style.setProperty("--columns", input("columns").value);
	terminalWindow.style.setProperty("--columns", input("columns").value);
	terminal.style.setProperty("--rows", input("rows").value);
	element("dimensions", HTMLOutputElement).textContent =
		`${input("columns").value} × ${input("rows").value}`;
	input("progress").value = String(progress);
	element("progress-value", HTMLOutputElement).textContent = `${progress}%`;
	if (closed) {
		const message = document.createElement("div");
		message.className = "closed-preview";
		message.textContent =
			"Preview closed. Unsaved demo changes were discarded.";
		const reopen = document.createElement("button");
		reopen.type = "button";
		reopen.textContent = "Reopen preview";
		reopen.addEventListener("click", () => {
			closed = false;
			redrawTerminal();
			terminal.focus({ preventScroll: true });
		});
		message.append(reopen);
		terminal.replaceChildren(message);
		return;
	}
	const lines = renderAnsiLines(preview.ansi, mode);
	for (const repo of preview.visibleRows) {
		const row = lines[repo.line];
		if (!row) continue;
		row.dataset.repository = repo.key;
		if (state.stage) continue;
		const action = document.createElement("button");
		action.type = "button";
		action.tabIndex = -1;
		action.setAttribute("aria-label", `Toggle auto upload for ${repo.name}`);
		action.disabled =
			preview.scanning ||
			preview.uploading ||
			state.uploadFailed === true ||
			!!(state.stage && repo.index === 0);
		action.addEventListener("click", () => {
			if (isScanning()) return;
			terminal.focus({ preventScroll: true });
			interact(() => {
				state.cursor = repo.index;
				state.selectionVisible = true;
				if (repo.index > 0) state.followScan = false;
				toggleFocused();
			});
		});
		row.append(action);
	}
	for (const control of preview.reviewControls) {
		const row = lines[control.line];
		if (!row) continue;
		const action = document.createElement("button");
		action.type = "button";
		action.tabIndex = -1;
		action.dataset.reviewAction = control.action;
		action.setAttribute("aria-label", control.label);
		if (control.action === "confirm" || control.action === "back")
			action.setAttribute(
				"aria-pressed",
				String((state.reviewAction ?? "confirm") === control.action),
			);
		action.disabled = control.disabled;
		action.style.left = `${control.column}ch`;
		action.style.right = "auto";
		action.style.width = `${control.width}ch`;
		action.addEventListener("click", () => {
			terminal.focus({ preventScroll: true });
			interact(() => activateReview(control.action));
		});
		row.append(action);
	}
	for (const option of preview.choices) {
		const row = lines[option.line];
		if (!row) continue;
		const action = document.createElement("button");
		action.type = "button";
		action.tabIndex = -1;
		action.setAttribute("aria-label", `Choose ${option.label}`);
		action.setAttribute("aria-pressed", String(choice === option.index));
		action.addEventListener("click", () =>
			interact(() => {
				choice = option.index;
				terminal.focus({ preventScroll: true });
			}),
		);
		row.append(action);
	}
	terminal.replaceChildren(...lines);
	const speed = Number(select("playback-speed").value);
	if (!reducedMotion.matches) {
		if (changedScreen || replay)
			animateScreen(terminal, input("screen-duration").valueAsNumber / speed);
		else animateSwitches(terminal, previous, theme.motionDuration / speed);
	}
}

function interact(action: () => void) {
	// Preview controls can leave discovery or upload playback running.
	if (!preview?.uploading && (currentScreen !== "scan" || !preview?.scanning))
		stopPlayback();
	else stopAfterScan = true;
	const version = interactionVersion;
	interactions = interactions
		.then(async () => {
			if (version !== interactionVersion) return;
			action();
			await refreshPreview();
		})
		.catch(showError);
}

function updateManager(
	action: (
		manager: UploadManagerState,
	) => "save" | "cancel" | "changed" | "ignored",
) {
	if (!preview) return;
	const manager: UploadManagerState = {
		...state,
		desired: new Map(Object.entries(state.desired)),
		scan: isScanning() ? { frame } : undefined,
		operation: preview.uploading ? { label: "Uploading", frame } : undefined,
	};
	const result = action(manager);
	if (result === "ignored") return;
	const { desired, scan: _scan, operation: _operation, ...selection } = manager;
	state = { ...state, ...selection, desired: Object.fromEntries(desired) };
	if (result === "cancel") {
		stopPlayback();
		state.desired = {};
		closed = true;
	} else if (result === "save") startDemoUpload();
	else {
		if (manager.stage === "review" && currentScreen !== "review")
			changeScreen("review", false);
		else if (
			!manager.stage &&
			!manager.error &&
			currentScreen !== "repositories" &&
			currentScreen !== "repair" &&
			!isScanning()
		)
			changeScreen("repositories", false);
		showSavedConfirmation = false;
		state.uploadSucceeded = false;
	}
}

function handleManagerKey(key: UploadKey) {
	updateManager((manager) =>
		applyUploadKey(preview?.selectionRepositories ?? [], manager, key),
	);
}

function toggleFocused() {
	updateManager((manager) => {
		if (
			manager.scan ||
			manager.operation ||
			manager.error ||
			manager.stage === "review"
		)
			return "ignored";
		toggleUploadRepository(preview?.selectionRepositories ?? [], manager);
		return "changed";
	});
}

function activateReview(action: "confirm" | "back" | "previous" | "next") {
	updateManager((manager) => activateUploadReview(manager, action));
}

function saveDemo() {
	handleManagerKey({
		name: state.completion && state.uploadFailed ? "r" : "return",
	});
}

function editSelection() {
	handleManagerKey({ name: "escape" });
}

function startDemoUpload() {
	const count = preview?.pendingCount ?? 0;
	state.enabled = { ...state.enabled, ...state.desired };
	state.desired = {};
	savedChangeCount = count;
	savedUploadCount = preview?.uploadTotal ?? 0;
	state.uploadKeys = preview?.uploadKeys;
	state.uploadStart = {};
	state.uploadSucceeded = false;
	if (select("dataset").value === "repair")
		select("dataset").value = "standard";
	changeScreen("saving", false);
	startPlayback("save");
}

function isScanning(): boolean {
	return (
		currentScreen === "scan" && (progress < 100 || preview?.scanning === true)
	);
}

function populateScreens() {
	const menu = select("screen");
	const screens = availableScreens();
	menu.replaceChildren();
	for (const group of new Set(screens.map((screen) => screen.group))) {
		const options = document.createElement("optgroup");
		options.label = group;
		for (const screen of screens.filter((screen) => screen.group === group)) {
			const option = document.createElement("option");
			option.value = screen.id;
			option.textContent = screen.label;
			options.append(option);
		}
		menu.append(options);
	}
}

function workspaceCount(): number {
	return Number(select("workspaces").value);
}

function availableScreens() {
	return SCREENS.filter(
		(screen) => screen.id !== "destination" || workspaceCount() > 1,
	);
}

function changeScreen(id: string, reset = true) {
	currentScreen = screenById(id).id;
	showSavedConfirmation = isUploadCompleteScreen(id);
	requestVersion++;
	interactionVersion++;
	closed = false;
	choice = 0;
	frame = 0;
	progress = 0;
	if (reset) {
		state = emptyDemo();
		if (id === "repair" || id === "empty") select("dataset").value = id;
		savedChangeCount = 2;
		savedUploadCount = 0;
		if (id === "pending" || id === "review" || isUploadCompleteScreen(id)) {
			select("dataset").value = "standard";
			const changes = {
				"github.com/team/opaline": false,
				"github.com/team/website": true,
			};
			if (!isUploadCompleteScreen(id)) state.desired = changes;
			else {
				state.enabled = changes;
				state.uploadSucceeded = true;
			}
		}
	}
	state.stage =
		id === "review"
			? "review"
			: id === "saving" || isUploadCompleteScreen(id)
				? "upload"
				: undefined;
	if (isUploadCompleteScreen(id)) state.selectionVisible = false;
	if (id === "review") {
		state.cursor = 0;
		state.selectionVisible = false;
		state.reviewPage = 0;
		state.reviewAction = "confirm";
		state.viewportStart = 0;
	}
	syncScreen();
}

function syncScreen() {
	const screen = screenById(currentScreen);
	const screens = availableScreens();
	const index = screens.indexOf(screen);
	select("screen").value = screen.id;
	element("screen-position", HTMLOutputElement).textContent =
		`${index + 1} / ${screens.length}`;
	button("previous-screen").disabled = index === 0;
	button("next-screen").disabled = index === screens.length - 1;
	element("screen-description", HTMLParagraphElement).textContent =
		screen.description;
	element("terminal-command", HTMLDivElement).textContent = screen.command;
	element("terminal-help", HTMLParagraphElement).hidden =
		screen.id === "error" ||
		screen.id === "scan" ||
		screen.id === "saving" ||
		isUploadCompleteScreen(screen.id);
	element("terminal-help", HTMLParagraphElement).textContent =
		screen.id === "scan"
			? "Repositories fill the table automatically. Selection and toggles become available after scanning. Esc cancels."
			: screen.manager
				? screen.id === "saving"
					? "Upload counts update in the table."
					: screen.id === "review"
						? "Review your selection, then confirm or go back to edit. ←→ or Tab selects an action; ↑↓ or Page Up/Down changes pages when needed."
						: screen.id.startsWith("upload-partial") ||
								screen.id === "upload-failures" ||
								isUploadCompleteScreen(screen.id)
							? "Scroll or use arrow keys to page through session details."
							: "Click a repo to toggle. Enter reviews selected repos before saving or uploading."
				: screen.id === "destination"
					? "↑↓ select an organization · Enter continue · Esc back."
					: "Enter continues the sample flow. Use the screen menu to jump anywhere.";
	button("save-demo").hidden = !screen.manager || screen.id === "review";
	button("edit-repos").hidden =
		!state.stage || screen.id === "review" || screen.id === "saving";
	button("save-demo").disabled = screen.id === "scan" && progress < 100;
	button("replay-motion").textContent =
		screen.id === "scan" ? "Replay scan" : "Replay motion";
	select("dataset").disabled =
		!screen.manager || ["empty", "repair"].includes(screen.id);
	element("progress-control", HTMLLabelElement).hidden = !screen.loading;
	element("layout-scope", HTMLParagraphElement).hidden = screen.manager;
	for (const fieldset of document.querySelectorAll<HTMLFieldSetElement>(
		"fieldset[data-manager]",
	)) {
		fieldset.disabled = !screen.manager;
		fieldset.hidden = !screen.manager;
	}
	element("switch-motion", HTMLDivElement).hidden = !screen.manager;
	element("preview-source", HTMLSpanElement).textContent = screen.manager
		? "Real CLI renderer with sample repositories."
		: "Clack flow preview using the same editable copy as the CLI.";
	const fields = screen.copy.map(({ key, label }) => {
		const wrapper = document.createElement("label");
		wrapper.className = "copy-label";
		wrapper.textContent = label;
		const field = document.createElement("textarea");
		field.id = `copy-${key}`;
		field.rows = 2;
		field.maxLength = 180;
		field.value = theme.copy[key];
		field.addEventListener("input", () => {
			theme.copy[key] = field.value;
			themeChanged();
		});
		wrapper.append(field);
		return wrapper;
	});
	element("screen-copy", HTMLDivElement).replaceChildren(...fields);
}

function navigateScreen(direction: number) {
	stopPlayback();
	const screens = availableScreens();
	const index = screens.findIndex((screen) => screen.id === currentScreen);
	const next = screens[index + direction];
	if (next) {
		changeScreen(next.id);
		schedulePreview();
	}
}

function advanceFlow() {
	const next: Record<string, string> = {
		scan: "repositories",
		login: "authenticated",
		authenticated: workspaceCount() > 1 ? "destination" : "review",
		destination: "review",
		saving: "saved",
		"auth-error": "login",
		"save-error": "pending",
		"signed-out": "login",
		closed: "repositories",
	};
	changeScreen(next[currentScreen] ?? "repositories", false);
	if (currentScreen === "saving") startPlayback("save");
}

function stopPlayback() {
	clearTimeout(playbackTimer);
	playbackVersion++;
	playback = undefined;
	button("play-flow").textContent = "Play upload flow";
	button("play-flow").setAttribute("aria-pressed", "false");
}

function startPlayback(kind: "flow" | "screen" | "save") {
	stopPlayback();
	playback = kind;
	stopAfterScan = false;
	const version = playbackVersion;
	let started = performance.now();
	progress = 0;
	button("play-flow").textContent = "Stop playback";
	button("play-flow").setAttribute("aria-pressed", "true");
	async function tick() {
		if (version !== playbackVersion) return;
		const duration =
			currentScreen === "scan"
				? PLAYBACK.scan
				: currentScreen === "login"
					? PLAYBACK.login
					: currentScreen === "saving"
						? PLAYBACK.saving
						: PLAYBACK.screen;
		const elapsed =
			(performance.now() - started) * Number(select("playback-speed").value);
		progress = Math.min(100, Math.round((elapsed / duration) * 100));
		frame = (frame + 1) % 10;
		await refreshPreview();
		if (version !== playbackVersion) return;
		if (elapsed >= duration) {
			if (kind === "screen" || (currentScreen === "scan" && stopAfterScan)) {
				stopPlayback();
				return;
			}
			const flow = getUploadFlow(workspaceCount());
			const next =
				kind === "save" ? "saved" : flow[flow.indexOf(currentScreen) + 1];
			if (!next) {
				stopPlayback();
				return;
			}
			const fromScan = currentScreen === "scan" && next === "repositories";
			const fromUpload = currentScreen === "saving" && next === "saved";
			changeScreen(
				next,
				kind !== "save" && !fromScan && !fromUpload && next !== "review",
			);
			started = performance.now();
			await refreshPreview();
			if (next === "saving") savedUploadCount = preview?.uploadTotal ?? 0;
			if (kind === "save" || next === "saved" || next === "review") {
				stopPlayback();
				return;
			}
		}
		playbackTimer = window.setTimeout(() => {
			void tick().catch((error) => {
				stopPlayback();
				showError(error);
			});
		}, PLAYBACK.tick);
	}
	playbackTimer = window.setTimeout(() => {
		void tick().catch((error) => {
			stopPlayback();
			showError(error);
		});
	}, 0);
}

async function applyTheme() {
	applying = true;
	syncControls();
	try {
		const result = await requestJson<{ theme: UploadManagerTheme }>(
			"/api/apply",
			theme,
		);
		savedTheme = parseUploadManagerTheme(result.theme);
		justApplied = true;
		try {
			localStorage.removeItem(DRAFT_KEY);
		} catch {
			/* Browser storage is optional. */
		}
	} finally {
		applying = false;
		syncControls();
	}
}

function setMode(next: TerminalMode) {
	mode = next;
	button("dark").setAttribute("aria-pressed", String(mode === "dark"));
	button("light").setAttribute("aria-pressed", String(mode === "light"));
	syncControls();
	redrawTerminal();
}

function emptyDemo(): DemoState {
	return {
		query: "",
		cursor: 0,
		selectionVisible: false,
		desired: {},
		enabled: {},
		message: "",
	};
}

async function requestJson<T = unknown>(
	path: string,
	body?: unknown,
): Promise<T> {
	const response = await fetch(
		path,
		body === undefined
			? undefined
			: {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(body),
				},
	);
	if (!response.ok) {
		const text = await response.text();
		throw new Error(
			text.startsWith("{") ? String(JSON.parse(text).error ?? text) : text,
		);
	}
	return response.json();
}

function showError(error: unknown) {
	errorNotice.textContent =
		error instanceof Error ? error.message : String(error);
	errorNotice.hidden = false;
}

function element<TElement extends HTMLElement>(
	id: string,
	elementClass: { new (): TElement },
): TElement {
	const node = document.getElementById(id);
	if (!(node instanceof elementClass))
		throw new Error(`Missing playground element: ${id}`);
	return node;
}
function input(id: string) {
	return element(id, HTMLInputElement);
}
function select(id: string) {
	return element(id, HTMLSelectElement);
}
function button(id: string) {
	return element(id, HTMLButtonElement);
}
