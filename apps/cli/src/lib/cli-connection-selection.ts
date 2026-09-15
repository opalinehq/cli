import { randomUUID } from "node:crypto";
import {
	CliConnectionRepositoriesSchema,
	type Source,
	sanitizeForTerminalDisplay,
} from "../contracts/index.js";
import type { UploadRepository } from "./upload-manager-repositories.js";
import {
	getDesiredUploadState,
	type UploadManagerState,
} from "./upload-manager-ui.js";

export function getConnectionSelection(
	repositories: UploadRepository[],
	state: UploadManagerState,
	installedSources: Source[],
) {
	return CliConnectionRepositoriesSchema.parse(
		repositories.map((repository) => ({
			id: randomUUID(),
			name:
				sanitizeForTerminalDisplay(repository.name)
					.replace(/[\r\n\t]/gu, " ")
					.slice(0, 160)
					.trim() || "Repository",
			sessionCount: repository.sessionCount,
			enabled: getDesiredUploadState(repository, state),
			sources: [
				...new Set(
					repository.sources.length ? repository.sources : installedSources,
				),
			],
		})),
	);
}
