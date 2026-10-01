import assert from "node:assert/strict";
import { readTranscriptRevision } from "../../lib/transcript-revision-store.js";

const [
	configDir,
	endpoint,
	organizationId,
	actorId,
	providerValue,
	providerInstanceId,
	sessionId,
] = Bun.argv.slice(2);

assert(configDir);
assert(endpoint);
assert(organizationId);
assert(actorId);
assert(providerValue === "claude_code" || providerValue === "codex");
assert(providerInstanceId);
assert(sessionId);

await readTranscriptRevision(
	{
		endpoint,
		organizationId,
		transcriptScope: {
			actorId,
			provider: providerValue,
			providerInstanceId,
			sessionId,
		},
	},
	configDir,
);
