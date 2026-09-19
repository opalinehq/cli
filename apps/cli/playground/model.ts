import { stripVTControlCharacters } from "node:util";
import { cliMessage } from "../src/lib/cli-messages.js";
import { getUploadCompletion } from "../src/lib/upload-completion.js";
import type { UploadRepository } from "../src/lib/upload-manager-repositories.js";
import {
	filterRepositories,
	getAllUploadState,
	getPendingRepositories,
	getRepositoriesToUpload,
	getTableRepositories,
	type ReviewControl,
	type UploadManagerState,
} from "../src/lib/upload-manager-state.js";
import {
	parseUploadManagerTheme,
	type UploadManagerTheme,
} from "../src/lib/upload-manager-theme.js";
import { renderUploadManager } from "../src/lib/upload-manager-ui.js";
import { renderFlowPreview } from "./flow-preview.js";
import { isUploadCompleteScreen, screenById } from "./screens.js";

export interface DemoState {
	query: string;
	cursor: number;
	selectionVisible?: boolean;
	stage?: "review" | "upload";
	reviewPage?: number;
	reviewPageCount?: number;
	reviewAction?: "confirm" | "back";
	enabled: Record<string, boolean>;
	desired: Record<string, boolean>;
	message: string;
	error?: UploadManagerState["error"];
	viewportStart?: number;
	followScan?: boolean;
	uploaded?: Record<string, number>;
	uploadStart?: Record<string, number>;
	uploadKeys?: string[];
	uploadSucceeded?: boolean;
	uploadPage?: number;
	uploadPageCount?: number;
	uploadFailed?: boolean;
	completion?: UploadManagerState["completion"];
	followUpload?: boolean;
}

export interface PreviewRequest {
	theme: UploadManagerTheme;
	columns: number;
	rows: number;
	dataset: string;
	state: DemoState;
	screen?: string;
	progress?: number;
	frame?: number;
	choice?: number;
}

export interface PreviewResponse {
	screen: string;
	scanning: boolean;
	uploading: boolean;
	uploadKeys: string[];
	uploadTotal: number;
	allState: "on" | "off" | "mixed";
	allKeys: string[];
	choices: { line: number; index: number; label: string }[];
	pendingCount: number;
	ansi: string;
	state: DemoState;
	repositories: { key: string; name: string; enabled: boolean }[];
	selectionRepositories: UploadRepository[];
	visibleRows: { line: number; index: number; key: string; name: string }[];
	reviewControls: ReviewControl[];
}

const NAMES = [
	"opaline",
	"website",
	"payments-api",
	"ios-app",
	"design-system",
	"docs",
	"data-pipeline",
	"internal-tools",
	"desktop",
	"marketing",
	"experiments",
	"infra",
	"sdk",
	"mobile",
	"research",
];
const COUNTS = [128, 42, 7, 1204, 31, 2, 81, 304, 17, 63, 0, 11, 6, 15, 0];
const UPLOADED = [128, 0, 3, 1100, 31, 0, 0, 200, 17, 60, 0, 0, 0, 15, 0];

