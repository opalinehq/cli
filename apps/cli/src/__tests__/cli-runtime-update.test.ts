import { afterAll, expect, test } from "bun:test";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { claudeCodeAdapter } from "../internal/agent-adapters/index.js";
import { writePersistentCli } from "../internal/agent-adapters/persistent-hook-command.js";
import { refreshInstalledCliRuntime } from "../lib/cli-update.js";

const roots: string[] = [];
afterAll(async () => {
	await Promise.all(
		roots.map((root) => rm(root, { recursive: true, force: true })),
	);
});

test("reconciles an existing runtime without repository changes or enabling another profile", async () => {
	const root = await fixture();
	const source = join(root, "candidate.js");
	const config = join(root, "profile");
	const target = join(config, "runtime", "cli.js");
	await mkdir(dirname(target), { recursive: true });
	await writeFile(source, bundle("0.9.0"));
	await writeFile(target, bundle("0.8.1"));
	const allowlist =
		'{"version":1,"repositories":{"private":{"label":"private","sources":[]}}}';
	await writeFile(join(config, "auto-upload.json"), allowlist);
	await refreshInstalledCliRuntime(source, [], { configDir: config });
	expect(await readFile(target, "utf8")).toBe(bundle("0.9.0"));
	expect(await readFile(join(config, "auto-upload.json"), "utf8")).toBe(
		allowlist,
	);
	expect((await readdir(config)).sort()).toEqual([
		"auto-upload.json",
		"runtime",
	]);
	await refreshInstalledCliRuntime(source, [], { configDir: config });
	expect(await readFile(target, "utf8")).toBe(bundle("0.9.0"));
});

test("does not install automatic uploads when no runtime or owned hooks exist", async () => {
	const root = await fixture();
	const source = join(root, "candidate.js");
	const config = join(root, "profile");
	await writeFile(source, bundle("0.9.0"));
	await refreshInstalledCliRuntime(source, [], { configDir: config });
	expect(await readdir(config)).toEqual([]);
});

test("an older release or prerelease cannot replace a newer saved runtime", async () => {
	const root = await fixture();
	const source = join(root, "candidate.js");
	const target = join(root, "runtime", "cli.js");
	await mkdir(dirname(target));
	await writeFile(target, bundle("1.0.0"));
	for (const version of ["0.9.0", "1.0.0-rc.1", "1.0.0"]) {
		await writeFile(source, bundle(version));
		writePersistentCli(source, target);
		expect(await readFile(target, "utf8")).toBe(bundle("1.0.0"));
	}
});

test("unknown runtime and invalid candidate failures leave existing bytes intact", async () => {
	const root = await fixture();
	const source = join(root, "candidate.js");
	const target = join(root, "runtime", "cli.js");
	await mkdir(dirname(target));
	await writeFile(target, "unrecognized existing runtime");
	await writeFile(source, bundle("0.9.0"));
	expect(() => writePersistentCli(source, target)).toThrow(
		"existing automatic-upload runtime",
	);
	expect(await readFile(target, "utf8")).toBe("unrecognized existing runtime");
	await writeFile(target, bundle("0.8.1"));
	await writeFile(source, "invalid candidate");
	expect(() => writePersistentCli(source, target)).toThrow("candidate");
	expect(await readFile(target, "utf8")).toBe(bundle("0.8.1"));
	expect(await readdir(dirname(target))).toEqual(["cli.js"]);
});

test("repairs changed runtime bytes even when the embedded version is current", async () => {
	const root = await fixture();
	const source = join(root, "candidate.js");
	const target = join(root, "runtime", "cli.js");
	await mkdir(dirname(target));
	await writeFile(source, bundle("0.9.0"));
	await writeFile(
		target,
		`${bundle("0.9.0")}throw new Error("broken runtime");`,
	);
	writePersistentCli(source, target);
	expect(await readFile(target, "utf8")).toBe(await readFile(source, "utf8"));
});

test("legacy custom-profile hooks fail before changing runtime or agent settings", async () => {
	const root = await fixture();
	const source = join(root, "candidate.js");
	const configDir = join(root, "custom-profile");
	const target = join(configDir, "runtime", "cli.js");
	const path = join(root, ".claude", "settings.json");
	await mkdir(dirname(target), { recursive: true });
	await mkdir(dirname(path), { recursive: true });
	await writeFile(source, bundle("0.9.0"));
	await writeFile(target, bundle("0.8.1"));
	const settings = JSON.stringify({
		hooks: {
			SessionEnd: [
				{
					hooks: [
						{ type: "command", command: "opaline hooks claude session-end" },
					],
				},
			],
		},
	});
	await writeFile(path, settings);
	await expect(
		refreshInstalledCliRuntime(
			source,
			[{ adapter: claudeCodeAdapter, options: { projectPath: root }, path }],
			{ configDir },
		),
	).rejects.toThrow("custom configuration profile");
	expect(await readFile(path, "utf8")).toBe(settings);
	expect(await readFile(target, "utf8")).toBe(bundle("0.8.1"));
});

async function fixture(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "opaline-update-"));
	roots.push(root);
	return root;
}

function bundle(version: string): string {
	return `var pkg = { name: "@opalinehq/cli", version: "${version}" };\n`;
}
