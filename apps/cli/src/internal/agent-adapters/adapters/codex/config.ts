import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
	parse as parseTOML,
	stringify as stringifyTOML,
	type TomlTable,
} from "smol-toml";
import {
	getPersistentHookCommand,
	isPersistentHookCommand,
} from "../../persistent-hook-command.js";

export const CONFIG_PATH = join(homedir(), ".codex", "config.toml");
const HOOK_ARGS = ["hooks", "codex", "turn-complete"] as const;
const PREVIOUS_NOTIFY_FLAG = "--previous-notify";
const MALFORMED_LEGACY_HOOK_COMMAND = "rudel hooks codex turn-complete";

// Preflight is read-only. Existing notification tools are compatible; only an
// invalid configuration blocks setup. The manager validates before any writes.
export function validateHook(configPath: string = CONFIG_PATH): void {
	validateNotify(readConfig(configPath).notify, configPath);
}

export function installHook(configPath: string = CONFIG_PATH): void {
	const config = readConfig(configPath);
	const current = validateNotify(config.notify, configPath);
	const command = updateNotifyCommand(current, (leaf) => {
		const managed = getManagedCommand(leaf);
		const previous = managed ? managed.previous : leaf;
		const next = getPersistentHookCommand(HOOK_ARGS);
		if (previous?.length)
			next.push(PREVIOUS_NOTIFY_FLAG, JSON.stringify(previous));
		return next;
	});
	if (commandsMatch(current, command)) return;
	config.notify = command;
	writeConfig(configPath, config);
}

export function removeHook(configPath: string = CONFIG_PATH): void {
	const config = readConfig(configPath);
	if (!isNotifyCommand(config.notify, true)) return;
	const current = config.notify;
	const next = updateNotifyCommand(current, (leaf) => {
		const managed = getManagedCommand(leaf);
		return managed ? (managed.previous ?? []) : leaf;
	});
	if (commandsMatch(current, next)) return;
	if (next.length) config.notify = next;
	else delete config.notify;
	writeConfig(configPath, config);
}

export function isHookInstalled(configPath: string = CONFIG_PATH): boolean {
	const { notify } = readConfig(configPath);
	if (!isNotifyCommand(notify)) return false;
	let installed = false;
	updateNotifyCommand(notify, (leaf) => {
		installed = getManagedCommand(leaf) !== undefined;
		return leaf;
	});
	return installed;
}

export function parsePreviousNotify(raw: string): string[] {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		throw new Error(
			"The saved Codex notification command contains invalid JSON. Correct --previous-notify in the Codex config, then retry.",
		);
	}
	if (!isNotifyCommand(value))
		throw new Error(
			"The saved Codex notification command must be a nonempty list of strings. Run `opaline upload` to repair notification setup.",
		);
	return value;
}

function validateNotify(notify: unknown, configPath: string): string[] {
	if (notify === undefined) return [];
	if (!isNotifyCommand(notify, true)) {
		throw new Error(
			`Couldn't enable Codex auto upload.\nThe global Codex notify setting must be a list of strings (a command and its arguments). This setting applies to all repositories.\nConfig: ${configPath}\nFix the notify setting in this file, then retry. Existing notifications were left unchanged.`,
		);
	}
	try {
		updateNotifyCommand(notify, (command) => {
			getManagedCommand(command);
			return command;
		});
	} catch (error) {
		throw new Error(
			`Couldn't enable Codex auto upload.\nConfig: ${configPath}\nThe saved notification chain is invalid. Correct the JSON command after --previous-notify, then retry. This setting applies to all repositories.`,
			{ cause: error },
		);
	}
	return notify;
}

// Computer Use owns the outer notify command and forwards to --previous-notify.
// Keep it outermost so its next launch does not wrap Opaline and notify twice.
// Other commands, including user-written scripts, keep their exact argv.
function updateNotifyCommand(
	command: string[],
	update: (leaf: string[]) => string[],
	depth = 0,
): string[] {
	if (depth > 8)
		throw new Error(
			"Codex notification setup contains too many nested commands. Check notify in ~/.codex/config.toml, then retry.",
		);
	if (
		basename(command[0] ?? "") === "SkyComputerUseClient" &&
		command[1] === "turn-ended"
	) {
		if (
			command.length === 2 ||
			(command.length === 4 && command[2] === PREVIOUS_NOTIFY_FLAG)
		) {
			const saved = command[3];
			const previous = saved === undefined ? [] : parsePreviousNotify(saved);
			const next = updateNotifyCommand(previous, update, depth + 1);
			return next.length
				? [...command.slice(0, 2), PREVIOUS_NOTIFY_FLAG, JSON.stringify(next)]
				: command.slice(0, 2);
		}
	}
	return update(command);
}

function getManagedCommand(
	command: string[],
): { previous: string[] | undefined } | undefined {
	if (isOpalineHookCommand(command)) return { previous: undefined };
	const prefix = command.slice(0, -2);
	const saved = command.at(-1);
	if (
		command.at(-2) === PREVIOUS_NOTIFY_FLAG &&
		saved !== undefined &&
		isOpalineHookCommand(prefix)
	)
		return { previous: parsePreviousNotify(saved) };
	return undefined;
}

function isOpalineHookCommand(command: readonly string[]): boolean {
	return (
		commandsMatch(command, ["opaline", ...HOOK_ARGS]) ||
		commandsMatch(command, ["rudel", ...HOOK_ARGS]) ||
		commandsMatch(command, [MALFORMED_LEGACY_HOOK_COMMAND]) ||
		isPersistentHookCommand(command, HOOK_ARGS)
	);
}

function isNotifyCommand(
	value: unknown,
	allowEmpty = false,
): value is string[] {
	return (
		Array.isArray(value) &&
		(allowEmpty || value.length > 0) &&
		value.every(
			(item: unknown) => typeof item === "string" && !item.includes("\0"),
		) &&
		(value.length === 0 || value[0].trim().length > 0)
	);
}

function commandsMatch(
	command: readonly string[],
	expected: readonly string[],
): boolean {
	return (
		command.length === expected.length &&
		command.every((value, index) => value === expected[index])
	);
}

function readConfig(configPath: string): TomlTable {
	if (!existsSync(configPath)) return {};
	try {
		return parseTOML(readFileSync(configPath, "utf8"));
	} catch (error) {
		throw new Error(
			`Couldn't read Codex notification settings.\nConfig: ${configPath}\n${error instanceof Error ? error.message : String(error)}\nCheck that this file is readable and valid TOML, then retry. This setting applies to all repositories.`,
			{ cause: error },
		);
	}
}

function writeConfig(configPath: string, config: TomlTable): void {
	try {
		mkdirSync(dirname(configPath), { recursive: true });
		writeFileSync(configPath, stringifyTOML(config));
	} catch (error) {
		throw new Error(
			`Couldn't save Codex notification settings.\nConfig: ${configPath}\n${error instanceof Error ? error.message : String(error)}\nCheck that you can write to this file, then retry. This setting applies to all repositories.`,
			{ cause: error },
		);
	}
}
