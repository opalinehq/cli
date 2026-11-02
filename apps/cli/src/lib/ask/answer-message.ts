import { SESSION_NOT_FOUND_ERROR } from "./agent-event.js";
import type { AgentJob, AgentOutcome, RunAgent } from "./agent-process.js";
import { ProgressBuffer, type ProgressPatch } from "./progress-buffer.js";

export type AskProvider = "claude" | "codex";
export type AskStatus = "pending" | "running" | "done" | "failed" | "cancelled";

export interface ClaimedMessage {
	readonly threadId: string;
	readonly prompt: string;
	readonly provider: AskProvider;
	readonly resumeSessionId?: string;
	readonly resumePrompt?: string;
}

export type FinishInput = {
	readonly messageId: string;
	readonly status: "done" | "failed";
	readonly error?: string;
};

export interface AskBackend {
	claim(messageId: string): Promise<ClaimedMessage | null>;
	watchStatus(
		messageId: string,
		onStatus: (status: AskStatus | null) => void,
	): () => void;
	progress(input: { messageId: string } & ProgressPatch): Promise<void>;
	finish(input: FinishInput): Promise<void>;
}

export interface McpAccess {
	readonly mcpUrl: string;
	readonly mcpToken: string;
}

export interface AnswerDependencies {
	readonly backend: AskBackend;
	readonly selectAgent: (
		provider: AskProvider,
	) => Promise<{ readonly run: RunAgent } | { readonly error: string }>;
	readonly mcpAccess: () => Promise<McpAccess>;
	readonly stopSignal: AbortSignal;
	readonly flushIntervalMs?: number;
	readonly onClaimed?: (claimed: ClaimedMessage) => void;
	readonly onWarning?: (message: string) => void;
}

export type AnswerResult =
	| { readonly status: "not-claimed" | "done" | "cancelled" | "stopped" }
	| { readonly status: "failed"; readonly error: string };

export const BRIDGE_STOPPED_ERROR = "The bridge stopped";

const DEFAULT_FLUSH_INTERVAL_MS = 300;

export async function answerMessage(
	messageId: string,
	dependencies: AnswerDependencies,
): Promise<AnswerResult> {
	const { backend } = dependencies;
	const claimed = await backend.claim(messageId);
	if (!claimed) return { status: "not-claimed" };
	dependencies.onClaimed?.(claimed);
	const agent = await dependencies.selectAgent(claimed.provider);
	if ("error" in agent) {
		await backend.finish({ messageId, status: "failed", error: agent.error });
		return { status: "failed", error: agent.error };
	}
	const cancel = new AbortController();
	const unwatch = backend.watchStatus(messageId, (status) => {
		if (status === "cancelled") cancel.abort();
	});
	try {
		return await runClaimedMessage(
			messageId,
			claimed,
			agent.run,
			cancel,
			dependencies,
		);
	} finally {
		unwatch();
	}
}

async function runClaimedMessage(
	messageId: string,
	claimed: ClaimedMessage,
	runAgent: RunAgent,
	cancel: AbortController,
	dependencies: AnswerDependencies,
): Promise<AnswerResult> {
	const signal = AbortSignal.any([cancel.signal, dependencies.stopSignal]);
	const progress = startProgressReporter(messageId, dependencies);
	const outcome = await runAgentSafely(
		claimed,
		runAgent,
		signal,
		progress,
		dependencies,
	);
	await progress.stop();
	if (cancel.signal.aborted) return { status: "cancelled" };
	const finish = finishFor(outcome, dependencies.stopSignal);
	await dependencies.backend.finish({ messageId, ...finish });
	if (dependencies.stopSignal.aborted) return { status: "stopped" };
	return finish;
}

async function runAgentSafely(
	claimed: ClaimedMessage,
	runAgent: RunAgent,
	signal: AbortSignal,
	progress: ProgressReporter,
	dependencies: AnswerDependencies,
): Promise<AgentOutcome> {
	try {
		const access = await dependencies.mcpAccess();
		const run = (job: Pick<AgentJob, "prompt" | "resumeSessionId">) =>
			runAgent(
				{ ...job, mcpUrl: access.mcpUrl, mcpToken: access.mcpToken },
				{ signal, onEvent: (event) => progress.buffer.add(event) },
			);
		const fresh = { prompt: claimed.prompt };
		if (!claimed.resumeSessionId || !claimed.resumePrompt)
			return await run(fresh);
		const resumed = await run({
			prompt: claimed.resumePrompt,
			resumeSessionId: claimed.resumeSessionId,
		});
		return isMissingSession(resumed) && !signal.aborted
			? await run(fresh)
			: resumed;
	} catch (error) {
		if (signal.aborted) return { status: "stopped" };
		return {
			status: "failed",
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

function isMissingSession(outcome: AgentOutcome): boolean {
	return (
		outcome.status === "failed" && outcome.error === SESSION_NOT_FOUND_ERROR
	);
}

function finishFor(
	outcome: AgentOutcome,
	stopSignal: AbortSignal,
):
	| { readonly status: "done" }
	| { readonly status: "failed"; readonly error: string } {
	if (stopSignal.aborted || outcome.status === "stopped")
		return { status: "failed", error: BRIDGE_STOPPED_ERROR };
	if (outcome.status === "failed")
		return { status: "failed", error: outcome.error };
	return { status: "done" };
}

interface ProgressReporter {
	readonly buffer: ProgressBuffer;
	stop(): Promise<void>;
}

function startProgressReporter(
	messageId: string,
	dependencies: AnswerDependencies,
): ProgressReporter {
	const buffer = new ProgressBuffer();
	let sending: Promise<void> = Promise.resolve();
	const flush = () => {
		const patch = buffer.take();
		if (!patch) return sending;
		sending = sending.then(() =>
			dependencies.backend
				.progress({ messageId, ...patch })
				.catch((error: unknown) =>
					dependencies.onWarning?.(
						`Could not send progress: ${error instanceof Error ? error.message : String(error)}`,
					),
				),
		);
		return sending;
	};
	const timer = setInterval(
		flush,
		dependencies.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS,
	);
	return {
		buffer,
		stop: () => {
			clearInterval(timer);
			return flush();
		},
	};
}
