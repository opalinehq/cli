import { emitKeypressEvents, type Key } from "node:readline";
import { sanitizeForTerminalDisplay } from "../contracts/index.js";
import { cliMessage } from "./cli-messages.js";
import type { UploadCompletion } from "./upload-completion.js";
import type { UploadRepository } from "./upload-manager-repositories.js";
import {
	themeColorCode,
	UPLOAD_MANAGER_THEME,
	type UploadManagerTheme,
} from "./upload-manager-theme.js";

const TEXT_STYLES = {
	regular: "0",
	strong: "1",
	muted: "2",
	brand: "1;36",
	accent: "36",
	success: "32",
	danger: "31",
	pending: "1;7",
	focus: "7",
	link: "4;36",
};

type TextStyle = keyof typeof TEXT_STYLES;

const SCAN_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SCAN_FRAME_MS = 80;

export type UploadRepositoryScan = (
	onRepositories: (repositories: UploadRepository[]) => void,
	signal: AbortSignal,
) => Promise<UploadRepository[]>;

export interface ReviewControl {
	action: "confirm" | "back" | "previous" | "next";
	label: string;
	line: number;
	column: number;
	width: number;
	disabled: boolean;
}

export interface UploadManagerState {
	// A browser pairing has one immutable confirmed selection and upload run.
	singleRun?: boolean;
	query: string;
	// Zero selects the pinned All repos row; repository indices start at one.
	cursor: number;
	selectionVisible?: boolean;
	stage?: "review" | "upload";
	reviewPage?: number;
	reviewPageCount?: number;
	reviewAction?: "confirm" | "back";
	reviewControls?: ReviewControl[];
	desired: Map<string, boolean>;
	message: string;
	scan?: { frame: number };
	uploadFrame?: number;
	operation?: { label: string; frame: number };
	completion?: UploadCompletion;
	viewportStart?: number;
	followScan?: boolean;
	// A staged choice for this scan, resolved per repository when saving.
	// Individual desired values take precedence; this flag is never persisted.
	bulkDesired?: boolean;
}

export function getPendingRepositories(
	repositories: UploadRepository[],
	state: UploadManagerState,
): UploadRepository[] {
	return repositories.filter(
		(repository) =>
			getDesiredUploadState(repository, state) !== repository.enabled ||
			((state.desired.has(repository.key) || state.bulkDesired !== undefined) &&
				repository.problem &&
				getDesiredUploadState(repository, state)),
	);
}

export function getDesiredUploadState(
	repository: UploadRepository,
	state: UploadManagerState,
): boolean {
	return (
		state.desired.get(repository.key) ?? state.bulkDesired ?? repository.enabled
	);
}

export function getRepositoriesToUpload(
	repositories: UploadRepository[],
	state: UploadManagerState,
): UploadRepository[] {
	// Switching repositories OFF must still work without signing in.
	const pending = getPendingRepositories(repositories, state);
	if (
		!state.stage &&
		pending.length &&
		pending.every((repo) => !getDesiredUploadState(repo, state))
	)
		return [];
	return repositories.filter(
		(repo) =>
			getDesiredUploadState(repo, state) &&
			repo.sessionCount > (repo.uploadedCount ?? 0),
	);
}

export function getAllUploadState(
	repositories: UploadRepository[],
	state: UploadManagerState,
): "on" | "off" | "mixed" {
	if (!repositories.length) return state.bulkDesired ? "on" : "off";
	const enabled = repositories.filter((repo) =>
		getDesiredUploadState(repo, state),
	).length;
	return enabled === repositories.length
		? "on"
		: enabled === 0
			? "off"
			: "mixed";
}

export function toggleUploadRepository(
	repositories: UploadRepository[],
	state: UploadManagerState,
): void {
	if (state.scan || state.operation || state.stage === "review") return;
	state.selectionVisible = true;
	if (state.cursor === 0) {
		if (state.stage) return;
		state.bulkDesired = getAllUploadState(repositories, state) !== "on";
		state.desired.clear();
	} else {
		const repository = filterRepositories(
			getTableRepositories(repositories, state),
			state.query,
		)[state.cursor - 1];
		if (repository) {
			state.desired.set(
				repository.key,
				!getDesiredUploadState(repository, state),
			);
			// Keep focus on the same repo when its switch moves it between groups.
			const nextIndex = filterRepositories(
				getTableRepositories(repositories, state),
				state.query,
			).findIndex((repo) => repo.key === repository.key);
			if (nextIndex >= 0) state.cursor = nextIndex + 1;
		}
	}
	state.message = "";
}

