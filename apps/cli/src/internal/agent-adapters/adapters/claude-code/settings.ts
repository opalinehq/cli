import { execSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import {
	getPersistentCliPath,
	getPersistentHookCommand,
	quoteHookArgument,
} from "../../persistent-hook-command.js";

const HOOK_EVENTS = ["SessionEnd", "SessionStart"] as const;
const HOOKS = {
	SessionEnd: "session-end",
	SessionStart: "session-start",
} as const;
type ClaudeHookEvent = keyof typeof HOOKS;
/**
 * Explicit timeout for Opaline's SessionEnd hook. Without one, Claude Code
 * gives SessionEnd hooks about 1.5 s; the hook's own budgets (upload, inline
 * evidence delivery ending 50 s after the hook started) assume 60 s.
 */
export const SESSION_END_HOOK_TIMEOUT_SECONDS = 60;

const HookEntriesSchema = z
	.array(
		z
			.object({
				matcher: z.string().optional(),
				hooks: z
					.array(
						z
							.object({
								type: z.string().optional(),
								command: z.string().optional(),
								async: z.boolean().optional(),
								timeout: z.number().optional(),
							})
							.passthrough(),
					)
					.optional(),
			})
			.passthrough(),
	)
	.optional();

const ClaudeSettingsSchema = z
	.object({
		hooks: z
			.object({
				SessionEnd: HookEntriesSchema,
				SessionStart: HookEntriesSchema,
			})
			.passthrough()
			.optional(),
	})
	.passthrough();
type ClaudeSettings = z.infer<typeof ClaudeSettingsSchema>;
type HookEntries = NonNullable<
	NonNullable<ClaudeSettings["hooks"]>[ClaudeHookEvent]
>;

function findClaudeDir(cwd: string): string {
	const resolvedCwd = realpathSync(resolve(cwd));
	let gitRoot: string;
	try {
		gitRoot = resolve(
			execSync("git rev-parse --show-toplevel", {
				cwd: resolvedCwd,
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "pipe"],
			}).trim(),
		);
	} catch {
		return join(resolvedCwd, ".claude");
	}
	let dir = resolvedCwd;
	while (true) {
		const candidate = join(dir, ".claude");
		if (existsSync(candidate)) return candidate;
		if (dir === gitRoot) return join(gitRoot, ".claude");
		const parent = dirname(dir);
		if (parent === dir) return join(gitRoot, ".claude");
		dir = parent;
	}
}

export function getClaudeSettingsPath(): string {
	return join(homedir(), ".claude", "settings.json");
}

export function getClaudeProjectSettingsPath(cwd: string): string {
	return join(findClaudeDir(cwd), "settings.json");
}

export function readClaudeSettings(
	path: string = getClaudeSettingsPath(),
): ClaudeSettings {
	if (!existsSync(path)) return {};
	return ClaudeSettingsSchema.parse(JSON.parse(readFileSync(path, "utf-8")));
}

export function writeClaudeSettings(
	settings: ClaudeSettings,
	path: string = getClaudeSettingsPath(),
): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
}

export function isHookEnabled(path: string = getClaudeSettingsPath()): boolean {
	return hasOwnedHook(readClaudeSettings(path), "SessionEnd");
}

export function hasLegacyClaudeHook(path: string): boolean {
	const settings = readClaudeSettings(path);
	if (!hasOwnedHook(settings, "SessionEnd")) return false;
	return (
		!hasOwnedHook(settings, "SessionStart") ||
		hasNamedHook(settings, "SessionStart") ||
		hasNamedHook(settings, "SessionEnd")
	);
}

export function addHook(path: string = getClaudeSettingsPath()): void {
	const settings = readClaudeSettings(path);
	settings.hooks ??= {};
	for (const event of HOOK_EVENTS) {
		settings.hooks[event] = reconcileHook(settings.hooks[event] ?? [], event);
	}
	writeClaudeSettings(settings, path);
}

/**
 * Bring an existing install up to date from inside a hook: add a missing or
 * synchronous SessionStart hook, and give Opaline's SessionEnd hook its
 * explicit timeout (installs made before the timeout existed). Neighbouring
 * hooks and the SessionEnd command itself are left as they are. Returns
 * whether the settings file was rewritten.
 */
