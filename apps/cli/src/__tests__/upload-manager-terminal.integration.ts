import { expect, test } from "bun:test";
import { join } from "node:path";

// This suite runs in the Linux integration job. It checks literal PTY control
// sequences; Windows ConPTY may re-encode those sequences.
for (const mode of [
	"continue",
	"prompt",
	"error",
	"cancel",
	"SIGINT",
	"SIGTERM",
]) {
	test(`terminal handoff restores the screen correctly: ${mode}`, async () => {
		let output = "";
		let confirmed = false;
		let choseWorkspace = false;
		let finished = false;
		const proc = Bun.spawn(
			[
				process.execPath,
				join(import.meta.dir, "helpers/upload-transition.ts"),
				mode,
			],
			{
				timeout: 4000,
				killSignal: "SIGKILL",
				ipc(message, child) {
					if (
						message === "handoff" &&
						(mode === "SIGINT" || mode === "SIGTERM")
					)
						child.kill(mode);
				},
				terminal: {
					cols: 100,
					rows: 24,
					data(terminal, data) {
						output += Buffer.from(data).toString();
						if (!confirmed && output.includes("Confirm selection")) {
							confirmed = true;
							terminal.write(mode === "cancel" ? "\u0003" : "\r");
						}
						if (!choseWorkspace && output.includes("Choose workspace")) {
							choseWorkspace = true;
							terminal.write("\r");
						}
						if (!finished && output.includes("Finished upload")) {
							finished = true;
							terminal.write("\r");
						}
					},
				},
			},
		);
		try {
			const code = await proc.exited;
			expect(confirmed).toBe(true);
			expect(code).toBe(
				mode === "SIGINT"
					? 130
					: mode === "SIGTERM"
						? 143
						: mode === "error"
							? 1
							: 0,
			);
			const entries = output.split("\u001b[?1049h").length - 1;
			const exits = output.split("\u001b[?1049l").length - 1;
			expect(entries).toBe(mode === "prompt" ? 2 : 1);
			expect(exits).toBe(entries);
			expect(output).toContain("\u001b[?25h\u001b[?1049l");
			if (mode === "continue") {
				expect(finished).toBe(true);
				expect(output.indexOf("\u001b[?1049l")).toBeGreaterThan(
					output.indexOf("Finished upload"),
				);
			}
			if (mode === "prompt") {
				expect(choseWorkspace).toBe(true);
				expect(finished).toBe(true);
				expect(output.indexOf("\u001b[?1049l")).toBeLessThan(
					output.indexOf("Choose workspace"),
				);
			}
		} finally {
			proc.kill();
			proc.terminal?.close();
		}
	});
}