export function getTableRepositories(
	repositories: UploadRepository[],
	state: UploadManagerState,
): UploadRepository[] {
	if (state.stage === "review")
		return [
			...repositories.filter(
				(repo) => !repo.enabled && getDesiredUploadState(repo, state),
			),
			...repositories.filter(
				(repo) => repo.enabled && getDesiredUploadState(repo, state),
			),
			...repositories.filter(
				(repo) => repo.enabled && !getDesiredUploadState(repo, state),
			),
		];
	return state.stage === "upload"
		? repositories.filter((repo) => getDesiredUploadState(repo, state))
		: repositories;
}

export function reviewUploadSelection(state: UploadManagerState): void {
	state.stage = "review";
	state.reviewPage = 0;
	state.reviewAction = "confirm";
	state.completion = undefined;
	state.query = "";
	state.cursor = 0;
	state.selectionVisible = false;
	state.viewportStart = 0;
	state.message = "";
}

export function editUploadSelection(state: UploadManagerState): void {
	state.stage = undefined;
	state.completion = undefined;
	state.query = "";
	state.cursor = 0;
	state.selectionVisible = false;
	state.viewportStart = 0;
	state.followScan = false;
	state.message = "";
}

export function filterRepositories(
	repositories: UploadRepository[],
	query: string,
): UploadRepository[] {
	const search = query.toLocaleLowerCase();
	return repositories.filter((repository) =>
		[repository.name, repository.key, ...repository.paths].some((value) =>
			value.toLocaleLowerCase().includes(search),
		),
	);
}

