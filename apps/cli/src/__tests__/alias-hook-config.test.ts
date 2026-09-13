import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parse as parseTOML } from "smol-toml";
import { getCliCommand } from "../internal/agent-adapters/cli-command.js";

const root = await mkdtemp(join(tmpdir(), "opaline-alias-hooks-"));
const settingsModule = pathToFileURL(
	join(
		import.meta.dir,
		"../internal/agent-adapters/adapters/claude-code/settings.ts",
	),
).href;
const codexModule = pathToFileURL(
	join(import.meta.dir, "../internal/agent-adapters/adapters/codex/config.ts"),
).href;

afterAll(async () => {
	await rm(root, { recursive: true, force: true });
});

test("recognizes legacy launchers on Unix and Windows", () => {
	expect(getCliCommand("/usr/local/bin/rudel")).toBe("rudel");
	expect(getCliCommand("/prefix/node_modules/rudel/bin/rudel.js")).toBe(
		"rudel",
	);
	expect(getCliCommand("C:\\npm\\node_modules\\rudel\\bin\\rudel.js")).toBe(
		"rudel",
	);
	expect(getCliCommand("/prefix/node_modules/opaline/bin/opaline.js")).toBe(
		"opaline",
	);
	expect(getCliCommand("/prefix/node_modules/@opalinehq/cli/dist/cli.js")).toBe(
		"opaline",
	);
	expect(getCliCommand("/projects/rudel/cli.js")).toBe("opaline");
});

for (const command of ["opaline", "rudel"]) {
	for (const migrate of [false, true]) {
		test(`${command} ${migrate ? "migrates" : "installs"} hooks using its own executable`, async () => {
			const homeDirectory = join(root, `${command}-${migrate}`);
			const claudeDirectory = join(homeDirectory, ".claude");
			const codexDirectory = join(homeDirectory, ".codex");
			await mkdir(claudeDirectory, { recursive: true });
			await mkdir(codexDirectory, { recursive: true });
			const previousCommand = command === "opaline" ? "rudel" : "opaline";
			const claudePath = join(claudeDirectory, "settings.json");
			const codexPath = join(codexDirectory, "config.toml");
			await writeFile(
				claudePath,
				JSON.stringify({
					permissions: { allow: ["Read"] },
					hooks: {
						SessionEnd: [
							{
								matcher: "",
								hooks: [{ type: "command", command: "echo keep" }],
							},
							...(migrate
								? [
										{
											matcher: "",
											hooks: [
												{
													type: "command",
													command: `${previousCommand} hooks claude session-end`,
													async: true,
												},
											],
										},
									]
								: []),
						],
					},
				}),
			);
			await writeFile(
				codexPath,
				`model = "test-model"\n${migrate ? `notify = ["${previousCommand}", "hooks", "codex", "turn-complete"]\n` : ""}`,
			);

			const launcher = join(homeDirectory, `${command}.js`);
			await writeFile(
				launcher,
				`import { addHook } from ${JSON.stringify(settingsModule)};\nimport { installHook } from ${JSON.stringify(codexModule)};\naddHook();\ninstallHook();\naddHook();\ninstallHook();\n`,
			);
			const processResult = Bun.spawn([process.execPath, launcher], {
				env: {
					...process.env,
					HOME: homeDirectory,
					USERPROFILE: homeDirectory,
				},
				stdout: "pipe",
				stderr: "pipe",
			});
			const [exitCode, stdout, stderr] = await Promise.all([
				processResult.exited,
				new Response(processResult.stdout).text(),
				new Response(processResult.stderr).text(),
			]);
			expect({ exitCode, stdout, stderr }).toEqual({
				exitCode: 0,
				stdout: "",
				stderr: "",
			});
			expect(JSON.parse(await readFile(claudePath, "utf8"))).toEqual({
				permissions: { allow: ["Read"] },
				hooks: {
					SessionEnd: [
						{ matcher: "", hooks: [{ type: "command", command: "echo keep" }] },
						{
							matcher: "",
							hooks: [
								{
									type: "command",
									command: `${command} hooks claude session-end`,
									async: true,
								},
							],
						},
					],
				},
			});
			expect(parseTOML(await readFile(codexPath, "utf8"))).toEqual({
				model: "test-model",
				notify: [command, "hooks", "codex", "turn-complete"],
			});
		});
	}
}
