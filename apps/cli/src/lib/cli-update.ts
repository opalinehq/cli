import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as p from "@clack/prompts";
import pkg from "../../package.json" with { type: "json" };
import { hasLegacyClaudeHook } from "../internal/agent-adapters/adapters/claude-code/settings.js";
import { hasLegacyCodexHook } from "../internal/agent-adapters/adapters/codex/config.js";
import {
	type AgentAdapter,
	getAllAdapters,
	type HookOptions,
} from "../internal/agent-adapters/index.js";
import {
	getPersistentCliPath,
	writePersistentCli,
} from "../internal/agent-adapters/persistent-hook-command.js";
import { updateHookSettings } from "./auto-upload-hooks.js";
import {
	type CliInstallation,
	findCliInstallations,
	updateCliInstallation,
} from "./cli-installation.js";
import {
	compareCliVersions,
	getCliReleaseUrl,
	getLatestCliRelease,
	readCliBundleVersion,
} from "./cli-release.js";
import { withConfigLock } from "./config-lock.js";
import { getConfigDir, getConfigPathInfo } from "./local-state.js";

interface OwnedHook {
	adapter: AgentAdapter;
	options: HookOptions;
	path: string;
}

export function shouldOfferCliUpdate(
	args: readonly string[],
	interactive: boolean,
	ci: boolean,
): boolean {
	return (
		interactive &&
		!ci &&
		args.length <= 1 &&
		[undefined, "upload", "login", "whoami", "enable", "disable"].includes(
			args[0],
		)
	);
}

