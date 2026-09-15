import { sanitizeForTerminalDisplay } from "../contracts/index.js";
import type { CliCopyKey } from "./cli-copy.js";
import {
	UPLOAD_MANAGER_THEME,
	type UploadManagerTheme,
} from "./upload-manager-theme.js";

export function cliMessage(
	key: CliCopyKey,
	values: Record<string, string | number> = {},
	theme: UploadManagerTheme = UPLOAD_MANAGER_THEME,
): string {
	return sanitizeForTerminalDisplay(
		theme.copy[key].replace(/\{(\w+)\}/gu, (token, name: string) =>
			String(values[name] ?? token),
		),
	);
}
