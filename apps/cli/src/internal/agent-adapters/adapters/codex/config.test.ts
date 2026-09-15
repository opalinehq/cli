import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseTOML } from "smol-toml";
import {
	installHook,
	isHookInstalled,
	removeHook,
	validateHook,
} from "./config.js";

let tempDir: string;

beforeAll(async () => {
	tempDir = await mkdtemp(join(tmpdir(), "opaline-codex-config-"));
});

afterAll(async () => {
	await rm(tempDir, { recursive: true, force: true });
});

function configPath(name: string): string {
	return join(tempDir, `${name}.toml`);
}

async function readNotify(path: string): Promise<unknown> {
	const config = parseTOML(await readFile(path, "utf8"));
	return config.notify;
}

describe("Codex notify configuration", () => {
	test("recognizes and migrates Rudel inside Computer Use without retaining a second upload hook", async () => {
		const path = configPath("wrapped-rudel");
		const outer = [
			"/Applications/Codex Computer Use.app/Contents/MacOS/SkyComputerUseClient",
			"turn-ended",
			"--previous-notify",
		];
		await writeFile(
			path,
			`notify = ${JSON.stringify([...outer, JSON.stringify(["rudel", "hooks", "codex", "turn-complete"])])}\n`,
		);
		expect(isHookInstalled(path)).toBe(true);
		installHook(path);
		expect(await readNotify(path)).toEqual([
			...outer,
			JSON.stringify(["opaline", "hooks", "codex", "turn-complete"]),
		]);
		removeHook(path);
		expect(await readNotify(path)).toEqual(outer.slice(0, 2));
		installHook(path);
		expect(await readNotify(path)).toEqual([
			...outer,
			JSON.stringify(["opaline", "hooks", "codex", "turn-complete"]),
		]);
	});
	test("installs Opaline as one argv vector and is idempotent", async () => {
		const path = configPath("fresh");

		installHook(path);
		installHook(path);

		expect(await readNotify(path)).toEqual([
			"opaline",
			"hooks",
			"codex",
			"turn-complete",
		]);
		expect(isHookInstalled(path)).toBe(true);
	});

	test("migrates Rudel's malformed legacy singleton", async () => {
		const path = configPath("legacy-singleton");
		await writeFile(path, 'notify = ["rudel hooks codex turn-complete"]\n', {
			flag: "wx",
		});

		installHook(path);

		expect(await readNotify(path)).toEqual([
			"opaline",
			"hooks",
			"codex",
			"turn-complete",
		]);
	});

	test("migrates Rudel's legacy argv vector", async () => {
		const path = configPath("legacy-vector");
		await writeFile(
			path,
			'notify = ["rudel", "hooks", "codex", "turn-complete"]\n',
			{ flag: "wx" },
		);

		expect(isHookInstalled(path)).toBe(true);
		installHook(path);

		expect(await readNotify(path)).toEqual([
			"opaline",
			"hooks",
			"codex",
			"turn-complete",
		]);
	});

	test("installs into an explicitly empty notify vector", async () => {
		const path = configPath("empty");
		await writeFile(path, "notify = []\n", { flag: "wx" });

		installHook(path);

		expect(await readNotify(path)).toEqual([
			"opaline",
			"hooks",
			"codex",
			"turn-complete",
		]);
	});

	test("preserves an unrelated existing notify command", async () => {
		const path = configPath("existing");
		const original = 'notify = ["python3", "/tmp/notify.py"]\n';
		await writeFile(path, original, { flag: "wx" });

		validateHook(path);
		installHook(path);
		const installed = await readFile(path, "utf8");
		installHook(path);
		expect(await readFile(path, "utf8")).toBe(installed);
		expect(await readNotify(path)).toEqual([
			"opaline",
			"hooks",
			"codex",
			"turn-complete",
			"--previous-notify",
			JSON.stringify(["python3", "/tmp/notify.py"]),
		]);
		expect(isHookInstalled(path)).toBe(true);
		removeHook(path);
		expect(await readNotify(path)).toEqual(["python3", "/tmp/notify.py"]);
	});

	test("preserves every argument of a custom notifier, including a legacy-looking argument", async () => {
		const path = configPath("legacy-appended");
		await writeFile(
			path,
			'notify = ["python3", "/tmp/notify.py", "rudel hooks codex turn-complete"]\n',
			{ flag: "wx" },
		);

		validateHook(path);
		installHook(path);
		expect(await readNotify(path)).toEqual([
			"opaline",
			"hooks",
			"codex",
			"turn-complete",
			"--previous-notify",
			JSON.stringify([
				"python3",
				"/tmp/notify.py",
				"rudel hooks codex turn-complete",
			]),
		]);
		expect(isHookInstalled(path)).toBe(true);
		removeHook(path);
		expect(await readNotify(path)).toEqual([
			"python3",
			"/tmp/notify.py",
			"rudel hooks codex turn-complete",
		]);
	});

	test("preserves the Computer Use notification chain, including its nested custom command", async () => {
		const path = configPath("computer-use");
		const previous = [
			"/Applications/Codex Computer Use.app/Contents/MacOS/SkyComputerUseClient",
			"turn-ended",
			"--previous-notify",
			JSON.stringify([
				"/home/me/.local/bin/codex-notify",
				"rudel hooks codex turn-complete",
			]),
		];
		await writeFile(
			path,
			`model = "keep-me"\nnotify = ${JSON.stringify(previous)}\n`,
		);
		validateHook(path);
		installHook(path);
		const installed = await readFile(path, "utf8");
		installHook(path);
		expect(await readFile(path, "utf8")).toBe(installed);
		expect(isHookInstalled(path)).toBe(true);
		expect(await readNotify(path)).toEqual([
			...previous.slice(0, 3),
			JSON.stringify([
				"opaline",
				"hooks",
				"codex",
				"turn-complete",
				"--previous-notify",
				previous[3],
			]),
		]);
		expect(parseTOML(installed).model).toBe("keep-me");
		removeHook(path);
		expect(await readNotify(path)).toEqual(previous);
	});

	test("an invalid notify setting explains the global scope, file and recovery without changing it", async () => {
		const path = configPath("invalid");
		const original = 'notify = "not an argv array"\n';
		await writeFile(path, original);
		expect(() => validateHook(path)).toThrow("all repositories");
		expect(() => installHook(path)).toThrow(path);
		expect(() => installHook(path)).toThrow("list of strings");
		expect(await readFile(path, "utf8")).toBe(original);
	});

	test("removes only Opaline's notify command", async () => {
		const installedPath = configPath("remove-installed");
		installHook(installedPath);

		removeHook(installedPath);

		expect(await readNotify(installedPath)).toBeUndefined();

		const existingPath = configPath("remove-existing");
		const original = 'notify = ["python3", "/tmp/notify.py"]\n';
		await writeFile(existingPath, original, { flag: "wx" });

		removeHook(existingPath);

		expect(await readFile(existingPath, "utf8")).toBe(original);
	});
});
