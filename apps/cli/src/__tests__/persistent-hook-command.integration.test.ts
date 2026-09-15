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
							{ type: "command", command: "rudel hooks claude session-end" },
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
	expect(
		(await run([node, durablePath, "--version"], env)).stdout.trim(),
	).toMatch(/^\d+\.\d+\.\d+$/u);
	const claude = commands.find((command) => command !== "echo keep-me");
	assert(claude);
	// Execute the exact shell command, including spaces and an apostrophe in HOME.
	await run(["sh", "-c", claude], env, "{}");
	const notify = z.array(z.string()).parse(config.notify);
	await run([...notify, '{"type":"unrelated-event"}'], env);
}, 30_000);

test("the published Codex hook preserves notifications when OFF and isolates notifier failures", async () => {
	const home = await mkdtemp(join(tmpdir(), "opaline notify's home "));
	directories.push(home);
	const cache = join(home, "runner cache");
	await mkdir(cache);
	await mkdir(join(home, ".codex"));
	const foundNode = Bun.which("node");
	assert(foundNode);
	const node = await realpath(foundNode);
	const record = join(home, "notifications.jsonl");
	const notifier = join(home, "custom notifier.mjs");
	const notifierSource = `import { appendFileSync } from 'node:fs';
const [record, ...args] = process.argv.slice(2);
appendFileSync(record, JSON.stringify(args) + '\\n');`;
	await writeFile(notifier, notifierSource);
	const previous = [
		node,
		notifier,
		record,
		"argument with ' quotes",
		"$(literal)",
	];
	const configPath = join(home, ".codex", "config.toml");
	await writeFile(
		configPath,
		`model = "keep-me"\nnotify = ${JSON.stringify(previous)}\n`,
	);
	const installer = join(cache, "installer.ts");
	await writeFile(
		installer,
		`import { installHook } from ${JSON.stringify(resolve(import.meta.dir, "../internal/agent-adapters/adapters/codex/config.ts"))}; installHook();`,
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
	await run([node, join(cache, "installer.js")], env);
	const installed = await readFile(configPath, "utf8");
	await run([node, join(cache, "installer.js")], env);
	expect(await readFile(configPath, "utf8")).toBe(installed);
	const notify = z.array(z.string()).parse(parse(installed).notify);
	await rm(cache, { recursive: true, force: true });
	const payload = JSON.stringify({
		type: "agent-turn-complete",
		"thread-id": "notification-fixture",
		cwd: home,
		"last-assistant-message": "Unicode café 🌈 and ' quotes",
	});
	const allowlist = join(home, ".rudel", "auto-upload.json");
	await writeFile(allowlist, JSON.stringify({ version: 1, repositories: {} }));
	const off = await run([...notify, payload], env);
	expect(off.stderr).toBe("");
	expect(
		(await readFile(record, "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line)),
	).toEqual([[...previous.slice(3), payload]]);
	await rm(allowlist);
	await writeFile(notifier, `${notifierSource}\nprocess.exitCode = 7;`);
	const failed = await run([...notify, payload], env);
	expect(failed.stderr).toContain("previous Codex notification command failed");
	// The upload handler still runs independently and reports its own auth state.
	expect(failed.stderr).toContain("not authenticated");
	expect((await readFile(record, "utf8")).trim().split("\n")).toHaveLength(2);
	const missing = [...notify];
	missing[missing.length - 1] = JSON.stringify([join(home, "does not exist")]);
	const unavailable = await run([...missing, payload], env);
	expect(unavailable.stderr).toContain(
		"could not run your previous Codex notification command",
	);
	expect(unavailable.stderr).toContain("not authenticated");
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
	return { stdout, stderr };
}
