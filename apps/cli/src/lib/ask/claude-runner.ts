import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	type AgentJob,
	ASK_INSTRUCTIONS,
	type RunAgent,
	runAgentProcess,
	withJobDirectory,
} from "./agent-process.js";
import {
	createClaudeStreamParser,
	describeClaudeFailure,
} from "./claude-stream.js";

export const CLAUDE_NOT_INSTALLED_ERROR = "Claude Code is not installed";

export const runClaude: RunAgent = (job, options) =>
	withJobDirectory(async (directory) => {
		const mcpConfigPath = join(directory.root, "mcp.json");
		await writeFile(mcpConfigPath, mcpConfig(job), { mode: 0o600 });
		return runAgentProcess(
			{
				command: "claude",
				args: claudeArguments(job, mcpConfigPath),
				prompt: job.prompt,
				workingDirectory: directory.workingDirectory,
				parser: createClaudeStreamParser(),
				describeFailure: describeClaudeFailure,
				notInstalledError: CLAUDE_NOT_INSTALLED_ERROR,
				displayName: "Claude Code",
			},
			options,
		);
	});

export function claudeArguments(
	job: AgentJob,
	mcpConfigPath: string,
): string[] {
	return [
		"-p",
		"--output-format",
		"stream-json",
		"--verbose",
		"--mcp-config",
		mcpConfigPath,
		"--strict-mcp-config",
		"--allowedTools",
		"mcp__opaline",
		"--tools",
		"",
		"--permission-mode",
		"dontAsk",
		"--permission-prompts",
		"none",
		"--disable-slash-commands",
		"--settings",
		JSON.stringify({ disableAllHooks: true }),
		"--append-system-prompt",
		ASK_INSTRUCTIONS,
		...(job.resumeSessionId ? ["--resume", job.resumeSessionId] : []),
	];
}

function mcpConfig(job: AgentJob): string {
	return JSON.stringify({
		mcpServers: {
			opaline: {
				type: "http",
				url: job.mcpUrl,
				headers: { Authorization: `Bearer ${job.mcpToken}` },
			},
		},
	});
}
