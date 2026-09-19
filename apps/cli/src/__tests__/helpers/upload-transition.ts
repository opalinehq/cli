import { select } from "@clack/prompts";
import type { UploadRepository } from "../../lib/upload-manager-repositories.js";
import type { UploadManagerState } from "../../lib/upload-manager-state.js";
import {
	createUploadScreen,
	promptUploadManager,
} from "../../lib/upload-manager-terminal.js";

const mode = process.argv[2];
const repositories: UploadRepository[] = [
	{
		key: "transition-repo",
		name: "transition-repo",
		paths: ["/sample"],
		enabled: true,
		current: false,
		sources: ["codex"],
		sessionCount: 2,
		uploadedCount: 0,
	},
];
const state: UploadManagerState = {
	query: "",
	cursor: 0,
	desired: new Map(),
	message: "",
	stage: "review",
};
const screen = createUploadScreen();
try {
	if (
		(await promptUploadManager(
			repositories,
			state,
			undefined,
			undefined,
			screen,
		)) === "save"
	) {
		process.send?.("handoff");
		// Exercise the same two-prompt boundary as runUpload's async preflight.
		await new Promise((resolve) => setTimeout(resolve, 300));
		if (mode === "error") throw new Error("Preflight failed");
		if (mode === "prompt") {
			screen.close();
			await select({
				message: "Choose workspace",
				options: [{ value: "demo", label: "Demo" }],
			});
		}
		state.stage = "upload";
		await promptUploadManager(
			repositories,
			state,
			undefined,
			async () => {
				await new Promise((resolve) => setTimeout(resolve, 50));
				state.message = "Finished upload";
				state.singleRun = true;
			},
			screen,
		);
	}
} finally {
	screen.close();
}
