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

const HOOK_COMMAND = "opaline hooks claude session-end";
const LEGACY_HOOK_COMMAND = "rudel hooks claude session-end";

function isOwnedHook(command: unknown): boolean {
	if (typeof command !== "string") return false;
	return (
		command === HOOK_COMMAND ||
		command === LEGACY_HOOK_COMMAND ||
		command.endsWith(
			` ${quoteHookArgument(getPersistentCliPath())} hooks claude session-end`,
		)
	);
}

const ClaudeSettingsSchema = z
	.object({
		hooks: z
			.object({
				SessionEnd: z
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
											})
											.passthrough(),
									)
									.optional(),
							})
							.passthrough(),
					)
					.optional(),
			})
			.passthrough()
			.optional(),
	})
	.passthrough();
type ClaudeSettings = z.infer<typeof ClaudeSettingsSchema>;

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
		if (existsSync(candidate)) {
			return candidate;
		}
		if (dir === gitRoot) {
			return join(gitRoot, ".claude");
		}

		const parent = dirname(dir);
		if (parent === dir) {
			return join(gitRoot, ".claude");
		}
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
	const content = readFileSync(path, "utf-8");
	return ClaudeSettingsSchema.parse(JSON.parse(content));
}

export function writeClaudeSettings(
	settings: ClaudeSettings,
	path: string = getClaudeSettingsPath(),
): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
}

export function isHookEnabled(path: string = getClaudeSettingsPath()): boolean {
	const settings = readClaudeSettings(path);
	const entries = settings.hooks?.SessionEnd;
	if (!Array.isArray(entries)) return false;
	return entries.some((entry) =>
		entry.hooks?.some((h) => isOwnedHook(h.command)),
	);
}

export function addHook(path: string = getClaudeSettingsPath()): void {
	const settings = readClaudeSettings(path);
	if (!settings.hooks) {
		settings.hooks = {};
	}
	if (!Array.isArray(settings.hooks.SessionEnd)) {
		settings.hooks.SessionEnd = [];
	}

	const argv = getPersistentHookCommand(["hooks", "claude", "session-end"]);
	const command =
		argv[0] === "opaline" || argv[0] === "rudel"
			? `${argv[0]} hooks claude session-end`
			: `${argv.slice(0, 2).map(quoteHookArgument).join(" ")} hooks claude session-end`;
	let installed = false;
	settings.hooks.SessionEnd = settings.hooks.SessionEnd.flatMap((entry) => {
		if (!Array.isArray(entry.hooks)) return [entry];
		const hooks = entry.hooks.flatMap((hook) => {
			if (!isOwnedHook(hook.command)) return [hook];
			if (installed) return [];
			installed = true;
			return [{ ...hook, command }];
		});
		return hooks.length ? [{ ...entry, hooks }] : [];
	});
	if (!installed)
		settings.hooks.SessionEnd.push({
			matcher: "",
			hooks: [{ type: "command", command, async: true }],
		});

	writeClaudeSettings(settings, path);
}

export function removeHook(path: string = getClaudeSettingsPath()): void {
	const settings = readClaudeSettings(path);
	const hooks = settings.hooks;
	const entries = hooks?.SessionEnd;
	if (!hooks || !Array.isArray(entries)) return;

	hooks.SessionEnd = entries.flatMap((entry) => {
		if (!Array.isArray(entry.hooks)) return [entry];

		const remainingHooks = entry.hooks.filter(
			(hook) => !isOwnedHook(hook.command),
		);
		if (remainingHooks.length === entry.hooks.length) return [entry];
		if (remainingHooks.length === 0) return [];

		return [{ ...entry, hooks: remainingHooks }];
	});

	if (hooks.SessionEnd.length === 0) {
		delete hooks.SessionEnd;
	}
	if (Object.keys(hooks).length === 0) {
		delete settings.hooks;
	}

	writeClaudeSettings(settings, path);
}
