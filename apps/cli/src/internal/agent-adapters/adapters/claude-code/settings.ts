import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { getCliCommand } from "../../cli-command.js";

const HOOK_COMMAND = "opaline hooks claude session-end";
const LEGACY_HOOK_COMMAND = "rudel hooks claude session-end";

interface HookEntry {
	type: string;
	command: string;
	async?: boolean;
}

interface HookMatcher {
	matcher: string;
	hooks: HookEntry[];
}

interface ClaudeSettings {
	hooks?: {
		SessionEnd?: HookMatcher[];
		[key: string]: unknown;
	};
	[key: string]: unknown;
}

export function getClaudeSettingsPath(): string {
	return join(homedir(), ".claude", "settings.json");
}

export function readClaudeSettings(): ClaudeSettings {
	const path = getClaudeSettingsPath();
	if (!existsSync(path)) return {};
	const content = readFileSync(path, "utf-8");
	return JSON.parse(content) as ClaudeSettings;
}

export function writeClaudeSettings(settings: ClaudeSettings): void {
	const path = getClaudeSettingsPath();
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
}

export function isHookEnabled(): boolean {
	const settings = readClaudeSettings();
	const entries = settings.hooks?.SessionEnd;
	if (!Array.isArray(entries)) return false;
	return entries.some((entry) =>
		entry.hooks?.some((hook) => isOpalineHookCommand(hook.command)),
	);
}

export function addHook(): void {
	const settings = readClaudeSettings();
	const command =
		getCliCommand() === "rudel" ? LEGACY_HOOK_COMMAND : HOOK_COMMAND;
	if (!settings.hooks) {
		settings.hooks = {};
	}
	if (!Array.isArray(settings.hooks.SessionEnd)) {
		settings.hooks.SessionEnd = [];
	}

	for (const entry of settings.hooks.SessionEnd) {
		for (const hook of entry.hooks ?? []) {
			if (hook.command === command) return;
			if (isOpalineHookCommand(hook.command)) {
				hook.command = command;
				writeClaudeSettings(settings);
				return;
			}
		}
	}

	settings.hooks.SessionEnd.push({
		matcher: "",
		hooks: [{ type: "command", command, async: true }],
	});

	writeClaudeSettings(settings);
}

export function removeHook(): void {
	const settings = readClaudeSettings();
	const hooks = settings.hooks;
	const entries = hooks?.SessionEnd;
	if (!hooks || !Array.isArray(entries)) return;

	hooks.SessionEnd = entries
		.map((entry) => ({
			...entry,
			hooks: entry.hooks.filter((hook) => !isOpalineHookCommand(hook.command)),
		}))
		.filter((entry) => entry.hooks.length > 0);

	if (hooks.SessionEnd.length === 0) {
		delete hooks.SessionEnd;
	}
	if (Object.keys(hooks).length === 0) {
		delete settings.hooks;
	}

	writeClaudeSettings(settings);
}

function isOpalineHookCommand(command: string): boolean {
	return command === HOOK_COMMAND || command === LEGACY_HOOK_COMMAND;
}