export function createPreview(value: unknown): PreviewResponse {
	if (!isRecord(value) || !isRecord(value.state))
		throw new Error("Invalid preview request.");
	const error = isRecord(value.state.error) ? value.state.error : {};
	const theme = parseUploadManagerTheme(value.theme);
	const columns = boundedInteger(value.columns, 38, 160);
	const rows = boundedInteger(value.rows, 13, 45);
	const screen = screenById(
		typeof value.screen === "string" ? value.screen : "repositories",
	);
	const progress = boundedInteger(value.progress ?? 0, 0, 100);
	const frame = boundedInteger(value.frame ?? 0, 0, 9);
	const choice = boundedInteger(value.choice ?? 0, 0, 2);
	const allRepositories = sampleRepositories(
		screen.id === "empty"
			? "empty"
			: screen.id === "repair"
				? "repair"
				: value.dataset,
	);
	const knownKeys = new Set(allRepositories.map((repo) => repo.key));
	const enabled = flags(value.state.enabled, knownKeys);
	const desired = flags(value.state.desired, knownKeys);
	const uploaded = counts(value.state.uploaded, knownKeys);
	const uploadStart = counts(value.state.uploadStart, knownKeys);
	let uploadSucceeded = optionalBoolean(value.state.uploadSucceeded) ?? false;
	const uploadKeys = value.state.uploadKeys;
	if (
		value.state.reviewAction !== undefined &&
		value.state.reviewAction !== "confirm" &&
		value.state.reviewAction !== "back"
	)
		throw new Error("Invalid review action.");
	if (
		uploadKeys !== undefined &&
		(!Array.isArray(uploadKeys) ||
			!uploadKeys.every((key) => typeof key === "string" && knownKeys.has(key)))
	)
		throw new Error("Invalid demo upload selection.");
	let selectedKeys: string[] | undefined = Array.isArray(uploadKeys)
		? uploadKeys.filter((key): key is string => typeof key === "string")
		: undefined;
	for (const repository of allRepositories)
		repository.uploadedCount =
			uploaded[repository.key] ?? repository.uploadedCount;
	const state: UploadManagerState = {
		query: shortText(value.state.query),
		cursor: boundedInteger(value.state.cursor, 0, 100),
		selectionVisible: optionalBoolean(value.state.selectionVisible),
		reviewPage: boundedInteger(value.state.reviewPage ?? 0, 0, 100),
		reviewAction: value.state.reviewAction ?? "confirm",
		stage:
			screen.id === "review"
				? "review"
				: screen.id === "saving" ||
						screen.id.startsWith("upload-partial") ||
						screen.id.startsWith("upload-skipped") ||
						screen.id === "upload-failures" ||
						isUploadCompleteScreen(screen.id)
					? "upload"
					: undefined,
		desired: new Map(Object.entries(desired)),
		message: shortText(value.state.message),
		error:
			screen.id === "error"
				? {
						message:
							typeof error.message === "string"
								? error.message
								: "Couldn't enable Codex auto upload.\nThe global Codex notify setting must be a list of strings (a command and its arguments). This setting applies to all repositories.\nConfig: /Users/you/.codex/config.toml\nFix the notify setting in this file, then retry. Existing notifications were left unchanged.",
						page: boundedInteger(error.page ?? 0, 0, 100),
					}
				: undefined,
		viewportStart: boundedInteger(value.state.viewportStart ?? 0, 0, 100),
		followScan: optionalBoolean(value.state.followScan),
		uploadPage: boundedInteger(value.state.uploadPage ?? 0, 0, 1000),
		followUpload: optionalBoolean(value.state.followUpload),
		...(screen.id === "scan" && progress < 100 ? { scan: { frame } } : {}),
	};
	const repositories =
		screen.id === "scan"
			? scanRepositories(allRepositories, progress)
			: allRepositories;
	if (state.scan)
		state.scan.progress = {
			phase:
				progress < 15 ? "sessions" : progress < 90 ? "repositories" : "history",
			sessions: allRepositories.reduce(
				(sum, repo) => sum + repo.sessionCount,
				0,
			),
			repositories: repositories.length,
		};
	for (const repository of repositories)
		repository.enabled = enabled[repository.key] ?? repository.enabled;
	if (screen.id === "saving") {
		selectedKeys ??= getRepositoriesToUpload(repositories, state).map(
			(repo) => repo.key,
		);
		const targets = repositories.filter(
			(repo) => repo.enabled && selectedKeys?.includes(repo.key),
		);
		state.operation =
			progress < 100
				? {
						label: cliMessage(
							progress < 8 || targets.length === 0
								? "saveProgress"
								: "uploadProgress",
							{},
							theme,
						),
						frame,
					}
				: undefined;
		for (const [index, repo] of targets.entries()) {
			const start = uploadStart[repo.key] ?? repo.uploadedCount ?? 0;
			uploadStart[repo.key] = start;
			const fraction = Math.min(
				1,
				Math.max(0, (progress / 100 - (0.3 * index) / targets.length) / 0.7),
			);
			repo.uploadedCount =
				start + Math.round((repo.sessionCount - start) * fraction);
			repo.upload = {
				completed: repo.uploadedCount,
				total: repo.sessionCount,
				active: fraction > 0 && fraction < 1,
				failed: 0,
			};
			uploaded[repo.key] = repo.uploadedCount;
			if (repo.sessionCount > start) {
				repo.sessionUploads = [
					{
						sessionId: `019cb958-d947-7901-916f-ac59e2d3731${index}`,
						source: "codex",
						sessionDate: Date.parse("2026-09-17T09:00:00Z"),
						status:
							fraction === 0
								? "queued"
								: fraction === 1
									? "uploaded"
									: fraction < 0.08
										? "preparing"
										: fraction > 0.85
											? "processing"
											: "uploading",
						uploadedBytes:
							fraction >= 0.85
								? 8_400_000
								: fraction < 0.08
									? 0
									: Math.floor((fraction / 0.85) * 8_400_000),
						totalBytes: fraction === 0 ? undefined : 8_400_000,
					},
				];
				const now = performance.now();
				repo.uploadSpeed = {
					startedAt: now - 2_000,
					samples: repo.upload.active ? [{ at: now, bytes: 2_400_000 }] : [],
				};
			}
		}
		uploadSucceeded = progress === 100 && targets.length > 0;
	}
	if (
		screen.id === "upload-failures" ||
		screen.id.startsWith("upload-partial") ||
		screen.id.startsWith("upload-skipped")
	) {
		state.uploadFailed = true;
		const onlySkipped = screen.id.startsWith("upload-skipped");
		const failedRepositories = repositories
			.filter(
				(row) => row.enabled && row.sessionCount > (row.uploadedCount ?? 0),
			)
			.slice(0, onlySkipped ? 1 : 2);
		const failedCount = !onlySkipped && failedRepositories.length ? 1 : 0;
		const skippedCount = onlySkipped || failedRepositories.length > 1 ? 3 : 0;
		state.message = `${failedCount} failed · ${skippedCount} skipped`;
		if (screen.id.startsWith("upload-partial") || onlySkipped) {
			state.message = `12 uploaded${failedCount ? ` · ${failedCount} failed` : ""} · ${skippedCount} skipped`;
			state.completion = getUploadCompletion(
				"https://opaline.so/rpc",
				!screen.id.endsWith("-new"),
				[{ id: "sample-workspace", slug: "acme" }],
			);
		}
		for (const [index, repo] of failedRepositories.entries()) {
			repo.upload = {
				active: false,
				completed: repo.uploadedCount ?? 0,
				total: repo.sessionCount,
				failed: !onlySkipped && index === 0 ? 1 : 0,
			};
			repo.sessionUploads = [
				{
					sessionId: `019cb958-d947-7901-916f-ac59e2d3731${index}`,
					source: "codex",
					sessionDate: Date.parse("2026-09-17T09:00:00Z"),
					status: "failed",
					failureStage: "processing",
					uploadedBytes: 8_400_000,
					totalBytes: 8_400_000,
					error:
						"503 Service unavailable: the server could not finish processing this session. Retry when the service is available.",
				},
			];
			if (onlySkipped || index > 0)
				repo.sessionUploads = Array.from({ length: 3 }, (_, sessionIndex) => ({
					sessionId: `019cb958-d947-7901-916f-ac59e2d3732${sessionIndex}`,
					source: "codex",
					sessionDate: Date.parse("2026-09-17T09:00:00Z"),
					status: "skipped",
					uploadedBytes: 0,
					totalBytes: (150 + sessionIndex * 25) * 1024 * 1024,
					maxBytes: 128 * 1024 * 1024,
				}));
		}
		for (const repo of repositories)
			uploaded[repo.key] = repo.uploadedCount ?? 0;
	}
	if (
		isUploadCompleteScreen(screen.id) &&
		uploadSucceeded &&
		!Object.keys(uploaded).length
	)
		for (const repo of repositories.filter((repo) => repo.enabled)) {
			repo.uploadedCount = repo.sessionCount;
			uploaded[repo.key] = repo.sessionCount;
		}
	if (
		uploadSucceeded &&
		(isUploadCompleteScreen(screen.id) || screen.id === "saving")
	)
		state.completion = getUploadCompletion(
			"https://opaline.so/rpc",
			screen.id !== "saved-new",
			[{ id: "sample-workspace", slug: "acme" }],
		);
	if (
		isUploadCompleteScreen(screen.id) &&
		!state.message &&
		getPendingRepositories(repositories, state).length === 0
	)
		state.message = cliMessage("saveSummary", { changes: "2 changes" }, theme);
	const flow = screen.manager
		? undefined
		: renderFlowPreview(screen.id, theme, columns, frame, choice);
	const ansi =
		flow?.ansi ??
		renderUploadManager(repositories, state, columns, rows, theme);
	const filtered = filterRepositories(
		getTableRepositories(repositories, state),
		state.query,
	);
	const lines = stripVTControlCharacters(ansi).split("\n");
	let index = state.viewportStart ?? 0;
	const visibleRows: PreviewResponse["visibleRows"] = [];
	for (const [line, text] of lines.entries()) {
		if (!/\[[─●○]{3}\]/u.test(text)) continue;
		if (line === 4) {
			visibleRows.push({
				line,
				index: 0,
				key: "all-repos",
				name: state.stage ? "Selected repos" : "All repos",
			});
			continue;
		}
		const repository = filtered[index];
		if (repository)
			visibleRows.push({
				line,
				index: index + 1,
				key: repository.key,
				name: repository.name,
			});
		index++;
	}
	return {
		selectionRepositories: repositories,
		screen: screen.id,
		scanning: state.scan !== undefined,
		uploading: state.operation !== undefined,
		uploadKeys: getRepositoriesToUpload(repositories, state).map(
			(repo) => repo.key,
		),
		uploadTotal: getRepositoriesToUpload(repositories, state).reduce(
			(sum, repo) => sum + repo.sessionCount - (repo.uploadedCount ?? 0),
			0,
		),
		allState: getAllUploadState(repositories, state),
		allKeys: repositories.map((repo) => repo.key),
		choices: flow?.choices ?? [],
		pendingCount: getPendingRepositories(repositories, state).length,
		ansi,
		state: {
			query: state.query,
			cursor: state.cursor,
			selectionVisible: state.selectionVisible,
			stage: state.stage,
			reviewPage: state.reviewPage,
			reviewPageCount: state.reviewPageCount,
			reviewAction: state.reviewAction,
			desired,
			enabled,
			message: state.message,
			error: state.error,
			viewportStart: state.viewportStart,
			followScan: state.followScan,
			uploadPage: state.uploadPage,
			uploadPageCount: state.uploadPageCount,
			uploadFailed: state.uploadFailed,
			completion: state.completion,
			followUpload: state.followUpload,
			uploaded,
			uploadStart,
			uploadKeys: selectedKeys,
			uploadSucceeded,
		},
		repositories: filtered.map(({ key, name, enabled }) => ({
			key,
			name,
			enabled,
		})),
		visibleRows,
		reviewControls: screen.manager ? (state.reviewControls ?? []) : [],
	};
}

