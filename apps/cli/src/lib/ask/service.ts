import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { getPersistentHookCommand } from "../../internal/agent-adapters/persistent-hook-command.js";
import { exec } from "../exec.js";
import { getConfigDir, writePrivateFile } from "../local-state.js";
import {
	ASK_SERVICE_LABEL,
	ASK_SYSTEMD_UNIT,
	type AskServiceDefinition,
	askServiceEnvironment,
	launchAgentPlist,
	systemdUnit,
} from "./service-definition.js";

export interface AskServiceWorkspace {
	readonly slug: string;
	readonly name: string;
}

export interface AskServiceStatus {
	readonly supported: boolean;
	readonly installed: boolean;
	readonly running: boolean;
	readonly workspace?: AskServiceWorkspace;
	readonly logPath: string;
}

type ServicePlatform = "launchd" | "systemd";

const SERVICE_STATE_FILE = "ask-service.json";
const BOOTSTRAP_ATTEMPTS = 3;

export const ASK_SERVICE_UNSUPPORTED_MESSAGE =
	"Ask cannot run in the background on this system yet. Run `opaline ask run` in a terminal to answer questions while it stays open.";

export function askServicePlatform(
	platform: NodeJS.Platform = process.platform,
): ServicePlatform | undefined {
	if (platform === "darwin") return "launchd";
	if (platform === "linux") return "systemd";
	return undefined;
}

export function askLogPath(configDir: string = getConfigDir()): string {
	return join(configDir, "logs", "ask.log");
}

export async function installAskService(
	workspace: AskServiceWorkspace,
): Promise<void> {
	const platform = askServicePlatform();
	if (!platform) throw new Error(ASK_SERVICE_UNSUPPORTED_MESSAGE);
	const configDir = getConfigDir();
	const definition: AskServiceDefinition = {
		command: askRunCommand(["ask", "run", "--workspace", workspace.slug]),
		environment: askServiceEnvironment(process.env),
		logPath: askLogPath(configDir),
	};
	await mkdir(dirname(definition.logPath), { recursive: true, mode: 0o700 });
	if (platform === "launchd") await installLaunchAgent(definition);
	else await installSystemdUnit(definition);
	await writePrivateFile(
		join(configDir, SERVICE_STATE_FILE),
		`${JSON.stringify({ workspace }, null, 2)}\n`,
		configDir,
	);
}

export async function removeAskService(): Promise<boolean> {
	const platform = askServicePlatform();
	if (!platform) return false;
	const file = serviceFilePath(platform);
	const installed = await fileExists(file);
	if (platform === "launchd")
		await run("launchctl", ["bootout", launchdTarget()]);
	else await run("systemctl", ["--user", "disable", "--now", ASK_SYSTEMD_UNIT]);
	await rm(file, { force: true });
	if (platform === "systemd")
		await run("systemctl", ["--user", "daemon-reload"]);
	await rm(join(getConfigDir(), SERVICE_STATE_FILE), { force: true });
	return installed;
}

export async function isAskServiceInstalled(): Promise<boolean> {
	const platform = askServicePlatform();
	return platform ? fileExists(serviceFilePath(platform)) : false;
}

export async function readAskServiceStatus(): Promise<AskServiceStatus> {
	const platform = askServicePlatform();
	const logPath = askLogPath();
	if (!platform)
		return { supported: false, installed: false, running: false, logPath };
	const installed = await fileExists(serviceFilePath(platform));
	return {
		supported: true,
		installed,
		running: installed && (await isRunning(platform)),
		workspace: await readServiceWorkspace(),
		logPath,
	};
}

function askRunCommand(args: readonly string[]): string[] {
	const bundled = extname(fileURLToPath(import.meta.url)) === ".js";
	if (bundled) return getPersistentHookCommand(args);
	return [process.execPath, resolve(process.argv[1] ?? ""), ...args];
}

async function installLaunchAgent(
	definition: AskServiceDefinition,
): Promise<void> {
	const file = serviceFilePath("launchd");
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, launchAgentPlist(definition), { mode: 0o600 });
	await run("launchctl", ["bootout", launchdTarget()]);
	await bootstrapLaunchAgent(file);
}

async function bootstrapLaunchAgent(file: string): Promise<void> {
	for (let attempt = 1; ; attempt++) {
		const result = await run("launchctl", ["bootstrap", launchdDomain(), file]);
		if (result.exitCode === 0) return;
		if (attempt === BOOTSTRAP_ATTEMPTS)
			throw new Error(
				`launchctl bootstrap failed: ${(result.stderr || result.stdout).trim()}`,
			);
		await sleep(1_000);
	}
}

async function installSystemdUnit(
	definition: AskServiceDefinition,
): Promise<void> {
	const file = serviceFilePath("systemd");
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, systemdUnit(definition), { mode: 0o600 });
	await runOrThrow("systemctl", ["--user", "daemon-reload"]);
	await runOrThrow("systemctl", ["--user", "enable", ASK_SYSTEMD_UNIT]);
	await runOrThrow("systemctl", ["--user", "restart", ASK_SYSTEMD_UNIT]);
}

async function isRunning(platform: ServicePlatform): Promise<boolean> {
	if (platform === "launchd") {
		const result = await run("launchctl", ["print", launchdTarget()]);
		return (
			result.exitCode === 0 && /^\s*state = running$/mu.test(result.stdout)
		);
	}
	const result = await run("systemctl", [
		"--user",
		"is-active",
		ASK_SYSTEMD_UNIT,
	]);
	return result.stdout.trim() === "active";
}

async function readServiceWorkspace(): Promise<
	AskServiceWorkspace | undefined
> {
	const parsed = await readJson(join(getConfigDir(), SERVICE_STATE_FILE));
	const workspace =
		typeof parsed === "object" && parsed !== null && "workspace" in parsed
			? parsed.workspace
			: undefined;
	if (
		typeof workspace === "object" &&
		workspace !== null &&
		"slug" in workspace &&
		typeof workspace.slug === "string" &&
		"name" in workspace &&
		typeof workspace.name === "string"
	)
		return { slug: workspace.slug, name: workspace.name };
	return undefined;
}

async function readJson(path: string): Promise<unknown> {
	try {
		return JSON.parse(await readFile(path, "utf8"));
	} catch {
		return undefined;
	}
}

function serviceFilePath(platform: ServicePlatform): string {
	return platform === "launchd"
		? join(homedir(), "Library", "LaunchAgents", `${ASK_SERVICE_LABEL}.plist`)
		: join(homedir(), ".config", "systemd", "user", ASK_SYSTEMD_UNIT);
}

function launchdDomain(): string {
	return `gui/${process.getuid?.() ?? 0}`;
}

function launchdTarget(): string {
	return `${launchdDomain()}/${ASK_SERVICE_LABEL}`;
}

function run(command: string, args: string[]) {
	return exec(command, args);
}

async function runOrThrow(command: string, args: string[]): Promise<void> {
	const result = await run(command, args);
	if (result.exitCode !== 0)
		throw new Error(
			`${command} ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`,
		);
}

async function fileExists(path: string): Promise<boolean> {
	return access(path).then(
		() => true,
		() => false,
	);
}
