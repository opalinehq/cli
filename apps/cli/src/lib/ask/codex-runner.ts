import {
	type AgentJob,
	ASK_INSTRUCTIONS,
	type RunAgent,
	runAgentProcess,
	withJobDirectory,
} from "./agent-process.js";
import {
	createCodexStreamParser,
	describeCodexFailure,
} from "./codex-stream.js";

export const CODEX_NOT_INSTALLED_ERROR = "Codex is not installed";
export const CODEX_MCP_TOKEN_ENV = "OPALINE_ASK_MCP_TOKEN";

const DISABLED_FEATURES = [
	"shell_tool",
	"goals",
	"sleep_tool",
	"unified_exec",
	"apps",
	"plugins",
	"browser_use",
	"computer_use",
	"image_generation",
	"multi_agent",
	"hooks",
	"view_image",
	"tool_suggest",
];

export const runCodex: RunAgent = (job, options) =>
	withJobDirectory((directory) =>
		runAgentProcess(
			{
				command: "codex",
				args: codexArguments(job),
				env: { [CODEX_MCP_TOKEN_ENV]: job.mcpToken },
				prompt: job.prompt,
				workingDirectory: directory.workingDirectory,
				parser: createCodexStreamParser(),
				describeFailure: describeCodexFailure,
				notInstalledError: CODEX_NOT_INSTALLED_ERROR,
				displayName: "Codex",
			},
			options,
		),
	);

export function codexArguments(job: AgentJob): string[] {
	return [
		"exec",
		...(job.resumeSessionId ? ["resume"] : []),
		"--json",
		"--ignore-user-config",
		"--ignore-rules",
		"--skip-git-repo-check",
		...config("sandbox_mode", "read-only"),
		...config("approval_policy", "never"),
		...config("web_search", "disabled"),
		...config("developer_instructions", ASK_INSTRUCTIONS),
		...config("mcp_servers.opaline.url", job.mcpUrl),
		...config("mcp_servers.opaline.bearer_token_env_var", CODEX_MCP_TOKEN_ENV),
		...config("mcp_servers.opaline.default_tools_approval_mode", "approve"),
		...DISABLED_FEATURES.flatMap((feature) => ["--disable", feature]),
		...(job.resumeSessionId ? [job.resumeSessionId] : []),
		"-",
	];
}

function config(key: string, value: string): string[] {
	return ["-c", `${key}=${JSON.stringify(value)}`];
}
