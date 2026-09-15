import type { CliCopyKey } from "../src/lib/cli-copy.js";

interface Screen {
	id: string;
	label: string;
	group: string;
	command: string;
	description: string;
	manager: boolean;
	loading: boolean;
	copy: { key: CliCopyKey; label: string }[];
}

export const SCREENS: Screen[] = [
	{
		id: "error",
		label: "Upload error",
		group: "Auto upload",
		command: "opaline upload",
		description:
			"The full error explains the cause and next step. Long details have pages. Retry with Enter or return to your selection with Escape.",
		manager: true,
		loading: false,
		copy: [],
	},
	{
		id: "scan",
		label: "Repository discovery",
		group: "Auto upload",
		command: "opaline upload",
		description:
			"The list follows discoveries. Selection, toggles, and saving become available when scanning finishes. Escape cancels the scan.",
		manager: true,
		loading: true,
		copy: [
			{ key: "scanHeading", label: "Scanning column heading" },
			{ key: "repositoryHeading", label: "Repository column heading" },
		],
	},
	{
		id: "repositories",
		label: "Repository toggles",
		group: "Auto upload",
		command: "opaline upload",
		description:
			"Click a repository, or use ↑↓ and Space. Enter opens a review of all selected repositories before anything is saved or uploaded.",
		manager: true,
		loading: false,
		copy: [],
	},
	{
		id: "pending",
		label: "Unsaved changes",
		group: "Auto upload",
		command: "opaline upload",
		description:
			"Two staged changes. Enter reviews the selection; Escape discards changes.",
		manager: true,
		loading: false,
		copy: [],
	},
	{
		id: "review",
		label: "Review upload",
		group: "Auto upload",
		command: "opaline upload",
		description:
			"Review Newly added, Already active and Deactivated repositories. Confirm the selection or go back to edit; long lists have page controls.",
		manager: true,
		loading: false,
		copy: [
			{ key: "managerTitle", label: "Title" },
			{ key: "confirmSelection", label: "Confirm action" },
			{ key: "goBack", label: "Back action" },
			{ key: "selectionNew", label: "Newly added section" },
			{ key: "selectionActive", label: "Already active section" },
			{ key: "selectionDeactivated", label: "Deactivated section" },
		],
	},
	{
		id: "destination",
		label: "Choose destination",
		group: "Auto upload",
		command: "opaline upload",
		description:
			"Shown only when the user has multiple workspaces. A single workspace is selected automatically. Use ↑↓ and Enter.",
		manager: false,
		loading: false,
		copy: [{ key: "destination", label: "Destination prompt" }],
	},
	{
		id: "saving",
		label: "Uploading sessions",
		group: "Auto upload",
		command: "opaline upload",
		description:
			"Existing sessions upload in this table. Counts update per repository; completed rows keep their totals.",
		manager: true,
		loading: true,
		copy: [
			{ key: "saveProgress", label: "While saving" },
			{ key: "uploadProgress", label: "While uploading" },
		],
	},
	{
		id: "saved-new",
		label: "Upload complete · New user",
		group: "Auto upload",
		command: "opaline upload",
		description:
			"First-time upload complete. Continue setup in the browser from the onboarding step.",
		manager: true,
		loading: false,
		copy: [
			{ key: "uploadSuccess", label: "Upload confirmation" },
			{ key: "continueSetup", label: "Continue setup link" },
		],
	},
	{
		id: "saved",
		label: "Upload complete · Returning user",
		group: "Auto upload",
		command: "opaline upload",
		description:
			"Completed counts stay in the table. Returning users can open their workspace’s sessions from the link below.",
		manager: true,
		loading: false,
		copy: [
			{ key: "saveSummary", label: "Settings confirmation" },
			{ key: "uploadSuccess", label: "Upload confirmation" },
		],
	},
	{
		id: "empty",
		label: "No repositories",
		group: "Edge cases",
		command: "opaline upload",
		description:
			"No local repositories were found. The controls remain available.",
		manager: true,
		loading: false,
		copy: [{ key: "managerEmpty", label: "Empty state" }],
	},
	{
		id: "repair",
		label: "Setup issue",
		group: "Edge cases",
		command: "opaline upload",
		description:
			"An enabled repository needs its hook repaired. Enter retries setup.",
		manager: true,
		loading: false,
		copy: [],
	},
	{
		id: "save-error",
		label: "Save failed",
		group: "Edge cases",
		command: "opaline upload",
		description:
			"Some changes could not be saved. Enter returns to the pending repository choices.",
		manager: false,
		loading: false,
		copy: [
			{ key: "saveFailure", label: "Status" },
			{ key: "saveError", label: "Error detail" },
			{ key: "saveReturn", label: "Return prompt" },
		],
	},
	{
		id: "closed",
		label: "Manager closed",
		group: "Edge cases",
		command: "opaline upload",
		description: "Closing the manager keeps already saved settings.",
		manager: false,
		loading: false,
		copy: [
			{ key: "closed", label: "Closing message" },
			{ key: "discarded", label: "When discarding changes" },
		],
	},
	{
		id: "login",
		label: "Browser sign-in",
		group: "Account",
		command: "opaline login",
		description:
			"A sample device code and browser URL. Enter simulates browser approval.",
		manager: false,
		loading: true,
		copy: [
			{ key: "authBrowser", label: "Browser instruction" },
			{ key: "authCode", label: "Device code" },
			{ key: "authWaiting", label: "While waiting" },
		],
	},
	{
		id: "authenticated",
		label: "Signed in",
		group: "Account",
		command: "opaline login",
		description:
			"Browser authorization succeeded and the CLI has saved the account.",
		manager: false,
		loading: false,
		copy: [
			{ key: "authComplete", label: "Status" },
			{ key: "authIdentity", label: "Account" },
			{ key: "authDone", label: "Closing message" },
		],
	},
	{
		id: "auth-error",
		label: "Sign-in failed",
		group: "Account",
		command: "opaline login",
		description:
			"The device authorization timed out. Enter retries the sample sign-in.",
		manager: false,
		loading: false,
		copy: [{ key: "authFailed", label: "Failure message" }],
	},
	{
		id: "whoami",
		label: "Current account",
		group: "Account",
		command: "opaline whoami",
		description: "Show the currently signed-in account.",
		manager: false,
		loading: false,
		copy: [{ key: "authIdentity", label: "Account" }],
	},
	{
		id: "signed-out",
		label: "Not signed in",
		group: "Account",
		command: "opaline whoami",
		description:
			"No credentials are available. Enter previews the sign-in flow.",
		manager: false,
		loading: false,
		copy: [{ key: "whoamiLoggedOut", label: "Sign-in instruction" }],
	},
	{
		id: "logout",
		label: "Signed out",
		group: "Account",
		command: "opaline logout",
		description: "The CLI has removed the account credentials.",
		manager: false,
		loading: false,
		copy: [{ key: "logoutSuccess", label: "Confirmation" }],
	},
];

export function isUploadCompleteScreen(id: string): boolean {
	return id === "saved" || id === "saved-new";
}

export const UPLOAD_FLOW = [
	"scan",
	"repositories",
	"pending",
	"review",
	"login",
	"authenticated",
	"destination",
	"saving",
	"saved",
];

export function getUploadFlow(workspaceCount: number): string[] {
	return UPLOAD_FLOW.filter((id) => id !== "destination" || workspaceCount > 1);
}

export function screenById(id: string): Screen {
	const screen = SCREENS.find((screen) => screen.id === id);
	if (!screen) throw new Error("Unknown CLI screen.");
	return screen;
}
