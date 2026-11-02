import { hostname } from "node:os";
import { exec } from "../exec.js";

export async function deviceName(
	platform: NodeJS.Platform = process.platform,
	run: typeof exec = exec,
): Promise<string> {
	if (platform !== "darwin") return hostname();
	const result = await run("scutil", ["--get", "ComputerName"]);
	const name = result.stdout.trim();
	return result.exitCode === 0 && name ? name : hostname();
}
