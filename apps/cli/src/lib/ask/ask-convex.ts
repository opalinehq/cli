import type { ConvexClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import type {
	AskBackend,
	AskStatus,
	ClaimedMessage,
	FinishInput,
} from "./answer-message.js";
import type { PendingMessage } from "./pending-queue.js";
import type { AskTool } from "./progress-buffer.js";
import type { ProviderState } from "./providers.js";

export type HeartbeatInput = {
	readonly name: string;
	readonly cliVersion: string;
	readonly providers: ProviderState[];
};

type ProgressInput = {
	readonly messageId: string;
	readonly text?: string;
	readonly tools?: AskTool[];
	readonly agentSessionId?: string;
};

export const askFunctions = {
	heartbeat: makeFunctionReference<"mutation", HeartbeatInput, null>(
		"ask:heartbeat",
	),
	pending: makeFunctionReference<
		"query",
		Record<string, never>,
		PendingMessage[]
	>("ask:pending"),
	claim: makeFunctionReference<
		"mutation",
		{ messageId: string },
		ClaimedMessage | null
	>("ask:claim"),
	job: makeFunctionReference<
		"query",
		{ messageId: string },
		{ status: AskStatus } | null
	>("ask:job"),
	progress: makeFunctionReference<"mutation", ProgressInput, null>(
		"ask:progress",
	),
	finish: makeFunctionReference<"mutation", FinishInput, null>("ask:finish"),
};

export type AskConvexClient = Pick<ConvexClient, "mutation" | "onUpdate">;

export interface BridgeBackend extends AskBackend {
	heartbeat(input: HeartbeatInput): Promise<void>;
	watchPending(
		onPending: (pending: PendingMessage[]) => void,
		onError: (error: Error) => void,
	): () => void;
}

export function createAskBackend(client: AskConvexClient): BridgeBackend {
	return {
		heartbeat: async (input) => {
			await client.mutation(askFunctions.heartbeat, { ...input });
		},
		watchPending: (onPending, onError) =>
			client.onUpdate(askFunctions.pending, {}, onPending, onError),
		claim: (messageId) => client.mutation(askFunctions.claim, { messageId }),
		watchStatus: (messageId, onStatus) =>
			client.onUpdate(askFunctions.job, { messageId }, (job) =>
				onStatus(job?.status ?? null),
			),
		progress: async (input) => {
			await client.mutation(askFunctions.progress, input);
		},
		finish: async (input) => {
			await client.mutation(askFunctions.finish, { ...input });
		},
	};
}
