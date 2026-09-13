import { afterAll, expect, test } from "bun:test";
import assert from "node:assert/strict";
import {
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "smol-toml";
import { z } from "zod";

const directories: string[] = [];
afterAll(async () => {
	await Promise.all(
		directories.map((path) => rm(path, { recursive: true, force: true })),
	);
});

test("published hooks survive runner-cache removal and preserve unrelated settings", async () => {
	const home = await mkdtemp(join(tmpdir(), "opaline hook's home "));
	directories.push(home);
	const cache = join(home, "runner cache");
	await mkdir(cache);
	await mkdir(join(home, ".claude"));
	await mkdir(join(home, ".codex"));
	const settingsPath = join(home, ".claude", "settings.json");
	const codexPath = join(home, ".codex", "config.toml");
	await writeFile(
		settingsPath,
		JSON.stringify({
			hooks: {
				SessionEnd: [
					{
						matcher: "",
						hooks: [
							{ type: "command", command: "echo keep-me" },
							{ type: "command", command: "opaline hooks claude session-end" },
						],
					},
				],
			},
		}),
	);
	await writeFile(
		codexPath,
		'model = "gpt-5"\nnotify = ["rudel", "hooks", "codex", "turn-complete"]\n',
	);
	const installer = join(cache, "installer.ts");
	await writeFile(
		installer,
		`import { addHook } from ${JSON.stringify(resolve(import.meta.dir, "../internal/agent-adapters/adapters/claude-code/settings.ts"))};
import { installHook } from ${JSON.stringify(resolve(import.meta.dir, "../internal/agent-adapters/adapters/codex/config.ts"))};
addHook(); installHook();`,
	);
	for (const entry of [resolve(import.meta.dir, "../bin/cli.ts"), installer]) {
		await run(
			[
				process.execPath,
				"build",
				entry,
				"--outdir",
				cache,
				"--target=node",
				"--define=OPALINE_BUNDLED_ANALYTICS=null",
			],
			process.env,
		);
	}
	await writeFile(join(cache, "package.json"), '{"type":"module"}');
	const env = {
		...process.env,
		HOME: home,
		USERPROFILE: home,
		OPALINE_CONFIG_DIR: join(home, ".rudel"),
		POSTHOG_ENABLED: "false",
	};
	const foundNode = Bun.which("node");
	assert(foundNode);
	const node = await realpath(foundNode);
	await run([node, join(cache, "installer.js")], env);
	const first = await readFile(settingsPath, "utf8");
	await run([node, join(cache, "installer.js")], env);
	expect(await readFile(settingsPath, "utf8")).toBe(first);
	const settings = z
		.object({
			hooks: z.object({
				SessionEnd: z.array(
					z.object({ hooks: z.array(z.object({ command: z.string() })) }),
				),
			}),
		})
		.parse(JSON.parse(first));
	const commands = settings.hooks.SessionEnd.flatMap((entry) =>
		entry.hooks.map((hook) => hook.command),
	);
	expect(commands).toHaveLength(2);
	expect(commands).toContain("echo keep-me");
	const durablePath = join(home, ".rudel", "runtime", "cli.js");
	const config = parse(await readFile(codexPath, "utf8"));
	expect(config.model).toBe("gpt-5");
	expect(config.notify).toEqual([
		node,
		durablePath,
		"hooks",
		"codex",
		"turn-complete",
	]);
	await rm(cache, { recursive: true, force: true });
	expect((await run([node, durablePath, "--version"], env)).trim()).toMatch(
		/^\d+\.\d+\.\d+$/u,
	);
	const claude = commands.find((command) => command !== "echo keep-me");
	assert(claude);
	// Execute the exact shell command, including spaces and an apostrophe in HOME.
	await run(["sh", "-c", claude], env, "{}");
	const notify = z.array(z.string()).parse(config.notify);
	await run([...notify, '{"type":"unrelated-event"}'], env);
}, 30_000);

async function run(command: string[], env: NodeJS.ProcessEnv, stdin = "") {
	const child = Bun.spawn(command, {
		env,
		stdin: new Response(stdin),
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	expect(code, stderr).toBe(0);
	return stdout;
}
