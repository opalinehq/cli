import { exec } from "../exec.js";

export type AgentKind = "claude" | "codex";

export interface ProviderState {
	readonly kind: AgentKind;
	readonly version?: string;
	readonly ready: boolean;
}

type RunCommand = typeof exec;

const VERSION_PATTERN = /\d+\.\d+\.\d+\S*/u;

export const AGENT_NAMES: Record<AgentKind, string> = {
	claude: "Claude Code",
	codex: "Codex",
};

export async function detectProviders(
	run: RunCommand = exec,
): Promise<ProviderState[]> {
	const providers = await Promise.all([detectClaude(run), detectCodex(run)]);
	return providers.filter((provider) => provider.version !== undefined);
}

export async function detectClaude(
	run: RunCommand = exec,
): Promise<ProviderState> {
	const version = await installedVersion(run, "claude");
	if (!version) return { kind: "claude", ready: false };
	return { kind: "claude", version, ready: await isClaudeLoggedIn(run) };
}

export async function detectCodex(
	run: RunCommand = exec,
): Promise<ProviderState> {
	const version = await installedVersion(run, "codex");
	if (!version) return { kind: "codex", ready: false };
	return { kind: "codex", version, ready: await isCodexLoggedIn(run) };
}

async function installedVersion(
	run: RunCommand,
	command: string,
): Promise<string | undefined> {
	const result = await run(command, ["--version"]);
	if (result.exitCode !== 0) return undefined;
	return result.stdout.match(VERSION_PATTERN)?.[0];
}

async function isClaudeLoggedIn(run: RunCommand): Promise<boolean> {
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

async function isCodexLoggedIn(run: RunCommand): Promise<boolean> {
	const status = await run("codex", ["login", "status"]);
	const output = `${status.stdout}\n${status.stderr}`;
	return status.exitCode === 0 && !/not logged in/iu.test(output);
}
