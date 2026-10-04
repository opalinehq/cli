import { createRpcClient } from "./api-client.js";
import {
	hasCachedTranscriptSlimmingCapability,
	rememberTranscriptSlimmingCapability,
} from "./r2-upload-capability.js";

const PREFLIGHT_TIMEOUT_MS = 10_000;

// Answers within this process (also negative ones, so a batch against an
// older server asks once); only positive answers are persisted.
const answers = new Map<string, Promise<boolean>>();

/**
 * Whether the server accepts slimmed transcripts: `cli.authStatus` reports
 * `capabilities.transcriptSlimming`. Servers without it compare a new upload
 * with the stored session and reject large shrinkage, so they get the
 * unslimmed filtered transcript, exactly as 0.11 sent it. Unreachable or
 * older servers count as unsupported.
 */
export function supportsTranscriptSlimming(
	rpcUrl: URL,
	authType: "api-key" | "bearer",
	token: string,
): Promise<boolean> {
	if (hasCachedTranscriptSlimmingCapability(rpcUrl, authType, token))
		return Promise.resolve(true);
	const key = `${rpcUrl.href}\u0000${authType}\u0000${token}`;
	const known = answers.get(key);
	if (known !== undefined) return known;
	const answer = askServer(rpcUrl, authType, token);
	answers.set(key, answer);
	return answer;
}

async function askServer(
	rpcUrl: URL,
	authType: "api-key" | "bearer",
	token: string,
): Promise<boolean> {
	try {
		const status = await createRpcClient({
			authType,
			rpcUrl: rpcUrl.toString(),
			token,
		}).cli.authStatus(undefined, {
			signal: AbortSignal.timeout(PREFLIGHT_TIMEOUT_MS),
		});
		if (status.capabilities?.transcriptSlimming !== true) return false;
		await rememberTranscriptSlimmingCapability(rpcUrl, authType, token);
		return true;
	} catch {
		return false;
	}
}
