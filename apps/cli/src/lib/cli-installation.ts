import { execFile } from "node:child_process";
import { constants, existsSync } from "node:fs";
import { access, readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import {
	delimiter,
	dirname,
	isAbsolute,
	join,
	relative,
	resolve,
	sep,
} from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { compareCliVersions } from "./cli-release.js";

const execute = promisify(execFile);
const PackageSchema = z.object({ name: z.string(), version: z.string() });
const PACKAGE_NAMES = ["opaline", "@opalinehq/cli", "rudel"] as const;
type PackageName = (typeof PACKAGE_NAMES)[number];
type Manager = "npm" | "pnpm";

export interface CliInstallation {
	manager: Manager;
	managerCommand: string;
	packageName: PackageName;
	root: string;
	bin: string;
	bundle: string;
	version: string;
}

export async function findCliInstallations(): Promise<CliInstallation[]> {
	// Windows package-manager .cmd shims require a separate quoting/installation
	// implementation. Do not invoke a shell or guess an installation there.
	if (process.platform === "win32") return [];
	const managers: Manager[] = ["npm", "pnpm"];
	const results = await Promise.all(
		managers.map(async (manager) => {
			try {
				const command = await resolveCliPackageManager(manager);
				if (!command) return [];
				const [root, binDirectory] = await Promise.all([
					queryManager(command, ["root", "-g"]),
					queryManager(command, [manager === "npm" ? "prefix" : "bin", "-g"]),
				]);
				const directory = join(
					binDirectory,
					...(manager === "npm" ? ["bin"] : []),
				);
				return await Promise.all(
					["opaline", "rudel"].map((name) =>
						inspectCliInstallation(
							manager,
							root,
							join(directory, name),
							command,
						).catch(() => undefined),
					),
				);
			} catch {
				return [];
			}
		}),
	);
	const unique = new Map<string, CliInstallation>();
	for (const installation of results.flat())
		if (installation) unique.set(installation.bin, installation);
	// A runner's injected PATH entries do not count as global installations.
	const path = await Promise.all(
		(process.env.PATH ?? "")
			.split(delimiter)
			.map((entry) => realpath(resolve(entry)).catch(() => resolve(entry))),
	);
	return [...unique.values()].filter((item) =>
		path.includes(dirname(item.bin)),
	);
}

export async function inspectCliInstallation(
	manager: Manager,
	root: string,
	bin: string,
	managerCommand?: string,
): Promise<CliInstallation | undefined> {
	const command = managerCommand ?? (await resolveCliPackageManager(manager));
	if (!command) return undefined;
	const actualBin = await realpath(bin);
	const shim = await readFile(bin, "utf8");
	for (const packageName of PACKAGE_NAMES) {
		try {
			const packageRoot = join(root, packageName);
			const manifest = PackageSchema.parse(
				JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")),
			);
			if (manifest.name !== packageName) continue;
			compareCliVersions(manifest.version, manifest.version);
			const entry = join(
				packageRoot,
				packageName === "@opalinehq/cli"
					? "dist/cli.js"
					: `bin/${packageName}.js`,
			);
			const actualEntry = await realpath(entry);
			// npm uses a symlink; pnpm uses a generated shell shim. Identify its
			// exact target, not another package exposing the same binary name.
			const relativeEntry = relative(await realpath(dirname(bin)), actualEntry);
			if (
				actualBin !== actualEntry &&
				!shim.includes(`"${actualEntry}"`) &&
				!shim.includes(`"$basedir/${relativeEntry}"`)
			)
				continue;
			const bundle =
				packageName === "@opalinehq/cli"
					? entry
					: join(
							dirname(createRequire(actualEntry).resolve("@opalinehq/cli/run")),
							"cli.js",
						);
			const implementation = PackageSchema.parse(
				JSON.parse(
					await readFile(join(dirname(bundle), "../package.json"), "utf8"),
				),
			);
			if (
				implementation.name !== "@opalinehq/cli" ||
				implementation.version !== manifest.version
			)
				continue;
			return {
				manager,
				managerCommand: command,
				root,
				bin,
				packageName,
				bundle,
				version: manifest.version,
			};
		} catch {
			// Other install names need not exist in this prefix.
		}
	}
	return undefined;
}

export async function updateCliInstallation(
	installation: CliInstallation,
	version: string,
): Promise<CliInstallation> {
	compareCliVersions(version, version);
	if (
		(await resolveCliPackageManager(installation.manager)) !==
		installation.managerCommand
	)
		throw new Error(
			"The package-manager command changed while awaiting confirmation. Run the command again.",
		);
	const before = await inspectCliInstallation(
		installation.manager,
		installation.root,
		installation.bin,
	);
	if (
		!before ||
		before.packageName !== installation.packageName ||
		before.version !== installation.version
	)
		throw new Error(
			"The installed CLI changed while awaiting confirmation. Run the command again.",
		);
	// Resolve the manager by PATH so user-owned policy wrappers are respected.
	// Pin the reviewed release. Never retry a denied exact version with @latest.
	await execute(
		installation.managerCommand,
		["install", "-g", `${installation.packageName}@${version}`],
		{
			timeout: 120_000,
			maxBuffer: 1024 * 1024,
			windowsHide: true,
			cwd: homedir(),
			env: { ...process.env, npm_config_ignore_scripts: "true" },
		},
	);
	const updated = await inspectCliInstallation(
		installation.manager,
		installation.root,
		installation.bin,
	);
	if (
		!updated ||
		updated.packageName !== installation.packageName ||
		updated.version !== version
	)
		throw new Error(
			"The package manager completed, but the installed Opaline version could not be verified.",
		);
	const result = await execute(
		process.execPath,
		[updated.bundle, "--version"],
		{
			timeout: 5_000,
			env: { ...process.env, DO_NOT_TRACK: "1", POSTHOG_ENABLED: "false" },
		},
	);
	if (result.stdout.trim() !== version)
		throw new Error("The updated executable reported an unexpected version.");
	return updated;
}

export async function resolveCliPackageManager(
	manager: Manager,
	env: { path?: string; cwd?: string; home?: string } = {},
): Promise<string | undefined> {
	const cwd = await realpath(env.cwd ?? process.cwd());
	const home = await realpath(env.home ?? homedir());
	let project: string | undefined;
	for (
		let dir = cwd;
		dir !== home && dirname(dir) !== dir;
		dir = dirname(dir)
	) {
		if (existsSync(join(dir, "package.json"))) project = dir;
		if (existsSync(join(dir, ".git"))) {
			project = dir;
			break;
		}
	}
	project ??= cwd !== home && dirname(cwd) !== cwd ? cwd : undefined;
	for (const directory of (env.path ?? process.env.PATH ?? "").split(
		delimiter,
	)) {
		// npm exec prepends node_modules/.bin; never execute those discovery
		// commands before consent. Preserve the user's actual wrapper path.
		if (!isAbsolute(directory) || directory.split(sep).includes("node_modules"))
			continue;
		const command = join(directory, manager);
		try {
			const actual = await realpath(command);
			if (
				project &&
				(command.startsWith(`${project}${sep}`) ||
					actual.startsWith(`${project}${sep}`))
			)
				continue;
			await access(command, constants.X_OK);
			return command;
		} catch {
			/* Package managers need not be installed. */
		}
	}
	return undefined;
}

async function queryManager(manager: string, args: string[]): Promise<string> {
	const result = await execute(manager, args, {
		timeout: 2_000,
		maxBuffer: 64 * 1024,
		cwd: homedir(),
	});
	const path = result.stdout.trim();
	if (!path.startsWith("/") || path.includes("\n"))
		throw new Error("Unrecognized global package directory.");
	return await realpath(path);
}