export function ensureClaudeHooksCurrent(
	path: string = getClaudeSettingsPath(),
): boolean {
	const settings = readClaudeSettings(path);
	if (!hasOwnedHook(settings, "SessionEnd")) return false;
	const startEntries = settings.hooks?.SessionStart ?? [];
	const endEntries = settings.hooks?.SessionEnd ?? [];
	const startCurrent = startEntries.some((entry) =>
		entry.hooks?.some(
			(hook) =>
				isOwnedHook(hook.command, "SessionStart") &&
				hook.type === "command" &&
				hook.async === true,
		),
	);
	const endCurrent = endEntries.every(
		(entry) =>
			entry.hooks?.every(
				(hook) =>
					!isOwnedHook(hook.command, "SessionEnd") ||
					hook.timeout === SESSION_END_HOOK_TIMEOUT_SECONDS,
			) ?? true,
	);
	if (startCurrent && endCurrent) return false;
	settings.hooks ??= {};
	if (!startCurrent)
		settings.hooks.SessionStart = reconcileHook(startEntries, "SessionStart");
	if (!endCurrent)
		settings.hooks.SessionEnd = endEntries.map((entry) =>
			Array.isArray(entry.hooks)
				? {
						...entry,
						hooks: entry.hooks.map((hook) =>
							isOwnedHook(hook.command, "SessionEnd")
								? { ...hook, timeout: SESSION_END_HOOK_TIMEOUT_SECONDS }
								: hook,
						),
					}
				: entry,
		);
	writeClaudeSettings(settings, path);
	return true;
}

export function removeHook(path: string = getClaudeSettingsPath()): void {
	const settings = readClaudeSettings(path);
	if (!settings.hooks) return;
	for (const event of HOOK_EVENTS) {
		const entries = settings.hooks[event];
		if (!entries) continue;
		const remaining = entries.flatMap((entry) => {
			if (!Array.isArray(entry.hooks)) return [entry];
			const hooks = entry.hooks.filter(
				(hook) => !isOwnedHook(hook.command, event),
			);
			return hooks.length ? [{ ...entry, hooks }] : [];
		});
		if (remaining.length) settings.hooks[event] = remaining;
		else delete settings.hooks[event];
	}
	if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
	writeClaudeSettings(settings, path);
}

function reconcileHook(
	entries: HookEntries,
	event: ClaudeHookEvent,
): HookEntries {
	const owned = {
		type: "command",
		command: getHookCommand(event),
		async: true,
		...(event === "SessionEnd"
			? { timeout: SESSION_END_HOOK_TIMEOUT_SECONDS }
			: {}),
	};
	let installed = false;
	const reconciled = entries.flatMap((entry) => {
		if (!Array.isArray(entry.hooks)) return [entry];
		const hooks = entry.hooks.flatMap((hook) => {
			if (!isOwnedHook(hook.command, event)) return [hook];
			if (installed) return [];
			installed = true;
			return [{ ...hook, ...owned }];
		});
		return hooks.length ? [{ ...entry, hooks }] : [];
	});
	if (!installed) reconciled.push({ matcher: "", hooks: [owned] });
	return reconciled;
}

function getHookCommand(event: ClaudeHookEvent): string {
	const argv = getPersistentHookCommand(["hooks", "claude", HOOKS[event]]);
	return argv[0] === "opaline" || argv[0] === "rudel"
		? `${argv[0]} hooks claude ${HOOKS[event]}`
		: `${argv.slice(0, 2).map(quoteHookArgument).join(" ")} hooks claude ${HOOKS[event]}`;
}

function hasOwnedHook(
	settings: ClaudeSettings,
	event: ClaudeHookEvent,
): boolean {
	return (
		settings.hooks?.[event]?.some((entry) =>
			entry.hooks?.some((hook) => isOwnedHook(hook.command, event)),
		) ?? false
	);
}

function hasNamedHook(
	settings: ClaudeSettings,
	event: ClaudeHookEvent,
): boolean {
	const suffix = `hooks claude ${HOOKS[event]}`;
	return (
		settings.hooks?.[event]?.some((entry) =>
			entry.hooks?.some(
				(hook) =>
					hook.command === `opaline ${suffix}` ||
					hook.command === `rudel ${suffix}`,
			),
		) ?? false
	);
}

function isOwnedHook(command: unknown, event: ClaudeHookEvent): boolean {
	if (typeof command !== "string") return false;
	const suffix = `hooks claude ${HOOKS[event]}`;
	return (
		command === `opaline ${suffix}` ||
		command === `rudel ${suffix}` ||
		command.endsWith(` ${quoteHookArgument(getPersistentCliPath())} ${suffix}`)
	);
}