// Returns true only when the original command was handed to an updated global
// executable. A pinned runner invocation always keeps its selected CLI version.
export async function offerCliUpdate(
	args: readonly string[],
	explicit = false,
): Promise<boolean> {
	if (!process.stdin.isTTY || !process.stdout.isTTY || process.env.CI) {
		if (explicit)
			throw new Error(
				"Run `opaline update` in an interactive terminal to review the release.",
			);
		return false;
	}
	const currentFile = fileURLToPath(import.meta.url);
	if (extname(currentFile) !== ".js") {
		if (explicit)
			throw new Error(
				"Run `npx opaline@latest update` to update a published installation.",
			);
		return false;
	}
	let target: string;
	try {
		target = await getLatestCliRelease();
	} catch (error) {
		if (explicit) throw error;
		return false; // An offline version check must not block the requested command.
	}
	const source = join(dirname(currentFile), "cli.js");
	const installations = await findCliInstallations();
	const installation =
		installations.length === 1 ? installations[0] : undefined;
	const hooks = getOwnedHooks();
	const runtime = getPersistentCliPath();
	const runtimeExists = existsSync(runtime);
	const runtimeVersion = runtimeExists
		? readCliBundleVersion(readFileSync(runtime, "utf8"))
		: undefined;
	const needsGlobal =
		installation !== undefined &&
		compareCliVersions(installation.version, target) < 0;
	const availableCandidate =
		pkg.version === target
			? source
			: installation?.version === target
				? installation.bundle
				: undefined;
	const needsRuntime =
		(hooks.length > 0 || runtimeExists) &&
		(runtimeVersion === undefined ||
			compareCliVersions(runtimeVersion, target) < 0 ||
			(runtimeVersion === target &&
				availableCandidate !== undefined &&
				readFileSync(runtime, "utf8") !==
					readFileSync(availableCandidate, "utf8")) ||
			hooks.some(hookNeedsMigration));
	if (!needsGlobal && !needsRuntime) {
		if (compareCliVersions(pkg.version, target) < 0)
			p.log.info(
				`Opaline ${target} is available.\nReview: ${getCliReleaseUrl(target)}\nRun: npx opaline@latest update`,
			);
		else if (explicit)
			p.log.success(
				installation
					? "Opaline is up to date."
					: "No outdated automatic-upload runtime found. No supported global installation was identified.",
			);
		if (explicit && (installations.length > 1 || process.platform === "win32"))
			p.log.warn(
				"The global installation cannot be selected safely. Update it with its original package manager.",
			);
		return false;
	}
	if (!availableCandidate && !needsGlobal) {
		p.log.info(
			`Review Opaline ${target}: ${getCliReleaseUrl(target)}\nRun npx opaline@latest update to update your installed Opaline. This invocation keeps version ${pkg.version}.`,
		);
		return false;
	}
	p.log.info(
		`Opaline ${target}\nReview release notes and source: ${getCliReleaseUrl(target)}`,
	);
	const choice = await p.select({
		message: `Update installed Opaline to ${target}? This includes existing automatic uploads.`,
		options: [
			{ value: "update", label: "Update" },
			{ value: "skip", label: "Skip" },
		],
		initialValue: "skip",
	});
	if (p.isCancel(choice)) {
		process.exitCode = 130;
		return true;
	}
	if (choice !== "update") return false;
	const progress = p.spinner();
	progress.start("Updating Opaline");
	let candidate: string | undefined = availableCandidate;
	let updated: CliInstallation | undefined;
	let wasGlobalInvocation = false;
	let refreshedRuntime = false;
	const failures: string[] = [];
	if (needsGlobal && installation) {
		try {
			wasGlobalInvocation =
				(await realpath(source)) === (await realpath(installation.bundle));
			updated = await updateCliInstallation(installation, target);
			candidate = updated.bundle;
		} catch {
			failures.push(
				`The installed CLI could not be updated or verified. Your package manager's permissions or policy may block this exact release.\nUse: ${installation.manager} install -g ${installation.packageName}@${target}`,
			);
		}
	}
	if (needsRuntime && candidate) {
		try {
			await refreshInstalledCliRuntime(candidate, hooks);
			refreshedRuntime = true;
		} catch (error) {
			failures.push(
				`Automatic-upload setup needs attention: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	} else if (needsRuntime)
		failures.push(
			"Automatic uploads were left unchanged because the reviewed release could not be installed.",
		);
	if (installations.length > 1 || process.platform === "win32")
		failures.push(
			"The global installation could not be selected safely. Update it with its original package manager.",
		);
	progress.stop(
		failures.length
			? "Opaline update needs attention"
			: `Opaline ${target} is ready`,
	);
	for (const failure of failures) p.log.warn(failure);
	if (failures.length && updated)
		p.log.info(`Installed CLI verified at ${updated.version}.`);
	if (failures.length && refreshedRuntime)
		p.log.info(`Automatic-upload runtime verified at ${target} or newer.`);
	if (explicit && failures.length) process.exitCode = 1;
	if (updated && wasGlobalInvocation && !explicit && failures.length === 0) {
		process.exitCode = await runUpdatedCli(updated.bundle, args);
		return true;
	}
	return false;
}

export async function refreshInstalledCliRuntime(
	source: string,
	hooks: readonly OwnedHook[],
	env: { configDir?: string } = {},
): Promise<void> {
	const configDir = env.configDir ?? getConfigDir();
	const runtime = join(configDir, "runtime", "cli.js");
	await withConfigLock(configDir, async () => {
		const owned = hooks.filter(({ adapter, options }) =>
			adapter.isHookInstalled(options),
		);
		const migrations = owned.filter(hookNeedsMigration);
		if (
			migrations.length &&
			(getConfigPathInfo().source !== "rudel-default" || env.configDir)
		)
			throw new Error(
				"Legacy hooks in a custom configuration profile require setup for that profile. Existing hooks and runtime were left unchanged.",
			);
		if (!existsSync(runtime) && !owned.length) return;
		for (const { adapter, options } of owned) adapter.validateHook(options);
		writePersistentCli(source, runtime);
		const expected = readCliBundleVersion(readFileSync(source, "utf8"));
		const actual = readCliBundleVersion(readFileSync(runtime, "utf8"));
		if (!expected || !actual || compareCliVersions(actual, expected) < 0)
			throw new Error("The automatic-upload runtime could not be verified.");
		// Runtime activation and agent settings are separate transactions. The
		// settings rollback preserves other hooks if an adapter write fails.
		updateHookSettings(
			migrations.map(({ path }) => path),
			() => {
				for (const { adapter, options } of migrations)
					adapter.installHook(options);
			},
		);
	});
}

function hookNeedsMigration(hook: OwnedHook): boolean {
	return hook.adapter.source === "claude_code"
		? hasLegacyClaudeHook(hook.path)
		: hasLegacyCodexHook(hook.path);
}

function getOwnedHooks(): OwnedHook[] {
	const result = new Map<string, OwnedHook>();
	for (const adapter of getAllAdapters()) {
		const options: HookOptions[] = [{ global: true }];
		if (adapter.source === "claude_code")
			options.push({ projectPath: process.cwd() });
		for (const option of options) {
			const path = adapter.getHookConfigPath(option);
			if (!result.has(path) && adapter.isHookInstalled(option))
				result.set(path, { adapter, options: option, path });
		}
	}
	return [...result.values()];
}

async function runUpdatedCli(
	bundle: string,
	args: readonly string[],
): Promise<number> {
	return await new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [bundle, ...args], {
			stdio: "inherit",
		});
		child.once("error", reject);
		child.once("exit", (code, signal) =>
			resolve(code ?? (signal === "SIGINT" ? 130 : 1)),
		);
	});
}
