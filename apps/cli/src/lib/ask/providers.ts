import { exec } from "../exec.js";

export interface ProviderState {
	readonly kind: "claude";
	readonly version?: string;
	readonly ready: boolean;
}

type RunCommand = typeof exec;

export async function detectClaude(
	run: RunCommand = exec,
): Promise<ProviderState> {
	const versionResult = await run("claude", ["--version"]);
	const version = versionResult.stdout.match(/\d+\.\d+\.\d+\S*/u)?.[0];
	if (versionResult.exitCode !== 0 || !version)
		return { kind: "claude", ready: false };
	return { kind: "claude", version, ready: await isLoggedIn(run) };
}

async function isLoggedIn(run: RunCommand): Promise<boolean> {
	const status = await run("claude", ["auth", "status", "--json"]);
	try {
		const parsed: unknown = JSON.parse(status.stdout);
		return (
			typeof parsed === "object" &&
			parsed !== null &&
			"loggedIn" in parsed &&
			parsed.loggedIn === true
		);
	} catch {
		return status.exitCode === 0;
	}
}
