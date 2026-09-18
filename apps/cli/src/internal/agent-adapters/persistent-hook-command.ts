import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	compareCliVersions,
	readCliBundleVersion,
} from "../../lib/cli-release.js";
import { getConfigDir } from "../../lib/local-state.js";
import { getCliCommand } from "./cli-command.js";

export function getPersistentHookCommand(args: readonly string[]): string[] {
	const currentFile = fileURLToPath(import.meta.url);
	// Development TypeScript runs keep the ordinary command. Published bundles
	// are self-contained Node files and can be retained outside the runner cache.
	if (extname(currentFile) !== ".js") return [getCliCommand(), ...args];
	const source = join(dirname(currentFile), "cli.js");
	if (!existsSync(source))
		throw new Error("Could not find the CLI bundle for automatic uploads.");
	const target = getPersistentCliPath();
	writePersistentCli(source, target);
	return [process.execPath, target, ...args];
}

// Callers reconciling existing installations hold the configuration lock. Keep
// the historical path so released hook installers still recognize ownership.
export function writePersistentCli(
	source: string,
	target = getPersistentCliPath(),
): void {
	if (source !== target) {
		const content = readFileSync(source, "utf8");
		const candidate = readCliBundleVersion(content);
		if (!candidate)
			throw new Error(
				"Could not verify the candidate Opaline runtime version.",
			);
		if (existsSync(target)) {
			const installedContent = readFileSync(target, "utf8");
			const installed = readCliBundleVersion(installedContent);
			if (!installed)
				throw new Error(
					"Could not verify the existing automatic-upload runtime. It was left unchanged.",
				);
			if (
				compareCliVersions(installed, candidate) > 0 ||
				installedContent === content
			)
				return;
		}
		mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
		writeFileSync(
			join(dirname(target), "package.json"),
			'{"type":"module"}\n',
			{ mode: 0o600 },
		);
		const temporary = `${target}.${randomUUID()}.tmp`;
		try {
			writeFileSync(temporary, content, { mode: 0o600, flag: "wx" });
			renameSync(temporary, target);
		} finally {
			rmSync(temporary, { force: true });
		}
	}
}

export function isPersistentHookCommand(
	command: readonly string[],
	args: readonly string[],
): boolean {
	return (
		command.length === args.length + 2 &&
		command[1] === getPersistentCliPath() &&
		args.every((arg, index) => command[index + 2] === arg)
	);
}

export function getPersistentCliPath(): string {
	return join(getConfigDir(), "runtime", "cli.js");
}

export function quoteHookArgument(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}
