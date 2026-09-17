import { sanitizeForTerminalDisplay } from "../contracts/index.js";
import { cliMessage } from "./cli-messages.js";
import type { UploadRepository } from "./upload-manager-repositories.js";
import {
	filterRepositories,
	getAllUploadState,
	getDesiredUploadState,
	getPendingRepositories,
	getTableRepositories,
	type UploadManagerState,
} from "./upload-manager-state.js";
import {
	themeColorCode,
	UPLOAD_MANAGER_THEME,
	type UploadManagerTheme,
} from "./upload-manager-theme.js";
import { formatUploadBytes, uploadBytesPerSecond } from "./upload-progress.js";

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
	if (state.error) {
		const body = wrapErrorMessage(state.error.message, contentWidth);
		const pageSize = Math.max(1, height - 8);
		state.error.pageCount = Math.max(1, Math.ceil(body.length / pageSize));
		state.error.page = Math.min(state.error.page, state.error.pageCount - 1);
		const offset = state.error.page * pageSize;
		return [
			`${margin}${paint(cliMessage("managerTitle", {}, theme), "brand")}`,
			"",
			`${margin}${paint("Upload stopped", "danger")}`,
			"",
			...body
				.slice(offset, offset + pageSize)
				.map((line) => `${margin}${paint(line, "regular")}`),
			"",
			`${margin}${paint(
				state.error.pageCount > 1
					? `Details ${state.error.page + 1}/${state.error.pageCount} · ↑↓ pages`
					: state.singleRun
						? "Run browser setup again to retry."
						: "Your repository selection is kept.",
				"muted",
			)}`,
			`${margin}${paint(state.singleRun ? "Close [Enter / Esc]" : "Retry [Enter]   Go back [Esc]", "strong")}`,
		].join("\n");
	}
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
	const hasTransferProgress = repositories.some(
		(repo) =>
			repo.uploadSpeed?.samples.length ||
			repo.sessionUploads?.some(
				(session) => session.uploadedBytes !== undefined,
			),
	);
	const badge =
		state.operation && state.stage === "upload"
			? `↑ ${formatUploadBytes(hasTransferProgress ? repositories.reduce((sum, repo) => sum + (repo.uploadSpeed ? uploadBytesPerSecond(repo.uploadSpeed, performance.now()) : 0), 0) : undefined)}/s`
			: reviewing || state.stage === "upload" || state.operation || scanning
				? ""
				: pending.length
					? ` ${pending.length} UNSAVED `
					: "✓ Saved";
	const title = clipLine(
		cliMessage("managerTitle", {}, theme),
		contentWidth - badge.length,
	);
	const sessionCount =
		state.scan?.progress?.sessions ??
		summaryRepositories.reduce((count, repo) => count + repo.sessionCount, 0);
	const repoCount =
		state.scan?.progress?.phase === "sessions"
			? ""
			: theme.showSummary || scanning
				? ` (${number.format(tableRepositories.length)})`
				: "";
	const spinner =
		SCAN_FRAMES[(state.scan?.frame ?? 0) % SCAN_FRAMES.length] ?? "⠋";
	const scanPhase = state.scan?.progress?.phase;
	const scanHeading =
		scanPhase === "sessions"
			? "Reading sessions"
			: scanPhase === "history"
				? "Checking uploads"
				: cliMessage("scanHeading", {}, theme);
	const fullHeading = `${scanning ? scanHeading : cliMessage("repositoryHeading", {}, theme)}${repoCount}`;
	const heading =
		fullHeading.length + (scanning ? 2 : 0) <= nameWidth
			? fullHeading
			: `${scanning ? (scanPhase === "sessions" ? "Reading" : scanPhase === "history" ? "Checking" : "Scan") : "Repos"}${repoCount}`;
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
			? `${SCAN_FRAMES[(state.operation?.frame ?? 0) % SCAN_FRAMES.length]}${compact ? "" : " "}${uploadCount}`
			: `${uploadCount}${upload?.failed ? (compact ? "!" : " !") : ""}`;
		// Fill the spaces between columns too, then place each cell at its fixed
		// terminal column. A single inverse style keeps the band continuous.
		const highlight = selected
			? `${rowPaint(" ".repeat(contentWidth), "regular")}\u001b[${inset + 1}G`
			: "";
		return `${margin}${highlight}${rowPaint(selected ? "› " : "  ", "regular")}${rowPaint(clipLine(name, nameWidth), "regular")}${metadataColumn}${rowPaint(track, color)}${rowPaint(desired === "mixed" ? "MIX" : desired === "on" ? "ON " : "OFF", color)}\u001b[${sessionsColumn + 1}G${rowPaint(displayCount.padStart(sessionsWidth), aggregate ? "regular" : "muted")}\u001b[${uploadedColumn + 1}G${rowPaint(uploadText.padStart(countWidth), upload?.active ? "accent" : upload?.failed ? "danger" : uploaded ? "success" : "muted")}`;
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
	if (
		state.stage === "upload" &&
		(state.operation || state.uploadFailed) &&
		!completion
	) {
		// Pages count physical lines, so a long session ID or error can never
		// push a failure off-screen. Repeat the repository on continued pages.
		const capacity = Math.max(2, height - lines.length - 4);
		const pages: string[][] = [[]];
		let page = pages[0] ?? [];
		let activePage: number | undefined;
		const append = (line: string, header: string, active = false) => {
			if (page.length === capacity) {
				page = [];
				pages.push(page);
				if (line !== header) page.push(header);
			}
			if (active && activePage === undefined) activePage = pages.length - 1;
			page.push(line);
		};
		for (const repository of filtered) {
			const header = rowLine(
				`${repository.name}${repository.current ? " (current)" : ""}`,
				repository.key,
				getDesiredUploadState(repository, state) ? "on" : "off",
				repository.sessionCount,
				false,
				false,
				repository.uploadedCount,
				repository.upload,
			);
			append(header, header);
			const details = [...(repository.sessionUploads ?? [])].sort(
				(a, b) => Number(a.status === "failed") - Number(b.status === "failed"),
			);
			for (const detail of details) {
				const active = detail.status !== "failed";
				const date =
					detail.sessionDate === undefined
						? "Unknown date"
						: new Date(detail.sessionDate).toISOString().slice(0, 10);
				const identity = `${date} · ${sanitizeForTerminalDisplay(detail.sessionId)}`;
				const bytes = `${formatUploadBytes(detail.uploadedBytes)} / ${formatUploadBytes(detail.totalBytes)}`;
				const available = contentWidth - 4;
				if (identity.length + bytes.length + 2 <= available) {
					append(
						`${margin}    ${paint(identity, "muted")}${" ".repeat(available - identity.length - bytes.length)}${paint(bytes, "regular")}`,
						header,
						active,
					);
				} else {
					for (const line of wrapErrorMessage(identity, available))
						append(`${margin}    ${paint(line, "muted")}`, header, active);
					append(
						`${margin}    ${paint(bytes.padStart(available), "regular")}`,
						header,
						active,
					);
				}
				const label =
					detail.status === "failed"
						? detail.failureStage === "processing"
							? "✗ Processing failed"
							: detail.failureStage === "preparing"
								? "✗ Preparation failed"
								: "✗ Failed"
						: detail.status === "retrying"
							? `↻ Retrying ${detail.attempt}/${detail.maxAttempts}`
							: `${SCAN_FRAMES[(state.operation?.frame ?? 0) % SCAN_FRAMES.length]} ${detail.status === "preparing" ? "Preparing" : detail.status === "processing" ? "Processing on server" : "Uploading"}`;
				append(
					`${margin}    ${paint(label, detail.status === "failed" ? "danger" : "accent")}`,
					header,
					active,
				);
				if (detail.error)
					for (const line of wrapErrorMessage(detail.error, available))
						append(
							`${margin}    ${paint(line, detail.status === "failed" ? "danger" : "regular")}`,
							header,
						);
			}
		}
		state.uploadPageCount = pages.length;
		state.uploadPage = Math.max(
			0,
			Math.min(
				state.operation && state.followUpload !== false
					? (activePage ?? 0)
					: (state.uploadPage ?? 0),
				pages.length - 1,
			),
		);
		lines.push(...(pages[state.uploadPage] ?? []));
		while (lines.length < height - 4) lines.push("");
		lines.push(
			divider,
			pages.length > 1
				? textLine(`‹ Page ${state.uploadPage + 1} of ${pages.length} ›`)
				: "",
			textLine(state.message, state.uploadFailed ? "danger" : "muted"),
			state.uploadFailed && !state.operation
				? textLine(
						state.singleRun
							? "Close [Enter / Esc]"
							: "Retry [Enter]   Go back [Esc]",
						"strong",
					)
				: "",
		);
		return lines.join("\n");
	}
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

// Errors need their complete cause and recovery instructions. Wrap and paginate
// them instead of using the table's clipped labels or its 200-character sanitizer.
function wrapErrorMessage(message: string, width: number): string[] {
	return message.split(/\r?\n/u).flatMap((paragraph) => {
		const clean = [...paragraph].map(sanitizeForTerminalDisplay).join("");
		const segments = [
			...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(
				clean,
			),
		].map((item) => item.segment);
		const lines: string[] = [];
		let start = 0;
		while (start < segments.length) {
			let end = start;
			let used = 0;
			let space = -1;
			while (end < segments.length) {
				const segment = segments[end] ?? "";
				const size = /^[\x20-\x7e]+$/u.test(segment) ? segment.length : 2;
				if (used + size > width) break;
				used += size;
				if (segment === " ") space = end;
				end++;
			}
			if (end < segments.length && space > start) end = space;
			lines.push(segments.slice(start, end).join(""));
			start = end;
			while (segments[start] === " ") start++;
		}
		return lines.length ? lines : [""];
	});
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
