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
					hooks: [
						{
							type: "command",
							command: hookCommand,
							async: true,
							timeout: 60,
						},
					],
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
					hooks: [
						otherHook,
						{
							type: "command",
							command: hookCommand,
							async: true,
							timeout: 60,
						},
					],
				},
			],
		},
	});
	await runProbe("remove", home, home);
	expect(JSON.parse(await readFile(settingsPath, "utf8"))).toEqual({
		hooks: { SessionEnd: [{ matcher: "", hooks: [otherHook] }] },
	});
});

test.each(["opaline", "rudel"])(
	"heals a %s SessionEnd-only install once without touching neighboring hooks or its command",
	async (command) => {
		const home = await mkdtemp(join(tmpdir(), "opaline-heal-hook-"));
		fixtureHomes.push(home);
		const settingsPath = join(home, ".claude", "settings.json");
		await mkdir(join(home, ".claude"));
		const endHooks = [
			{
				matcher: "",
				hooks: [
					otherHook,
					{ type: "command", command: `${command} hooks claude session-end` },
				],
			},
		];
		await writeFile(
			settingsPath,
			JSON.stringify({ hooks: { SessionEnd: endHooks } }),
		);
		expect(await runProbe("status", home, home)).toEqual({
			path: settingsPath,
			enabled: true,
		});
		expect(await runProbe("heal", home, home)).toEqual({
			path: settingsPath,
			enabled: true,
			healed: true,
		});
		const healed = await readFile(settingsPath, "utf8");
		expect(JSON.parse(healed)).toEqual({
			hooks: {
				SessionEnd: [
					{
						matcher: "",
						hooks: [
							otherHook,
							{
								type: "command",
								command: `${command} hooks claude session-end`,
								timeout: 60,
							},
						],
					},
				],
				SessionStart: [
					{
						matcher: "",
						hooks: [
							{ type: "command", command: startHookCommand, async: true },
						],
					},
				],
			},
		});
		expect(await runProbe("heal", home, home)).toEqual({
			path: settingsPath,
			enabled: true,
			healed: false,
		});
		expect(await readFile(settingsPath, "utf8")).toBe(healed);
	},
);

test("repairs a synchronous SessionStart hook without enabling opted-out installs", async () => {
	const home = await mkdtemp(join(tmpdir(), "opaline-async-hook-"));
	fixtureHomes.push(home);
	const settingsPath = join(home, ".claude", "settings.json");
	await mkdir(join(home, ".claude"));
	const start = {
		hooks: {
			SessionStart: [
				{
					matcher: "",
					hooks: [{ type: "command", command: startHookCommand }],
				},
			],
		},
	};
	await writeFile(settingsPath, JSON.stringify(start));
	expect(await runProbe("heal", home, home)).toEqual({
		path: settingsPath,
		enabled: false,
		healed: false,
	});
	expect(await readFile(settingsPath, "utf8")).toBe(JSON.stringify(start));
	await writeFile(
		settingsPath,
		JSON.stringify({
			hooks: {
				...start.hooks,
				SessionEnd: [
					{ matcher: "", hooks: [{ type: "command", command: hookCommand }] },
				],
			},
		}),
	);
	expect(await runProbe("heal", home, home)).toEqual({
		path: settingsPath,
		enabled: true,
		healed: true,
	});
	expect(
		JSON.parse(await readFile(settingsPath, "utf8")).hooks.SessionStart,
	).toEqual([
		{
			matcher: "",
			hooks: [{ type: "command", command: startHookCommand, async: true }],
		},
	]);
});

test("adds the SessionEnd timeout to a 0.11 install once, keeping its command and neighbours", async () => {
	const home = await mkdtemp(join(tmpdir(), "opaline-timeout-hook-"));
	fixtureHomes.push(home);
	const settingsPath = join(home, ".claude", "settings.json");
	await mkdir(join(home, ".claude"));
	const startHooks = [
		{
			matcher: "",
			hooks: [{ type: "command", command: startHookCommand, async: true }],
		},
	];
	const legacyEnd = {
		type: "command",
		command: "rudel hooks claude session-end",
		async: true,
	};
	await writeFile(
		settingsPath,
		JSON.stringify({
			permissions: { allow: ["Read"] },
			hooks: {
				SessionStart: startHooks,
				SessionEnd: [
					{ matcher: "", hooks: [otherHook] },
					{ matcher: "", hooks: [legacyEnd] },
				],
				Stop: [{ matcher: "", hooks: [otherHook] }],
			},
		}),
	);

	expect(await runProbe("heal", home, home)).toEqual({
		path: settingsPath,
		enabled: true,
		healed: true,
	});
	const healed = await readFile(settingsPath, "utf8");
	expect(JSON.parse(healed)).toEqual({
		permissions: { allow: ["Read"] },
		hooks: {
			SessionStart: startHooks,
			SessionEnd: [
				{ matcher: "", hooks: [otherHook] },
				{ matcher: "", hooks: [{ ...legacyEnd, timeout: 60 }] },
			],
			Stop: [{ matcher: "", hooks: [otherHook] }],
		},
	});
	expect(await runProbe("heal", home, home)).toEqual({
		path: settingsPath,
		enabled: true,
		healed: false,
	});
	expect(await readFile(settingsPath, "utf8")).toBe(healed);
});

test("replaces a different timeout on Opaline's SessionEnd hook on install", async () => {
	const home = await mkdtemp(join(tmpdir(), "opaline-timeout-install-"));
	fixtureHomes.push(home);
	const settingsPath = join(home, ".claude", "settings.json");
	await mkdir(join(home, ".claude"));
	await writeFile(
		settingsPath,
		JSON.stringify({
			hooks: {
				SessionEnd: [
					{
						matcher: "",
						hooks: [
							{ ...otherHook, timeout: 5 },
							{ type: "command", command: hookCommand, timeout: 2 },
						],
					},
				],
			},
		}),
	);

	await runProbe("install", home, home);

	expect(
		JSON.parse(await readFile(settingsPath, "utf8")).hooks.SessionEnd,
	).toEqual([
		{
			matcher: "",
			hooks: [
				{ ...otherHook, timeout: 5 },
				{ type: "command", command: hookCommand, async: true, timeout: 60 },
			],
		},
	]);
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
