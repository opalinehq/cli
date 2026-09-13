import * as p from "@clack/prompts";
import { sanitizeForTerminalDisplay } from "../contracts/index.js";

export interface UploadRepositoryOption {
	readonly key: string;
	readonly label: string;
	readonly pickerLabel: string;
	readonly sessionCount: number;
	readonly destination: string;
}

export async function selectRepositoriesForUpload(
	repositories: readonly UploadRepositoryOption[],
	options: { readonly dryRun: boolean },
): Promise<string[] | null> {
	let selectedKeys: string[] = [];
	while (true) {
		const selected = await p.multiselect({
			message: [
				"Choose repositories to upload and keep syncing",
				"",
				formatSelectionControls(process.stdout.columns || 80),
				"",
			].join("\n"),
			options: repositories.map((repository) => ({
				value: repository.key,
				label: sanitizeForTerminalDisplay(repository.pickerLabel),
			})),
			initialValues: selectedKeys,
			required: false,
			showInstructions: false,
		});
		if (p.isCancel(selected)) return null;
		selectedKeys = selected;
		const selectedSet = new Set(selectedKeys);
		const selectedRepositories = repositories.filter((repository) =>
			selectedSet.has(repository.key),
		);
		const sessionCount = selectedRepositories.reduce(
			(total, repository) => total + repository.sessionCount,
			0,
		);
		const action = await p.select({
			message: formatUploadReview(selectedRepositories, {
				rows: process.stdout.rows || 24,
				columns: process.stdout.columns || 80,
			}),
			options: [
				{ value: "back", label: "Back to selection" },
				{
					value: "upload",
					label: options.dryRun
						? `Preview ${formatCount(sessionCount, "session")}`
						: sessionCount === 0 && selectedRepositories.length > 0
							? "Enable automatic uploads"
							: `Upload ${formatCount(sessionCount, "session")}`,
					disabled: selectedRepositories.length === 0,
				},
				{ value: "cancel", label: "Cancel" },
			],
			initialValue: "back",
		});
		if (p.isCancel(action) || action === "cancel") return null;
		if (action === "upload") return selectedKeys;
	}
}

export function formatUploadReview(
	repositories: readonly UploadRepositoryOption[],
	viewport: { readonly rows: number; readonly columns: number },
): string {
	const sessionCount = repositories.reduce(
		(total, repository) => total + repository.sessionCount,
		0,
	);
	const destinations = new Set(
		repositories.map((repository) => repository.destination),
	);
	const destination =
		destinations.size > 1
			? "Multiple workspaces (shown below)"
			: (destinations.values().next().value ?? "No projects selected");
	// Leave room for the heading, totals, destination, and all three actions.
	const maxRepositories = Math.max(1, Math.min(8, viewport.rows - 14));
	const width = Math.max(20, viewport.columns - 4);
	const lines = [
		"Review upload",
		`${formatCount(repositories.length, "project")} · ${formatCount(sessionCount, "session")}`,
		truncateLine(`Destination: ${destination}`, width),
		"",
		...repositories.slice(0, maxRepositories).map((repository) => {
			const count = formatCount(repository.sessionCount, "session");
			const name = truncateLine(repository.label, width - count.length - 2);
			const target =
				destinations.size > 1
					? ` → ${sanitizeForTerminalDisplay(repository.destination)}`
					: "";
			return truncateLine(`${name}  ${count}${target}`, width);
		}),
	];
	if (repositories.length > maxRepositories)
		lines.push(`… and ${repositories.length - maxRepositories} more projects`);
	lines.push("", "Selected repositories will keep syncing.");
	return lines.join("\n");
}

function formatSelectionControls(columns: number): string {
	const navigate = "[↑ / ↓]  Navigate";
	const select = "[Space]  Select / unselect";
	const review = "[Enter]  Review upload";
	const cancel = "[Esc]    Cancel";
	return (
		columns >= 56
			? [`${navigate.padEnd(26)}${select}`, `${review.padEnd(26)}${cancel}`]
			: [navigate, select, review, cancel]
	).join("\n");
}

function formatCount(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function truncateLine(value: string, width: number): string {
	const characters = Array.from(sanitizeForTerminalDisplay(value));
	return characters.length <= width
		? characters.join("")
		: `${characters.slice(0, Math.max(1, width - 1)).join("")}…`;
}
