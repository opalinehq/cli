import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";
import {
	installHook,
	isHookInstalled,
	removeHook,
} from "../internal/agent-adapters/adapters/codex/config.js";
import {
	getPersistentCliPath,
	getRuntimeLauncher,
	isPersistentHookCommand,
} from "../internal/agent-adapters/persistent-hook-command.js";

const HOOK_ARGS = ["hooks", "codex", "turn-complete"];
const directories: string[] = [];
afterAll(async () => {
	await Promise.all(
		directories.map((path) => rm(path, { recursive: true, force: true })),
	);
});

describe("persistent hook launcher", () => {
	test("runs the bundle with Node outside the desktop app", () => {
		expect(
			getRuntimeLauncher({ node: "22.0.0" }, "/usr/local/bin/node"),
		).toEqual(["/usr/local/bin/node"]);
	});

	test("runs the app binary as Node inside the desktop app", () => {
		expect(
			getRuntimeLauncher(
				{ node: "22.0.0", electron: "39.0.0" },
				"/Applications/Opaline.app/Contents/MacOS/Opaline",
			),
		).toEqual([
			"/usr/bin/env",
			"ELECTRON_RUN_AS_NODE=1",
			"/Applications/Opaline.app/Contents/MacOS/Opaline",
		]);
	});

	test("recognizes both launcher forms as Opaline hooks", () => {
		const runtime = getPersistentCliPath();
		expect(
			isPersistentHookCommand(
				["/usr/local/bin/node", runtime, ...HOOK_ARGS],
				HOOK_ARGS,
			),
		).toBe(true);
		expect(
			isPersistentHookCommand(
				[
					"/usr/bin/env",
					"ELECTRON_RUN_AS_NODE=1",
					"/Applications/Opaline.app/Contents/MacOS/Opaline",
					runtime,
					...HOOK_ARGS,
				],
				HOOK_ARGS,
			),
		).toBe(true);
	});

	test("rejects other launchers and runtimes", () => {
		const runtime = getPersistentCliPath();
		for (const command of [
			["/usr/bin/env", "OTHER=1", "/app", runtime, ...HOOK_ARGS],
			["/bin/env", "ELECTRON_RUN_AS_NODE=1", "/app", runtime, ...HOOK_ARGS],
			["/usr/bin/env", "ELECTRON_RUN_AS_NODE=1", runtime, ...HOOK_ARGS],
			["/usr/local/bin/node", "/tmp/cli.js", ...HOOK_ARGS],
			["/usr/local/bin/node", "--flag", runtime, ...HOOK_ARGS],
			["/usr/local/bin/node", runtime, "hooks", "codex"],
		])
			expect(isPersistentHookCommand(command, HOOK_ARGS)).toBe(false);
	});
});

describe("Codex hooks written by the desktop app", () => {
	test("are detected, replaced and removed without keeping a second upload hook", async () => {
		const directory = await mkdtemp(join(tmpdir(), "opaline-desktop-codex-"));
		directories.push(directory);
		const path = join(directory, "config.toml");
		const app = [
			"/usr/bin/env",
			"ELECTRON_RUN_AS_NODE=1",
			"/Applications/Opaline.app/Contents/MacOS/Opaline",
			getPersistentCliPath(),
			...HOOK_ARGS,
		];
		const previous = ["notify-send", "done"];
		await writeFile(
			path,
			`notify = ${JSON.stringify([...app, "--previous-notify", JSON.stringify(previous)])}\n`,
		);
		expect(isHookInstalled(path)).toBe(true);
		installHook(path);
		expect(parse(await readFile(path, "utf8")).notify).toEqual([
			"opaline",
			...HOOK_ARGS,
			"--previous-notify",
			JSON.stringify(previous),
		]);
		await writeFile(path, `notify = ${JSON.stringify(app)}\n`);
		removeHook(path);
		expect(parse(await readFile(path, "utf8")).notify).toBeUndefined();
	});
});
