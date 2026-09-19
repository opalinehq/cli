import { afterAll, expect, test } from "bun:test";
import assert from "node:assert/strict";
import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import {
	inspectCliInstallation,
	resolveCliPackageManager,
} from "../lib/cli-installation.js";

test("discovery ignores repository and runner-injected package-manager executables", async () => {
	const home = await fixture();
	const project = join(home, "project");
	const runner = join(home, "cache", "node_modules", ".bin");
	const trusted = join(home, ".local", "bin");
	for (const dir of [join(project, "bin"), runner, trusted]) {
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, "pnpm"), "#!/bin/sh\nexit 1\n", { mode: 0o700 });
	}
	await writeFile(join(project, "package.json"), "{}");
	expect(
		await resolveCliPackageManager("pnpm", {
			cwd: project,
			home,
			path: [join(project, "bin"), runner, trusted].join(":"),
		}),
	).toBe(join(trusted, "pnpm"));
	expect(
		await resolveCliPackageManager("pnpm", {
			cwd: project,
			home,
			path: [join(project, "bin"), runner].join(":"),
		}),
	).toBeUndefined();
});

const roots: string[] = [];
afterAll(async () => {
	await Promise.all(
		roots.map((path) => rm(path, { recursive: true, force: true })),
	);
});

test("identifies an npm global executable through its actual symlink", async () => {
	const home = await fixture();
	const root = join(home, "lib", "node_modules");
	const pkg = await implementation(root, "0.9.0");
	const bin = join(home, "bin", "opaline");
	await mkdir(dirname(bin), { recursive: true });
	await symlink(join(pkg, "dist", "cli.js"), bin);
	const manager = await packageManager(home, "npm");
	const installed = await inspectCliInstallation("npm", root, bin, manager);
	expect(installed?.version).toBe("0.9.0");
	expect(installed?.packageName).toBe("@opalinehq/cli");
});

test("pnpm alias resolves its own implementation, not a dormant global package sharing the name", async () => {
	const { root, bin, bundle, manager } = await pnpmFixture();
	const installed = await inspectCliInstallation("pnpm", root, bin, manager);
	expect(installed?.version).toBe("0.6.0");
	expect(installed?.packageName).toBe("opaline");
	expect(installed?.bundle).toBe(await realpath(bundle));
	await writeFile(bin, "#!/bin/sh\necho unrelated\n");
	expect(
		await inspectCliInstallation("pnpm", root, bin, manager),
	).toBeUndefined();
});

test("a policy denial never retries with latest or bypasses the package-manager command on PATH", async () => {
	const { home, root, bin } = await pnpmFixture();
	const commands = join(home, "commands");
	const recorded = join(home, "arguments.json");
	await mkdir(commands);
	const manager = join(commands, "pnpm");
	await writeFile(
		manager,
		`#!${process.execPath}\nimport {writeFileSync} from "node:fs"; writeFileSync(${JSON.stringify(recorded)}, JSON.stringify(process.argv.slice(2))); process.exit(37);\n`,
	);
	await chmod(manager, 0o700);
	const helper = join(home, "attempt.ts");
	const module = join(import.meta.dir, "../lib/cli-installation.ts");
	await writeFile(
		helper,
		`import {inspectCliInstallation, updateCliInstallation} from ${JSON.stringify(module)};
const installed = await inspectCliInstallation("pnpm", ${JSON.stringify(root)}, ${JSON.stringify(bin)});
if (!installed) throw new Error("fixture installation missing");
await updateCliInstallation(installed, "0.9.0");`,
	);
	const child = Bun.spawn([process.execPath, helper], {
		env: { ...process.env, PATH: commands, HOME: home },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	expect(exitCode).not.toBe(0);
	expect(stdout).toBe("");
	expect(stderr).toContain("37");
	expect(JSON.parse(await readFile(recorded, "utf8"))).toEqual([
		"install",
		"-g",
		"opaline@0.9.0",
	]);
	expect(
		(await inspectCliInstallation("pnpm", root, bin, manager))?.version,
	).toBe("0.6.0");
});

async function pnpmFixture() {
	const home = await fixture();
	const root = join(home, "global", "node_modules");
	await implementation(root, "0.5.3");
	const store = join(home, "global", ".pnpm", "opaline@0.6.0", "node_modules");
	const pkg = await implementation(store, "0.6.0");
	const alias = join(store, "opaline");
	await mkdir(join(alias, "bin"), { recursive: true });
	await writeFile(
		join(alias, "package.json"),
		JSON.stringify({ name: "opaline", version: "0.6.0", type: "module" }),
	);
	const entry = join(alias, "bin", "opaline.js");
	await writeFile(
		entry,
		'import { runCli } from "@opalinehq/cli/run"; await runCli();',
	);
	await symlink(alias, join(root, "opaline"));
	const bin = join(home, "opaline");
	await writeFile(
		bin,
		`#!/bin/sh\nexec node "$basedir/${relative(home, entry)}" "$@"\n`,
	);
	const manager = await packageManager(home, "pnpm");
	return { home, root, bin, bundle: join(pkg, "dist", "cli.js"), manager };
}

async function packageManager(home: string, name: "npm" | "pnpm") {
	const command = join(home, name);
	await writeFile(command, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
	return command;
}

async function implementation(root: string, version: string) {
	const pkg = join(root, "@opalinehq", "cli");
	await mkdir(join(pkg, "dist"), { recursive: true });
	await writeFile(
		join(pkg, "package.json"),
		JSON.stringify({
			name: "@opalinehq/cli",
			version,
			type: "module",
			exports: { "./run": "./dist/run-cli.js" },
		}),
	);
	await writeFile(
		join(pkg, "dist", "cli.js"),
		`console.log(${JSON.stringify(version)});`,
	);
	await writeFile(
		join(pkg, "dist", "run-cli.js"),
		"export function runCli() {}\n",
	);
	return pkg;
}

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "opaline-installation-"));
	assert(root);
	roots.push(root);
	return root;
}