function scanRepositories(
	repositories: UploadRepository[],
	progress: number,
): UploadRepository[] {
	const fraction = progress / 100;
	return repositories
		.slice(0, Math.ceil(repositories.length * Math.min(1, fraction / 0.7)))
		.map((repository, index) => {
			const sessionCount = Math.round(
				repository.sessionCount *
					Math.min(
						1,
						Math.max(0, (fraction - (0.7 * index) / repositories.length) / 0.3),
					),
			);
			return {
				...repository,
				sessionCount,
				uploadedCount: Math.min(repository.uploadedCount ?? 0, sessionCount),
			};
		});
}

function sampleRepositories(dataset: unknown): UploadRepository[] {
	if (
		!["standard", "long", "unicode", "empty", "repair"].includes(
			String(dataset),
		)
	)
		throw new Error("Unknown sample dataset.");
	if (dataset === "empty") return [];
	return Array.from(
		{ length: dataset === "long" ? 80 : NAMES.length },
		(_, index) => {
			let name = NAMES[index % NAMES.length] ?? "repository";
			if (index >= NAMES.length)
				name += `-${Math.floor(index / NAMES.length) + 1}`;
			if (dataset === "unicode" && index > 0)
				name =
					[
						"résumé-api",
						"東京プロジェクト",
						"design-system-with-a-very-long-repository-name",
						"café-mobile",
						"研究-tools",
					][index % 5] ?? name;
			return {
				key: `github.com/team/${name}`,
				name,
				paths: [`/projects/${name}`],
				enabled: index % 3 === 0,
				current: index === 0,
				sessionCount: COUNTS[index % COUNTS.length] ?? index,
				uploadedCount: UPLOADED[index % UPLOADED.length] ?? 0,
				sources: [],
				...(dataset === "repair" && index === 0
					? { problem: "Enter to repair setup for Codex." }
					: {}),
			};
		},
	);
}

