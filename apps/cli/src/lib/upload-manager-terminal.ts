import { emitKeypressEvents, type Key } from "node:readline";
import { cliMessage } from "./cli-messages.js";
import type { UploadRepository } from "./upload-manager-repositories.js";
import {
	activateUploadReview,
	applyUploadKey,
	filterRepositories,
	getAllUploadState,
	getDesiredUploadState,
	getTableRepositories,
	type ReviewControl,
	type UploadManagerState,
} from "./upload-manager-state.js";
import { UPLOAD_MANAGER_THEME } from "./upload-manager-theme.js";
import { renderUploadManager } from "./upload-manager-ui.js";

const SCAN_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SCAN_FRAME_MS = 80;

export type UploadRepositoryScan = (
	onRepositories: (repositories: UploadRepository[]) => void,
	signal: AbortSignal,
) => Promise<UploadRepository[]>;

export function promptUploadManager(
	repositories: UploadRepository[],
	state: UploadManagerState,
	scan?: UploadRepositoryScan,
	operation?: (signal: AbortSignal) => Promise<void>,
): Promise<"save" | "cancel"> {
	return new Promise((resolve, reject) => {
		const input = process.stdin;
		const output = process.stdout;
		const wasRaw = input.isRaw;
		const togglePositions = new Map<string, number>();
		const animations = new Map<string, ReturnType<typeof setTimeout>[]>();
		const controller = new AbortController();
		let finished = false;
		let scanTimer: ReturnType<typeof setInterval> | undefined;
		let operationTimer: ReturnType<typeof setInterval> | undefined;
		let cancelAfterOperation = false;
		let mouseEnabled = false;
		let mouseInput = "";
		let readingMouseKey = false;
		state.scan = scan ? { frame: 0 } : undefined;
		state.operation = operation
			? { label: cliMessage("saveProgress"), frame: 0 }
			: undefined;
		emitKeypressEvents(input);
		input.setRawMode(true);
		input.resume();
		output.write("\u001b[?1049h\u001b[?25l");
		const render = () => {
			if (finished) return;
			const enableMouse =
				state.stage === "review" && !state.operation && !state.scan;
			if (enableMouse !== mouseEnabled) {
				output.write(
					enableMouse
						? "\u001b[?1000h\u001b[?1006h"
						: "\u001b[?1000l\u001b[?1006l",
				);
				mouseEnabled = enableMouse;
			}
			output.write(
				`\u001b[H\u001b[2J${renderUploadManager(repositories, state, output.columns || 80, output.rows || 24, UPLOAD_MANAGER_THEME, togglePositions)}`,
			);
		};
		const finish = (result: "save" | "cancel", error?: unknown) => {
			if (finished) return;
			finished = true;
			controller.abort();
			clearInterval(scanTimer);
			clearInterval(operationTimer);
			for (const timers of animations.values())
				for (const timer of timers) clearTimeout(timer);
			input.off("keypress", onKey);
			input.off("data", onMouseData);
			input.off("end", cancel);
			output.off("resize", render);
			process.off("SIGTERM", terminate);
			input.setRawMode(wasRaw);
			input.pause();
			if (mouseEnabled) output.write("\u001b[?1000l\u001b[?1006l");
			output.write("\u001b[?25h\u001b[?1049l");
			if (error !== undefined) reject(error);
			else resolve(result);
		};
		const cancel = () => {
			if (state.operation) {
				cancelAfterOperation = true;
				controller.abort();
				state.message = "Stopping uploads…";
				render();
			} else finish("cancel");
		};
		const terminate = () => {
			process.exitCode = 143;
			cancel();
		};
		const activateReview = (action: ReviewControl["action"]) => {
			if (finished) return;
			if (activateUploadReview(state, action) === "save") finish("save");
			else render();
		};
		const onMouseData = (chunk: Buffer | string) => {
			if (!mouseEnabled) return;
			mouseInput = (mouseInput + chunk.toString()).slice(-512);
			let start = mouseInput.indexOf("\u001b[<");
			while (start >= 0) {
				const match = /^(\d+);(\d+);(\d+)([Mm])/u.exec(
					mouseInput.slice(start + 3),
				);
				if (!match) break;
				mouseInput = mouseInput.slice(start + 3 + match[0].length);
				if (match[1] === "0" && match[4] === "M") {
					const column = Number(match[2]) - 1;
					const line = Number(match[3]) - 1;
					const control = state.reviewControls?.find(
						(item) =>
							!item.disabled &&
							item.line === line &&
							column >= item.column &&
							column < item.column + item.width,
					);
					if (control) activateReview(control.action);
				}
				start = mouseInput.indexOf("\u001b[<");
			}
		};
		const onKey = (text: string | undefined, key: Key) => {
			if (finished) return;
			// Readline splits SGR mouse reports into an escape prefix and individual
			// characters. Consume the entire report, including a release that arrives
			// after Go back has already returned to the editable picker.
			const sequence = key.sequence ?? text ?? "";
			if (sequence.startsWith("\u001b[<")) {
				readingMouseKey = !/[Mm]$/u.test(sequence);
				return;
			}
			if (readingMouseKey) {
				if (sequence.startsWith("\u001b")) readingMouseKey = false;
				else {
					if (/[Mm]$/u.test(sequence)) readingMouseKey = false;
					return;
				}
			}
			if (
				((output.columns || 80) < 38 || (output.rows || 24) < 13) &&
				key.name !== "escape" &&
				!key.ctrl
			)
				return;
			const repository = filterRepositories(
				getTableRepositories(repositories, state),
				state.query,
			)[state.cursor - 1];
			const targetKey = state.cursor === 0 ? "all-repos" : repository?.key;
			const previous =
				state.cursor === 0
					? getAllUploadState(repositories, state)
					: repository && getDesiredUploadState(repository, state)
						? "on"
						: "off";
			const result = applyUploadKey(repositories, state, {
				name: key.name ?? "",
				text,
				ctrl: key.ctrl,
				meta: key.meta,
			});
			if (result === "save") return finish("save");
			if (result === "cancel") return cancel();
			if (result === "ignored") return;
			if (key.name === "space" && targetKey) {
				for (const timer of animations.get(targetKey) ?? [])
					clearTimeout(timer);
				const duration = UPLOAD_MANAGER_THEME.motionDuration;
				if (duration) {
					togglePositions.set(
						targetKey,
						togglePositions.get(targetKey) ??
							(previous === "mixed" ? 1 : previous === "on" ? 2 : 0),
					);
					animations.set(targetKey, [
						setTimeout(() => {
							togglePositions.set(targetKey, 1);
							render();
						}, duration / 2),
						setTimeout(() => {
							togglePositions.delete(targetKey);
							animations.delete(targetKey);
							render();
						}, duration),
					]);
				}
			}
			render();
		};
		input.on("keypress", onKey);
		input.on("data", onMouseData);
		input.on("end", cancel);
		output.on("resize", render);
		process.on("SIGTERM", terminate);
		render();
		if (operation) {
			operationTimer = setInterval(() => {
				if (state.operation)
					state.operation.frame =
						(state.operation.frame + 1) % SCAN_FRAMES.length;
				render();
			}, SCAN_FRAME_MS);
			void Promise.resolve()
				.then(() => operation(controller.signal))
				.catch((error: unknown) => {
					if (!controller.signal.aborted)
						state.message =
							error instanceof Error ? error.message : String(error);
				})
				.finally(() => {
					clearInterval(operationTimer);
					state.operation = undefined;
					if (cancelAfterOperation) finish("cancel");
					else render();
				});
		}
		if (scan) {
			// Discovery can emit thousands of updates. Repaint at a steady cadence.
			scanTimer = setInterval(() => {
				if (state.scan)
					state.scan.frame = (state.scan.frame + 1) % SCAN_FRAMES.length;
				render();
			}, SCAN_FRAME_MS);
			void Promise.resolve()
				.then(() =>
					scan((rows) => {
						if (!finished) repositories.splice(0, repositories.length, ...rows);
					}, controller.signal),
				)
				.then((rows) => {
					if (finished) return;
					repositories.splice(0, repositories.length, ...rows);
					state.scan = undefined;
					clearInterval(scanTimer);
					render();
				})
				.catch((error: unknown) => {
					if (!finished) finish("cancel", error);
				});
		}
	});
}
