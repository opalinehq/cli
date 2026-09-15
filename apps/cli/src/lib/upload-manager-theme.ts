import { type CliCopy, parseCliCopy } from "./cli-copy.js";
import savedTheme from "./upload-manager-theme.json" with { type: "json" };

export interface UploadManagerTheme {
	maxWidth: number;
	padding: number;
	columnGap: number;
	separators: "line" | "dots" | "none";
	focus: "inverse" | "bold" | "underline";
	showSummary: boolean;
	showTotals: boolean;
	showRepoIdentity: boolean;
	dimSecondary: boolean;
	accentColor: string;
	onColor: string;
	offColor: string;
	motionDuration: number;
	copy: CliCopy;
}

const ANSI_COLORS: Record<string, string> = {
	cyan: "36",
	green: "32",
	red: "31",
	yellow: "33",
	blue: "34",
	magenta: "35",
	white: "37",
};

export const UPLOAD_MANAGER_THEME = parseUploadManagerTheme(savedTheme);

export function parseUploadManagerTheme(value: unknown): UploadManagerTheme {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error("Theme must be an object.");
	if (
		!(
			"maxWidth" in value &&
			"padding" in value &&
			"columnGap" in value &&
			"separators" in value &&
			"focus" in value &&
			"showSummary" in value &&
			"showTotals" in value &&
			"showRepoIdentity" in value &&
			"dimSecondary" in value &&
			"accentColor" in value &&
			"onColor" in value &&
			"offColor" in value
		)
	)
		throw new Error("Theme is missing a setting.");
	if (
		value.separators !== "line" &&
		value.separators !== "dots" &&
		value.separators !== "none"
	)
		throw new Error("Choose line, dots, or none for separators.");
	if (
		value.focus !== "inverse" &&
		value.focus !== "bold" &&
		value.focus !== "underline"
	)
		throw new Error("Choose inverse, bold, or underline for focus.");
	return {
		maxWidth: integer(value.maxWidth, "Maximum width", 64, 120),
		padding: integer(value.padding, "Side padding", 1, 4),
		columnGap: integer(value.columnGap, "Column gap", 1, 6),
		separators: value.separators,
		focus: value.focus,
		showSummary: boolean(value.showSummary),
		showTotals: boolean(value.showTotals),
		showRepoIdentity: boolean(value.showRepoIdentity),
		dimSecondary: boolean(value.dimSecondary),
		accentColor: color(value.accentColor),
		onColor: color(value.onColor),
		offColor: color(value.offColor),
		motionDuration: integer(
			"motionDuration" in value ? value.motionDuration : 160,
			"Switch duration",
			0,
			400,
		),
		copy: parseCliCopy("copy" in value ? value.copy : undefined),
	};
}

export function themeColorCode(value: string): string {
	const ansi = ANSI_COLORS[value];
	if (ansi) return ansi;
	return `38;2;${[1, 3, 5].map((start) => Number.parseInt(value.slice(start, start + 2), 16)).join(";")}`;
}

function integer(
	value: unknown,
	label: string,
	min: number,
	max: number,
): number {
	if (
		typeof value !== "number" ||
		!Number.isInteger(value) ||
		value < min ||
		value > max
	)
		throw new Error(`${label} must be an integer between ${min} and ${max}.`);
	return value;
}

function boolean(value: unknown): boolean {
	if (typeof value !== "boolean")
		throw new Error("Visibility settings must be booleans.");
	return value;
}

function color(value: unknown): string {
	if (
		typeof value !== "string" ||
		(!Object.hasOwn(ANSI_COLORS, value) && !/^#[0-9a-f]{6}$/iu.test(value))
	)
		throw new Error("Choose a terminal color or a six-digit hex color.");
	return value;
}
