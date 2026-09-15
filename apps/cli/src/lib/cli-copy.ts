export const DEFAULT_CLI_COPY = {
	managerTitle: "Opaline session upload",
	confirmSelection: "Confirm selection [ENTER]",
	goBack: "Go back [ESC]",
	managerEmpty: "No repositories found",
	scanHeading: "Scanning repos",
	repositoryHeading: "Repository",
	selectionNew: "Newly added",
	selectionActive: "Already active",
	selectionDeactivated: "Deactivated",
	authBrowser: "If the browser doesn't open, visit:",
	authCode: "User code: {code}",
	authWaiting: "Waiting for browser authentication...",
	authCreating: "Creating ingest token...",
	authFailed: "Authentication failed",
	authComplete: "Authenticated",
	authIdentity: "Logged in as {name} ({email})",
	authDone: "Done!",
	destination: "Where should these repositories upload sessions?",
	saveProgress: "Saving",
	uploadProgress: "Uploading",
	uploadSummary: "{count} uploaded · All done.",
	uploadSuccess: "Successfully uploaded sessions",
	continueSetup: "Continue your setup in the browser",
	saveFailure: "Could not save all changes",
	saveSummary: "Saved {changes}. Automatic uploads updated.",
	saveError: "Save failed: {error}",
	saveReturn: "Press Enter to return to your repositories",
	closed: "Upload settings closed.",
	discarded: "Unsaved changes discarded.",
	whoamiLoggedOut: "Not logged in. Run `opaline login` to authenticate.",
	logoutSuccess: "Logged out successfully.",
};

export type CliCopyKey = keyof typeof DEFAULT_CLI_COPY;
export type CliCopy = Record<CliCopyKey, string>;

export function parseCliCopy(value: unknown): CliCopy {
	if (value === undefined) return { ...DEFAULT_CLI_COPY };
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error("Screen copy must be an object.");
	const copy = { ...DEFAULT_CLI_COPY };
	for (const key of cliCopyKeys()) {
		const text = Reflect.get(value, key);
		if (text === undefined) continue;
		if (
			typeof text !== "string" ||
			!text.trim() ||
			text.length > 180 ||
			/\p{Cc}/u.test(text)
		)
			throw new Error(`Use 1–180 printable characters for ${key}.`);
		const required: string[] = DEFAULT_CLI_COPY[key].match(/\{\w+\}/gu) ?? [];
		const supplied: string[] = text.match(/\{\w+\}/gu) ?? [];
		if (
			required.some((token) => !supplied.includes(token)) ||
			supplied.some((token) => !required.includes(token))
		)
			throw new Error(
				`Keep these placeholders in ${key}: ${required.join(", ") || "none"}.`,
			);
		copy[key] = text;
	}
	return copy;
}

function cliCopyKeys(): CliCopyKey[] {
	return Object.keys(DEFAULT_CLI_COPY).filter((key): key is CliCopyKey =>
		Object.hasOwn(DEFAULT_CLI_COPY, key),
	);
}
