import { sanitizeForTerminalDisplay } from "../contracts/index.js";
import type { UploadCompletion } from "./upload-completion.js";
import type {
	ScanProgress,
	UploadRepository,
} from "./upload-manager-repositories.js";

export interface ReviewControl {
	action: "confirm" | "back" | "previous" | "next";
	label: string;
	line: number;
	column: number;
	width: number;
	disabled: boolean;
}

export interface UploadManagerState {
	// Browser pairing locks the confirmed selection, including retries.
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
	error?: { message: string; page: number; pageCount?: number };
	scan?: { frame: number; progress?: ScanProgress };
	operation?: { label: string; frame: number };
	completion?: UploadCompletion;
	uploadFailed?: boolean;
	uploadPage?: number;
	uploadPageCount?: number;
	followUpload?: boolean;
	viewportStart?: number;
	followScan?: boolean;
}

export interface UploadKey {
	name: string;
	text?: string;
	ctrl?: boolean;
	meta?: boolean;
}

// Hosts handle effects (saving, cancelling, animation); both use these rules
// for selection, review, pagination and the locked scan/upload phases.
export function applyUploadKey(
	repositories: UploadRepository[],
	state: UploadManagerState,
	key: UploadKey,
): "save" | "cancel" | "changed" | "ignored" {
	const cancel =
		key.name === "escape" || (key.ctrl && ["c", "d"].includes(key.name));
	if (state.error && !state.operation) {
		if (cancel || key.name === "return") {
			if (state.singleRun || key.ctrl) return "cancel";
			state.error = undefined;
			if (key.name === "return") return "save";
			editUploadSelection(state);
			return "changed";
		}
		if (["up", "down", "pageup", "pagedown"].includes(key.name)) {
			state.error.page = Math.max(
				0,
				Math.min(
					state.error.page + (["down", "pagedown"].includes(key.name) ? 1 : -1),
					(state.error.pageCount ?? 1) - 1,
				),
			);
			return "changed";
		}
		return "ignored";
	}
	if (
		(state.singleRun || state.completion) &&
		state.stage === "upload" &&
		!state.operation &&
		!state.uploadFailed
	) {
		if (cancel || key.name === "return") return "cancel";
		if (state.singleRun) return "ignored";
	}
	if (cancel) {
		if (state.singleRun && state.stage === "upload" && !state.operation)
			return "cancel";
		if (state.stage === "upload" && state.completion && !state.operation)
			return "cancel";
		if (
			key.name === "escape" &&
			state.stage &&
			!state.operation &&
			!state.scan
		) {
			editUploadSelection(state);
			return "changed";
		}
		return "cancel";
	}
	if (state.scan) return "ignored";
	if (state.stage === "upload" && (state.operation || state.uploadFailed)) {
		const canRetry = hasFailedUploadSessions(repositories);
		if (!state.operation && state.completion) {
			if (key.name === "return") {
				state.uploadFailed = false;
				state.viewportStart = 0;
				state.cursor = 0;
				return "changed";
			}
			if (key.name === "r" && canRetry) return "save";
		}
		if (["up", "down", "pageup", "pagedown"].includes(key.name)) {
			state.followUpload = false;
			state.uploadPage = Math.max(
				0,
				Math.min(
					(state.uploadPage ?? 0) +
						(["down", "pagedown"].includes(key.name) ? 1 : -1),
					(state.uploadPageCount ?? 1) - 1,
				),
			);
			return "changed";
		}
		return !state.operation && canRetry && key.name === "return"
			? "save"
			: "ignored";
	}
	if (state.operation && key.name !== "up" && key.name !== "down")
		return "ignored";
	if (state.stage === "review") {
		if (key.name === "return")
			return activateUploadReview(state, state.reviewAction ?? "confirm");
		if (key.name === "up" || key.name === "pageup")
			return activateUploadReview(state, "previous");
		if (key.name === "down" || key.name === "pagedown")
			return activateUploadReview(state, "next");
		if (key.name === "left") state.reviewAction = "confirm";
		else if (key.name === "right") state.reviewAction = "back";
		else if (key.name === "tab")
			state.reviewAction = state.reviewAction === "back" ? "confirm" : "back";
		else return "ignored";
		return "changed";
	}
	if (state.stage && key.name === "a") {
		editUploadSelection(state);
		return "changed";
	}
	if (state.stage && !["up", "down", "return", "space"].includes(key.name))
		return "ignored";
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
				Math.min(filtered.length, state.cursor + (key.name === "up" ? -1 : 1)),
			);
	} else if (key.name === "space") {
		if (state.operation) return "ignored";
		toggleUploadRepository(repositories, state);
	} else if (key.name === "backspace" || (key.ctrl && key.name === "u")) {
		state.selectionVisible = true;
		state.followScan = false;
		state.query = key.ctrl ? "" : [...state.query].slice(0, -1).join("");
		state.cursor = 0;
	} else if (
		key.text &&
		!key.ctrl &&
		!key.meta &&
		!key.text.startsWith("\u001b")
	) {
		state.selectionVisible = true;
		state.followScan = false;
		state.query = (state.query + sanitizeForTerminalDisplay(key.text)).slice(
			0,
			100,
		);
		state.cursor = 0;
	} else return "ignored";
	return "changed";
}

export function hasFailedUploadSessions(
	repositories: UploadRepository[],
): boolean {
	return repositories.some((repo) =>
		repo.sessionUploads?.some((session) => session.status === "failed"),
	);
}

export function activateUploadReview(
	state: UploadManagerState,
	action: ReviewControl["action"],
): "save" | "changed" | "ignored" {
	if (state.stage !== "review" || state.operation || state.scan)
		return "ignored";
	if (action === "confirm") return "save";
	if (action === "back") editUploadSelection(state);
	else
		state.reviewPage = Math.max(
			0,
			Math.min(
				(state.reviewPage ?? 0) + (action === "next" ? 1 : -1),
				(state.reviewPageCount ?? 1) - 1,
			),
		);
	return "changed";
}

export function getPendingRepositories(
	repositories: UploadRepository[],
	state: UploadManagerState,
): UploadRepository[] {
	return repositories.filter(
		(repository) =>
			getDesiredUploadState(repository, state) !== repository.enabled ||
			(state.desired.has(repository.key) &&
				repository.problem &&
				getDesiredUploadState(repository, state)),
	);
}

export function getDesiredUploadState(
	repository: UploadRepository,
	state: UploadManagerState,
): boolean {
	return state.desired.get(repository.key) ?? repository.enabled;
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
	if (!repositories.length) return "off";
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
		const enabled = getAllUploadState(repositories, state) !== "on";
		state.desired = new Map(repositories.map((repo) => [repo.key, enabled]));
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
	state.error = undefined;
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
	state.error = undefined;
	state.uploadFailed = false;
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