export function renderUploadManager(
	repositories: UploadRepository[],
	state: UploadManagerState,
	columns: number,
	rows: number,
	theme: UploadManagerTheme = UPLOAD_MANAGER_THEME,
	togglePositions: ReadonlyMap<string, number> = new Map(),
): string {
	state.reviewControls = [];
	const reviewing = state.stage === "review";
	const tableRepositories = getTableRepositories(repositories, state);
	const summaryRepositories =
		state.stage === "review"
			? tableRepositories.filter((repo) => getDesiredUploadState(repo, state))
			: tableRepositories;
	const filtered = filterRepositories(tableRepositories, state.query);
	state.cursor = Math.min(state.cursor, filtered.length);
	const pending = getPendingRepositories(repositories, state);
	const scanning = state.scan !== undefined;
	const showRepositorySummary = !state.stage && !scanning && !state.operation;
	const completion =
		!scanning && !state.operation && !pending.length && state.stage === "upload"
			? state.completion
			: undefined;
	const onCount = tableRepositories.filter((repository) =>
		getDesiredUploadState(repository, state),
	).length;
	const height = Math.max(1, rows - 1);
	if (columns < 38 || height < 12) {
		return [
			cliMessage("managerTitle", {}, theme),
			"Enlarge terminal to 38 columns / 13 rows.",
			"Esc cancel",
		]
			.slice(0, height)
			.map((line) => clipLine(line, columns - 1))
			.join("\n");
	}
	const width = Math.min(columns - 1, theme.maxWidth);
	const compact = width - theme.padding * 2 < 60;
	const inset = compact ? 1 : theme.padding;
	const gap = compact ? 1 : theme.columnGap;
	const contentWidth = width - inset * 2;
	const margin = " ".repeat(inset);
	const styles = {
		...TEXT_STYLES,
		brand: `1;${themeColorCode(theme.accentColor)}`,
		accent: themeColorCode(theme.accentColor),
		link: `4;${themeColorCode(theme.accentColor)}`,
		success: themeColorCode(theme.onColor),
		danger: themeColorCode(theme.offColor),
		focus: theme.focus === "inverse" ? "7" : theme.focus === "bold" ? "1" : "4",
		muted: scanning || theme.dimSecondary ? "2" : "0",
	};
	const paint = (text: string, style: TextStyle) =>
		`\u001b[${styles[style]}m${text}\u001b[0m`;
	const number = new Intl.NumberFormat("en-US");
	const compactNumber = new Intl.NumberFormat("en-US", {
		notation: "compact",
		maximumFractionDigits: 1,
	});
	// Reserve the session column before any counts arrive; large values are
	// abbreviated rather than shifting the table underneath the user's cursor.
	const countWidth = compact ? 5 : 8;
	const sessionsLabel = compact ? "Local" : "Local sessions";
	const sessionsWidth = Math.max(countWidth, sessionsLabel.length);
	const statusWidth = compact ? 9 : 11;
	const statusLabel = compact ? "Auto" : "Auto upload";
	const uploadedColumn = width - inset - countWidth;
	const sessionsColumn = uploadedColumn - gap - sessionsWidth;
	const statusColumn = sessionsColumn - gap - statusWidth;
	const nameWidth = statusColumn - gap - inset - 2;
	// Position metadata independently of the display width of Unicode repo names.
	const metadataColumn = `\u001b[${statusColumn + 1}G`;
	const textLine = (text: string, style: TextStyle = "muted") =>
		`${margin}${paint(clipLine(text, contentWidth), scanning ? "muted" : style)}`;
	const divider =
		theme.separators === "none"
			? ""
			: `${margin}${paint((theme.separators === "dots" ? "·" : "─").repeat(contentWidth), "muted")}`;
	const badge =
		reviewing || state.operation || scanning
			? ""
			: pending.length
				? ` ${pending.length} UNSAVED `
				: "✓ Saved";
	const title = clipLine(
		cliMessage("managerTitle", {}, theme),
		contentWidth - badge.length,
	);
	const sessionCount = summaryRepositories.reduce(
		(count, repo) => count + repo.sessionCount,
		0,
	);
	const repoCount =
		theme.showSummary || scanning
			? ` (${number.format(tableRepositories.length)})`
			: "";
	const spinner =
		SCAN_FRAMES[(state.scan?.frame ?? 0) % SCAN_FRAMES.length] ?? "⠋";
	const fullHeading = `${cliMessage(scanning ? "scanHeading" : "repositoryHeading", {}, theme)}${repoCount}`;
	const heading =
		fullHeading.length + (scanning ? 2 : 0) <= nameWidth
			? fullHeading
			: `${scanning ? "Scan" : "Repos"}${repoCount}`;
	const lines = [
		`${margin}${paint(title, scanning ? "muted" : "brand")}${badge ? `\u001b[${width - inset - badge.length + 1}G${paint(badge, pending.length ? "pending" : "muted")}` : ""}`,
		state.query ? textLine(`Search: ${state.query}`, "strong") : "",
		`${margin}${scanning ? `${paint(spinner, "accent")} ` : "  "}${paint(clipLine(heading, nameWidth), scanning ? "strong" : "muted")}${metadataColumn}${paint(statusLabel, "muted")}\u001b[${sessionsColumn + 1}G${paint(sessionsLabel.padStart(sessionsWidth), "muted")}\u001b[${uploadedColumn + 1}G${paint((compact ? "Sent" : "Uploaded").padStart(countWidth), "muted")}`,
		divider,
	];
	const rowLine = (
		name: string,
		key: string,
		desired: "on" | "off" | "mixed",
		count: number,
		focused: boolean,
		aggregate = false,
		uploaded?: number,
		upload?: UploadRepository["upload"],
	) => {
		const selected =
			focused &&
			!reviewing &&
			!(aggregate && state.stage) &&
			state.selectionVisible !== false &&
			!scanning &&
			!state.operation;
		const rowPaint = (text: string, style: TextStyle) =>
			paint(
				text,
				scanning
					? "muted"
					: selected
						? aggregate && theme.focus === "bold"
							? "regular"
							: "focus"
						: style,
			);
		const color =
			desired === "mixed" ? "strong" : desired === "on" ? "success" : "danger";
		const position =
			togglePositions.get(key) ??
			(desired === "mixed" ? 1 : desired === "on" ? 2 : 0);
		const track = `${compact ? "" : " "}[${"─".repeat(position)}${desired === "off" ? "○" : "●"}${"─".repeat(2 - position)}] `;
		const formatted = number.format(count);
		const displayCount =
			formatted.length > countWidth ? compactNumber.format(count) : formatted;
		const completed = upload?.active ? upload.completed : uploaded;
		const uploadNumber =
			completed === undefined ? "—" : number.format(completed);
		const indicatorWidth = compact ? 1 : 2;
		const numberWidth =
			countWidth - (upload?.active || upload?.failed ? indicatorWidth : 0);
		let uploadCount =
			uploadNumber.length > numberWidth && completed !== undefined
				? compactNumber.format(completed)
				: uploadNumber;
		if (uploadCount.length > numberWidth && completed !== undefined)
			uploadCount = new Intl.NumberFormat("en-US", {
				notation: "compact",
				maximumFractionDigits: 0,
			}).format(completed);
		if (uploadCount.length > numberWidth && completed !== undefined)
			uploadCount = completed.toExponential(0).replace("e+", "e");
		const uploadText = upload?.active
			? `${SCAN_FRAMES[(state.operation?.frame ?? state.uploadFrame ?? 0) % SCAN_FRAMES.length]}${compact ? "" : " "}${uploadCount}`
			: `${uploadCount}${upload?.failed ? (compact ? "!" : " !") : ""}`;
		// Fill the spaces between columns too, then place each cell at its fixed
		// terminal column. A single inverse style keeps the band continuous.
		const highlight = selected
			? `${rowPaint(" ".repeat(contentWidth), "regular")}\u001b[${inset + 1}G`
			: "";
		return `${margin}${highlight}${rowPaint(selected ? "› " : "  ", "regular")}${rowPaint(clipLine(name, nameWidth), "regular")}${metadataColumn}${rowPaint(track, color)}${rowPaint(desired === "mixed" ? "MIX" : desired === "on" ? "ON " : "OFF", color)}\u001b[${sessionsColumn + 1}G${rowPaint(displayCount.padStart(sessionsWidth), aggregate ? "regular" : "muted")}\u001b[${uploadedColumn + 1}G${rowPaint(uploadText.padStart(countWidth), upload?.failed ? "danger" : upload?.active ? "accent" : uploaded ? "success" : "muted")}`;
	};
	lines.push(
		rowLine(
			state.stage ? (compact ? "Selected" : "Selected repos") : "All repos",
			"all-repos",
			state.stage && !summaryRepositories.length
				? "off"
				: getAllUploadState(summaryRepositories, state),
			sessionCount,
			state.cursor === 0,
			true,
			summaryRepositories.every((repo) => repo.uploadedCount !== undefined)
				? summaryRepositories.reduce(
						(sum, repo) => sum + (repo.uploadedCount ?? 0),
						0,
					)
				: undefined,
			summaryRepositories.some((repo) => repo.upload)
				? {
						completed: summaryRepositories.reduce(
							(sum, repo) => sum + (repo.uploadedCount ?? 0),
							0,
						),
						total: summaryRepositories.reduce(
							(sum, repo) => sum + (repo.upload?.total ?? 0),
							0,
						),
						active: summaryRepositories.some((repo) => repo.upload?.active),
						failed: summaryRepositories.reduce(
							(sum, repo) => sum + (repo.upload?.failed ?? 0),
							0,
						),
					}
				: undefined,
		),
		divider,
	);
	const splitFooter = compact || (!!state.stage && contentWidth < 68);
	const focusedWorkspace =
		filtered[state.cursor - 1]?.uploadedOrganizationId ??
		filtered[state.cursor - 1]?.organizationId;
	const dashboards =
		completion?.kind === "sessions" ? completion.dashboards : [];
	// If the workspace links would leave no room for a repository row, show the
	// focused repository's workspace. Arrow navigation exposes each destination.
	const visibleDashboards =
		dashboards.length > height - 11
			? dashboards
					.filter((dashboard) => dashboard.organizationId === focusedWorkspace)
					.slice(0, 1)
			: dashboards;
	if (dashboards.length && !visibleDashboards.length && dashboards[0])
		visibleDashboards.push(dashboards[0]);
	const extraLinks = Math.max(0, visibleDashboards.length - 1);
	const confirmLabel = cliMessage("confirmSelection", {}, theme);
	const backLabel = cliMessage("goBack", {}, theme);
	const stackedActions =
		confirmLabel.length + backLabel.length + 7 > contentWidth;
	const footerHeight = reviewing
		? stackedActions
			? 5
			: 4
		: completion
			? height - extraLinks >= 17
				? 9
				: height - extraLinks >= 14
					? 7
					: 5
			: splitFooter
				? 6
				: 5;
	const minimal = height < lines.length + footerHeight + 1;
	const reservedFooter =
		footerHeight + extraLinks - (minimal && !completion && !reviewing ? 1 : 0);
	const listHeight = height - lines.length - reservedFooter;
	const grouped = state.stage === "review";
	const showGroupRows = grouped && listHeight >= 2;
	const groupCounts = new Map<string, number>();
	if (grouped)
		for (const repo of tableRepositories) {
			const group = getReviewGroup(repo, state);
			groupCounts.set(group, (groupCounts.get(group) ?? 0) + 1);
		}
	const endAt = (first: number): number => {
		let used = 0;
		let lastGroup = "";
		let end = first;
		for (const repo of filtered.slice(first)) {
			const group = grouped ? getReviewGroup(repo, state) : "";
			const cost = 1 + (showGroupRows && group !== lastGroup ? 1 : 0);
			if (used + cost > listHeight) break;
			used += cost;
			lastGroup = group;
			end++;
		}
		return end;
	};
	let start = Math.min(
		state.viewportStart ?? 0,
		Math.max(0, filtered.length - listHeight),
	);
	if (reviewing) {
		const pageStarts = [0];
		let next = endAt(0);
		while (next < filtered.length) {
			pageStarts.push(next);
			next = endAt(next);
		}
		state.reviewPageCount = pageStarts.length;
		state.reviewPage = Math.max(
			0,
			Math.min(state.reviewPage ?? 0, pageStarts.length - 1),
		);
		start = pageStarts[state.reviewPage] ?? 0;
	} else if (scanning && state.followScan !== false && !state.query) {
		start = Math.max(0, filtered.length - listHeight);
	} else if (state.cursor > 0) {
		const selectedIndex = state.cursor - 1;
		if (selectedIndex < start) start = selectedIndex;
		while (selectedIndex >= endAt(start) && start < selectedIndex) start++;
	}
	state.viewportStart = start;
	const end = endAt(start);
	const visible = filtered.slice(start, end);
	let previousGroup = "";
	for (const [index, repository] of visible.entries()) {
		if (grouped) {
			const group = getReviewGroup(repository, state);
			if (group !== previousGroup) {
				const label = `${cliMessage(group, {}, theme)} (${groupCounts.get(group) ?? 0})`;
				const header = textLine(
					`── ${label}`,
					group === "selectionDeactivated"
						? "danger"
						: group === "selectionNew"
							? "accent"
							: "muted",
				);
				if (showGroupRows) lines.push(header);
				else lines[1] = header;
			}
			previousGroup = group;
		}
		const desired = getDesiredUploadState(repository, state);
		const changed = pending.includes(repository);
		const newlyAdded =
			state.stage === "review" && desired && !repository.enabled;
		const baseName = `${repository.name}${repository.current ? " (current)" : ""}`;
		const name = newlyAdded
			? `${clipLine(baseName, nameWidth - 8)} (new)`
			: `${changed && !grouped ? "* " : repository.problem && !repository.current ? "! " : ""}${baseName}`;
		lines.push(
			rowLine(
				name,
				repository.key,
				desired ? "on" : "off",
				repository.sessionCount,
				start + index + 1 === state.cursor,
				false,
				repository.uploadedCount,
				repository.upload,
			),
		);
	}
	if (visible.length === 0)
		lines.push(
			textLine(
				`  ${scanning ? (state.query ? "No matches yet" : "Finding repositories…") : reviewing ? "No repos selected" : state.stage && !tableRepositories.length ? "No repos selected · A to add repos" : tableRepositories.length ? "No matching repositories" : cliMessage("managerEmpty", {}, theme)}`,
			),
		);
	if (!completion)
		while (lines.length < height - reservedFooter) lines.push("");
	if (reviewing) {
		const controls = state.reviewControls;
		lines.push(divider);
		if ((state.reviewPageCount ?? 1) > 1) {
			const page = state.reviewPage ?? 0;
			const count = state.reviewPageCount ?? 1;
			const label = `Page ${page + 1} of ${count}`;
			controls.push({
				action: "previous",
				label: "Previous page",
				line: lines.length,
				column: inset,
				width: 3,
				disabled: page === 0,
			});
			controls.push({
				action: "next",
				label: "Next page",
				line: lines.length,
				column: inset + label.length + 5,
				width: 3,
				disabled: page === count - 1,
			});
			lines.push(
				`${margin}${paint(" ‹ ", page ? "accent" : "muted")} ${paint(label, "muted")} ${paint(" › ", page < count - 1 ? "accent" : "muted")}`,
			);
		} else lines.push("");
		// Keep a failed or cancelled confirmation visible without restoring the
		// normal review summary, repository path, or keyboard legend.
		lines.push(state.message ? textLine(state.message, "strong") : "");
		const confirmText = ` ${clipLine(confirmLabel, contentWidth - 2)} `;
		const backText = ` ${clipLine(backLabel, contentWidth - 2)} `;
		const actionLine = lines.length;
		const backColumn = stackedActions ? inset : inset + confirmText.length + 3;
		controls.push({
			action: "confirm",
			label: confirmLabel,
			line: actionLine,
			column: inset,
			width: confirmText.length,
			disabled: false,
		});
		controls.push({
			action: "back",
			label: backLabel,
			line: actionLine + (stackedActions ? 1 : 0),
			column: backColumn,
			width: backText.length,
			disabled: false,
		});
		const confirm = paint(
			confirmText,
			state.reviewAction === "back" ? "regular" : "pending",
		);
		const back = paint(
			backText,
			state.reviewAction === "back" ? "pending" : "regular",
		);
		if (stackedActions) lines.push(`${margin}${confirm}`, `${margin}${back}`);
		else lines.push(`${margin}${confirm}   ${back}`);
		return lines.join("\n");
	}
	const focused = filtered[state.cursor - 1];
	const problem =
		focused?.uploadError ??
		(focused && getDesiredUploadState(focused, state)
			? focused.problem
			: undefined);
	const status =
		problem ||
		state.message ||
		(pending.length
			? `${pending.length} change${pending.length === 1 ? "" : "s"} pending${scanning ? " · Review after scan" : " · Enter to review"}`
			: "");
	const exitLabel = pending.length
		? compact
			? "discard"
			: "discard & exit"
		: "exit";
	const range = `${filtered.length === 0 ? 0 : start + 1}–${end} of ${filtered.length} repos`;
	const totals = theme.showTotals
		? ` · ${onCount} ON / ${tableRepositories.length - onCount} OFF`
		: "";
	const identity =
		focused && theme.showRepoIdentity ? (focused.paths[0] ?? focused.key) : "";
	if (completion) {
		lines.push(divider, "");
		if (footerHeight >= 7) lines.push(textLine(identity), "");
		if (footerHeight >= 9) lines.push("");
		lines.push(
			textLine(`✓ ${cliMessage("uploadSuccess", {}, theme)}`, "success"),
		);
		const links =
			completion.kind === "setup"
				? [
						{
							url: completion.url,
							label: cliMessage("continueSetup", {}, theme),
						},
					]
				: visibleDashboards.map((dashboard) => ({
						url: dashboard.url,
						label: dashboard.url.replace(/^https?:\/\//u, ""),
					}));
		for (const link of links) {
			const label = clipLine(link.label, contentWidth);
			lines.push(
				`${margin}\u001b]8;;${link.url}\u0007${paint(label, "link")}\u001b]8;;\u0007`,
			);
		}
		if (footerHeight >= 9) lines.push("");
		return lines.join("\n");
	}
	lines.push(
		divider,
		showRepositorySummary ? textLine(`${range}${totals}`) : "",
		textLine(identity),
	);
	if (!minimal)
		lines.push(
			textLine(
				status,
				problem ? "danger" : pending.length ? "strong" : "muted",
			),
		);
	if (scanning || state.operation || state.stage === "upload")
		return lines.join("\n");
	const navigation = `${paint("↑↓", "strong")} ${paint("move", "muted")}   ${paint("Space", "strong")} ${paint("toggle", "muted")}`;
	const actions = `${paint("Enter", "strong")} ${paint("review", "muted")}   ${paint("Esc", "strong")} ${paint(exitLabel, "muted")}`;
	if (splitFooter) {
		lines.push(`${margin}${navigation}`, `${margin}${actions}`);
	} else {
		lines.push(`${margin}${navigation}   ${actions}`);
	}
	return lines.join("\n");
}

export function promptUploadManager(
	repositories: UploadRepository[],
	state: UploadManagerState,
	scan?: UploadRepositoryScan,
	operation?: (signal: AbortSignal) => Promise<void>,
): Promise<"save" | "cancel"> {
	return new Promise((resolve, reject) => {
		const input = process.stdin;
		const output = process.stdout;
		const wasRaw = input.isRaw;
		const togglePositions = new Map<string, number>();
		const animations = new Map<string, ReturnType<typeof setTimeout>[]>();
		const controller = new AbortController();
		let finished = false;
		let scanTimer: ReturnType<typeof setInterval> | undefined;
		let operationTimer: ReturnType<typeof setInterval> | undefined;
		let cancelAfterOperation = false;
		let mouseEnabled = false;
		let mouseInput = "";
		let readingMouseKey = false;
		state.scan = scan ? { frame: 0 } : undefined;
		state.operation = operation
			? { label: cliMessage("saveProgress"), frame: 0 }
			: undefined;
		emitKeypressEvents(input);
		input.setRawMode(true);
		input.resume();
		output.write("\u001b[?1049h\u001b[?25l");
		const render = () => {
			if (finished) return;
			const enableMouse =
				state.stage === "review" && !state.operation && !state.scan;
			if (enableMouse !== mouseEnabled) {
				output.write(
					enableMouse
						? "\u001b[?1000h\u001b[?1006h"
						: "\u001b[?1000l\u001b[?1006l",
				);
				mouseEnabled = enableMouse;
			}
			output.write(
				`\u001b[H\u001b[2J${renderUploadManager(repositories, state, output.columns || 80, output.rows || 24, UPLOAD_MANAGER_THEME, togglePositions)}`,
			);
		};
		const finish = (result: "save" | "cancel", error?: unknown) => {
			if (finished) return;
			finished = true;
			controller.abort();
			clearInterval(scanTimer);
			clearInterval(operationTimer);
			for (const timers of animations.values())
				for (const timer of timers) clearTimeout(timer);
			input.off("keypress", onKey);
			input.off("data", onMouseData);
			input.off("end", cancel);
			output.off("resize", render);
			process.off("SIGTERM", terminate);
			input.setRawMode(wasRaw);
			input.pause();
			if (mouseEnabled) output.write("\u001b[?1000l\u001b[?1006l");
			output.write("\u001b[?25h\u001b[?1049l");
			if (error !== undefined) reject(error);
			else resolve(result);
		};
		const cancel = () => {
			if (state.operation) {
				cancelAfterOperation = true;
				controller.abort();
				state.message = "Stopping uploads…";
				render();
			} else finish("cancel");
		};
		const terminate = () => {
			process.exitCode = 143;
			cancel();
		};
		const activateReview = (action: ReviewControl["action"]) => {
			if (finished || state.stage !== "review" || state.operation) return;
			if (action === "confirm") return finish("save");
			if (action === "back") editUploadSelection(state);
			else
				state.reviewPage = Math.max(
					0,
					Math.min(
						(state.reviewPage ?? 0) + (action === "next" ? 1 : -1),
						(state.reviewPageCount ?? 1) - 1,
					),
				);
			render();
		};
		const onMouseData = (chunk: Buffer | string) => {
			if (!mouseEnabled) return;
			mouseInput = (mouseInput + chunk.toString()).slice(-512);
			let start = mouseInput.indexOf("\u001b[<");
			while (start >= 0) {
				const match = /^(\d+);(\d+);(\d+)([Mm])/u.exec(
					mouseInput.slice(start + 3),
				);
				if (!match) break;
				mouseInput = mouseInput.slice(start + 3 + match[0].length);
				if (match[1] === "0" && match[4] === "M") {
					const column = Number(match[2]) - 1;
					const line = Number(match[3]) - 1;
					const control = state.reviewControls?.find(
						(item) =>
							!item.disabled &&
							item.line === line &&
							column >= item.column &&
							column < item.column + item.width,
					);
					if (control) activateReview(control.action);
				}
				start = mouseInput.indexOf("\u001b[<");
			}
		};
		const onKey = (text: string | undefined, key: Key) => {
			if (finished) return;
			if (state.singleRun && state.stage === "upload" && !state.operation) {
				if (
					key.name === "return" ||
					key.name === "escape" ||
					(key.ctrl && (key.name === "c" || key.name === "d"))
				)
					finish("cancel");
				return;
			}
			// Readline splits SGR mouse reports into an escape prefix and individual
			// characters. Consume the entire report, including a release that arrives
			// after Go back has already returned to the editable picker.
			const sequence = key.sequence ?? text ?? "";
			if (sequence.startsWith("\u001b[<")) {
				readingMouseKey = !/[Mm]$/u.test(sequence);
				return;
			}
			if (readingMouseKey) {
				if (sequence.startsWith("\u001b")) readingMouseKey = false;
				else {
					if (/[Mm]$/u.test(sequence)) readingMouseKey = false;
					return;
				}
			}
			if (key.name === "escape" && state.stage && !state.operation) {
				editUploadSelection(state);
				render();
				return;
			}
			if (
				key.name === "escape" ||
				(key.ctrl && (key.name === "c" || key.name === "d"))
			)
				return cancel();
			if (state.scan) return;
			if ((output.columns || 80) < 38 || (output.rows || 24) < 13) return;
			if (state.operation && key.name !== "up" && key.name !== "down") return;
			if (state.stage === "review") {
				if (key.name === "return")
					return activateReview(state.reviewAction ?? "confirm");
				if (key.name === "up" || key.name === "pageup")
					return activateReview("previous");
				if (key.name === "down" || key.name === "pagedown")
					return activateReview("next");
				if (key.name === "left") state.reviewAction = "confirm";
				else if (key.name === "right") state.reviewAction = "back";
				else if (key.name === "tab")
					state.reviewAction =
						state.reviewAction === "back" ? "confirm" : "back";
				render();
				return;
			}
			if (state.stage && key.name === "a") {
				editUploadSelection(state);
				render();
				return;
			}
			if (
				state.stage &&
				!["up", "down", "return", "space"].includes(key.name ?? "")
			)
				return;
			const filtered = filterRepositories(
				getTableRepositories(repositories, state),
				state.query,
			);
			if (key.name === "return") {
				const focused = filtered[state.cursor - 1];
				if (
					!getPendingRepositories(repositories, state).length &&
					focused?.problem &&
					focused.enabled
				)
					state.desired.set(focused.key, true);
				reviewUploadSelection(state);
			} else if (key.name === "up" || key.name === "down") {
				state.followScan = false;
				if (state.selectionVisible === false) state.selectionVisible = true;
				else
					state.cursor = Math.max(
						state.stage && filtered.length ? 1 : 0,
						Math.min(
							filtered.length,
							state.cursor + (key.name === "up" ? -1 : 1),
						),
					);
			} else if (key.name === "space") {
				if (state.stage && state.cursor === 0) return;
				const repository = filtered[state.cursor - 1];
				const targetKey = state.cursor === 0 ? "all-repos" : repository?.key;
				const previous =
					state.cursor === 0
						? getAllUploadState(repositories, state)
						: repository && getDesiredUploadState(repository, state)
							? "on"
							: "off";
				toggleUploadRepository(repositories, state);
				if (targetKey) {
					for (const timer of animations.get(targetKey) ?? [])
						clearTimeout(timer);
					const duration = UPLOAD_MANAGER_THEME.motionDuration;
					if (duration) {
						togglePositions.set(
							targetKey,
							togglePositions.get(targetKey) ??
								(previous === "mixed" ? 1 : previous === "on" ? 2 : 0),
						);
						animations.set(targetKey, [
							setTimeout(() => {
								togglePositions.set(targetKey, 1);
								render();
							}, duration / 2),
							setTimeout(() => {
								togglePositions.delete(targetKey);
								animations.delete(targetKey);
								render();
							}, duration),
						]);
					}
				}
			} else if (key.name === "backspace" || (key.ctrl && key.name === "u")) {
				state.selectionVisible = true;
				state.followScan = false;
				state.query = key.ctrl ? "" : [...state.query].slice(0, -1).join("");
				state.cursor = 0;
			} else if (
				text &&
				!key.ctrl &&
				!key.meta &&
				!key.sequence?.startsWith("\u001b")
			) {
				state.selectionVisible = true;
				state.followScan = false;
				state.query += sanitizeForTerminalDisplay(text);
				state.cursor = 0;
			}
			render();
		};
		input.on("keypress", onKey);
		input.on("data", onMouseData);
		input.on("end", cancel);
		output.on("resize", render);
		process.on("SIGTERM", terminate);
		render();
		if (operation) {
			operationTimer = setInterval(() => {
				if (state.operation)
					state.operation.frame =
						(state.operation.frame + 1) % SCAN_FRAMES.length;
				render();
			}, SCAN_FRAME_MS);
			void Promise.resolve()
				.then(() => operation(controller.signal))
				.catch((error: unknown) => {
					if (!controller.signal.aborted)
						state.message =
							error instanceof Error ? error.message : String(error);
				})
				.finally(() => {
					clearInterval(operationTimer);
					state.operation = undefined;
					if (cancelAfterOperation) finish("cancel");
					else render();
				});
		}
		if (scan) {
			// Discovery can emit thousands of updates. Repaint at a steady cadence.
			scanTimer = setInterval(() => {
				if (state.scan)
					state.scan.frame = (state.scan.frame + 1) % SCAN_FRAMES.length;
				render();
			}, SCAN_FRAME_MS);
			void Promise.resolve()
				.then(() =>
					scan((rows) => {
						if (!finished) repositories.splice(0, repositories.length, ...rows);
					}, controller.signal),
				)
				.then((rows) => {
					if (finished) return;
					repositories.splice(0, repositories.length, ...rows);
					state.scan = undefined;
					clearInterval(scanTimer);
					render();
				})
				.catch((error: unknown) => {
					if (!finished) finish("cancel", error);
				});
		}
	});
}

function getReviewGroup(
	repository: UploadRepository,
	state: UploadManagerState,
): "selectionNew" | "selectionActive" | "selectionDeactivated" {
	return !getDesiredUploadState(repository, state)
		? "selectionDeactivated"
		: repository.enabled
			? "selectionActive"
			: "selectionNew";
}

// Conservatively reserve two columns for non-ASCII graphemes. This keeps long
// Unicode paths from wrapping over the fixed controls, without splitting emoji.
function clipLine(value: string, width: number): string {
	const clean = sanitizeForTerminalDisplay(value).replace(/[\r\n\t]/gu, " ");
	let result = "";
	let used = 0;
	for (const { segment } of new Intl.Segmenter(undefined, {
		granularity: "grapheme",
	}).segment(clean)) {
		const size = /^[\x20-\x7e]+$/u.test(segment) ? segment.length : 2;
		if (used + size > width - 1) return `${result}…`;
		used += size;
		result += segment;
	}
	return result;
}