function flags(
	value: unknown,
	knownKeys: Set<string>,
): Record<string, boolean> {
	if (!isRecord(value)) throw new Error("Invalid demo switches.");
	for (const [key, flag] of Object.entries(value))
		if (!knownKeys.has(key) || typeof flag !== "boolean")
			throw new Error("Invalid demo repository.");
	return Object.fromEntries(
		Object.entries(value).map(([key, flag]) => [key, flag === true]),
	);
}

function boundedInteger(value: unknown, min: number, max: number): number {
	if (
		typeof value !== "number" ||
		!Number.isInteger(value) ||
		value < min ||
		value > max
	)
		throw new Error(`Choose an integer between ${min} and ${max}.`);
	return value;
}

function optionalBoolean(value: unknown): boolean | undefined {
	if (value === undefined || typeof value === "boolean") return value;
	throw new Error("Invalid demo toggle state.");
}

function shortText(value: unknown): string {
	if (typeof value !== "string" || value.length > 200)
		throw new Error("Preview text is too long.");
	return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function counts(
	value: unknown,
	knownKeys: Set<string>,
): Record<string, number> {
	if (value === undefined) return {};
	if (!isRecord(value)) throw new Error("Invalid demo upload counts.");
	const result: Record<string, number> = {};
	for (const [key, count] of Object.entries(value)) {
		if (
			!knownKeys.has(key) ||
			typeof count !== "number" ||
			!Number.isSafeInteger(count) ||
			count < 0
		)
			throw new Error("Invalid demo upload count.");
		result[key] = count;
	}
	return result;
}
