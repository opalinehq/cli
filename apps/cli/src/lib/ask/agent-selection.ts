import type { RunAgent } from "./agent-process.js";
import type { AskProvider } from "./answer-message.js";
import { AGENT_NAMES, type ProviderState } from "./providers.js";

const LOGIN_HINTS: Record<AskProvider, string> = {
	claude: "run `claude` once",
	codex: "run `codex login`",
};

export function agentFor(
	provider: AskProvider,
	providers: readonly ProviderState[],
	runners: Readonly<Record<AskProvider, RunAgent>>,
): { readonly run: RunAgent } | { readonly error: string } {
	const state = providers.find((candidate) => candidate.kind === provider);
	const name = AGENT_NAMES[provider];
	if (!state?.version)
		return { error: `${name} is not installed on this computer` };
	if (!state.ready)
		return {
			error: `${name} is not logged in on this computer — ${LOGIN_HINTS[provider]}`,
		};
	return { run: runners[provider] };
}
