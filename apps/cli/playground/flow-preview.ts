import type { CliCopyKey } from "../src/lib/cli-copy.js";
import { cliMessage } from "../src/lib/cli-messages.js";
import type { UploadManagerTheme } from "../src/lib/upload-manager-theme.js";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
export const DEMO_ORGANIZATIONS = [
	"Opaline",
	"Personal projects",
	"Design studio",
];

// Clack flow fixtures share every editable message with the real commands.
// They never execute authentication, scan the filesystem, or change upload settings.
export function renderFlowPreview(
	screen: string,
	theme: UploadManagerTheme,
	columns: number,
	frame: number,
	choice: number,
) {
	const lines: string[] = [""];
	const choices: { line: number; index: number; label: string }[] = [];
	const message = (
		key: CliCopyKey,
		values: Record<string, string | number> = {},
	) => cliMessage(key, values, theme);
	const color = (text: string, code: number) =>
		`\u001b[${code}m${text}\u001b[0m`;
	const muted = (text: string) => color(text, 2);
	const line = (symbol: string, text: string, code = 36) => {
		const wrapped = wrap(text, columns - 5);
		for (const [index, part] of wrapped.entries())
			lines.push(` ${index === 0 ? color(symbol, code) : muted("│")}  ${part}`);
	};
	const spin = (text: string) =>
		line(SPINNER[frame % SPINNER.length] ?? "⠋", text);
	const intro = () => {
		line("┌", "opaline login", 2);
		lines.push(` ${muted("│")}`);
	};
	const identity = () =>
		message("authIdentity", { name: "Alex Morgan", email: "alex@example.com" });
	if (screen === "login") {
		intro();
		line("●", message("authBrowser"));
		line("│", "https://app.rudel.ai/device?user_code=DEMO-1234", 2);
		line("●", message("authCode", { code: "DEMO-1234" }));
		spin(message("authWaiting"));
	} else if (screen === "authenticated") {
		intro();
		line("◇", message("authComplete"), 32);
		line("◆", identity(), 32);
		line("└", message("authDone"), 2);
	} else if (screen === "auth-error") {
		intro();
		line("■", message("authFailed"), 31);
		line("×", "Device authorization timed out", 31);
	} else if (screen === "destination") {
		line("◆", message("destination"));
		for (const [index, label] of DEMO_ORGANIZATIONS.entries()) {
			choices.push({ line: lines.length, index, label });
			line(index === choice ? "●" : "○", label, index === choice ? 32 : 2);
		}
		line("└", "", 2);
	} else if (screen === "save-error") {
		line("■", message("saveFailure"), 31);
		line(
			"×",
			message("saveError", { error: "Could not configure the Codex hook." }),
			31,
		);
		line("◆", message("saveReturn"));
		line("└", "", 2);
	} else if (screen === "closed") line("└", message("closed"), 2);
	else if (screen === "whoami") line("●", identity());
	else if (screen === "signed-out") line("●", message("whoamiLoggedOut"));
	else if (screen === "logout") line("◆", message("logoutSuccess"), 32);
	return { ansi: lines.join("\n"), choices };
}

function wrap(text: string, width: number): string[] {
	const lines: string[] = [];
	let current = "";
	let cells = 0;
	const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
	for (const word of text.split(/\s+/u)) {
		const segments = [...segmenter.segment(word)].map(({ segment }) => ({
			text: segment,
			size: /^[\x20-\x7e]+$/u.test(segment) ? segment.length : 2,
		}));
		const wordWidth = segments.reduce((sum, segment) => sum + segment.size, 0);
		if (current && cells + 1 + wordWidth <= width) {
			current += ` ${word}`;
			cells += 1 + wordWidth;
			continue;
		}
		if (current) lines.push(current);
		current = "";
		cells = 0;
		for (const segment of segments) {
			if (cells + segment.size > width) {
				lines.push(current);
				current = "";
				cells = 0;
			}
			current += segment.text;
			cells += segment.size;
		}
	}
	lines.push(current);
	return lines;
}
