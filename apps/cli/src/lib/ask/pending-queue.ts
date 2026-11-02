export interface PendingMessage {
	readonly messageId: string;
	readonly threadId: string;
	readonly provider: string;
	readonly createdAt: number;
}

const RETRY_DELAY_MS = 5_000;

export class PendingQueue {
	private latest: readonly PendingMessage[] = [];
	private readonly tried = new Set<string>();
	private running: Promise<void> | undefined;

	constructor(
		private readonly answer: (messageId: string) => Promise<unknown>,
		private readonly stopSignal: AbortSignal,
		private readonly onError: (error: unknown) => void,
	) {}

	update(pending: readonly PendingMessage[]): void {
		this.latest = pending;
		const pendingIds = new Set(pending.map((message) => message.messageId));
		for (const id of this.tried) if (!pendingIds.has(id)) this.tried.delete(id);
		this.pump();
	}

	settled(): Promise<void> {
		return this.running ?? Promise.resolve();
	}

	private pump(): void {
		if (this.running || this.stopSignal.aborted) return;
		const next = this.latest.find(
			(message) => !this.tried.has(message.messageId),
		);
		if (!next) return;
		this.tried.add(next.messageId);
		this.running = this.answer(next.messageId)
			.then(
				() => undefined,
				(error: unknown) => this.retryLater(next.messageId, error),
			)
			.finally(() => {
				this.running = undefined;
				this.pump();
			});
	}

	private retryLater(messageId: string, error: unknown): void {
		this.onError(error);
		setTimeout(() => {
			this.tried.delete(messageId);
			this.pump();
		}, RETRY_DELAY_MS).unref();
	}
}
