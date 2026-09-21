import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fixtureHomes: string[] = [];
const hookCommand = "opaline hooks claude session-end";
const startHookCommand = "opaline hooks claude session-start";
const otherHook = { type: "command", command: "echo keep-existing-hook" };

afterAll(async () => {
	await Promise.all(
		fixtureHomes.map((home) => rm(home, { recursive: true, force: true })),
	);
});

test("installs once in user settings and can disable from another repository", async () => {
	const home = await mkdtemp(join(tmpdir(), "opaline-global-hook-"));
	fixtureHomes.push(home);
	const first = join(home, "first-repository");
	const second = join(home, "second-repository");
	const settingsPath = join(home, ".claude", "settings.json");
	await mkdir(join(home, ".claude"));
	await mkdir(join(first, ".claude"), { recursive: true });
	await mkdir(second);
	const projectSettings = '{"permissions":{"allow":["Read"]}}\n';
	await writeFile(join(first, ".claude", "settings.json"), projectSettings);
	const original = {
		permissions: { deny: ["Read(.env)"] },
		hooks: { SessionEnd: [{ matcher: "", hooks: [otherHook] }] },
	};
	await writeFile(settingsPath, JSON.stringify(original));

	expect(await runProbe("install", home, first)).toEqual({
		path: settingsPath,
		enabled: true,
	});
	const installed = await readFile(settingsPath, "utf8");
	expect(JSON.parse(installed)).toEqual({
		...original,
		hooks: {
			SessionStart: [
				{
					matcher: "",
					hooks: [{ type: "command", command: startHookCommand, async: true }],
				},
			],
			SessionEnd: [
				{ matcher: "", hooks: [otherHook] },
				{
					matcher: "",
					hooks: [{ type: "command", command: hookCommand, async: true }],
				},
			],
		},
	});
	expect(await runProbe("install", home, second)).toEqual({
		path: settingsPath,
		enabled: true,
	});
	expect(await readFile(settingsPath, "utf8")).toBe(installed);
	expect(await readFile(join(first, ".claude", "settings.json"), "utf8")).toBe(
		projectSettings,
	);
	expect(await runProbe("remove", home, second)).toEqual({
		path: settingsPath,
		enabled: false,
	});
	expect(JSON.parse(await readFile(settingsPath, "utf8"))).toEqual(original);
});

test("upgrades a legacy user hook and preserves neighboring hooks on removal", async () => {
	const home = await mkdtemp(join(tmpdir(), "opaline-legacy-hook-"));
	fixtureHomes.push(home);
	await mkdir(join(home, ".claude"));
	const settingsPath = join(home, ".claude", "settings.json");
	await writeFile(
		settingsPath,
		JSON.stringify({
			hooks: {
				SessionEnd: [
					{
						matcher: "",
						hooks: [
							otherHook,
							{ type: "command", command: "rudel hooks claude session-end" },
						],
					},
				],
			},
		}),
	);
	await runProbe("install", home, home);
	expect(JSON.parse(await readFile(settingsPath, "utf8"))).toEqual({
		hooks: {
			SessionStart: [
				{
					matcher: "",
					hooks: [{ type: "command", command: startHookCommand, async: true }],
				},
			],
			SessionEnd: [
				{
					matcher: "",
					hooks: [otherHook, { type: "command", command: hookCommand }],
				},
			],
		},
	});
	await runProbe("remove", home, home);
	expect(JSON.parse(await readFile(settingsPath, "utf8"))).toEqual({
		hooks: { SessionEnd: [{ matcher: "", hooks: [otherHook] }] },
	});
});

async function runProbe(
	action: string,
	home: string,
	cwd: string,
): Promise<unknown> {
	const child = Bun.spawn(
		[
			process.execPath,
			join(import.meta.dir, "helpers/claude-hook-settings-probe.ts"),
			action,
		],
		{
			cwd,
			env: { ...process.env, HOME: home, USERPROFILE: home },
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	expect(exitCode).toBe(0);
	expect(stderr).toBe("");
	return JSON.parse(stdout);
}
