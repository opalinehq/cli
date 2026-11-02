import type { AgentEvent, ToolState } from "./agent-event.js";

export interface AskTool {
	readonly id: string;
	readonly name: string;
	readonly state: ToolState;
}

export interface ProgressPatch {
	readonly text?: string;
	readonly tools?: AskTool[];
	readonly agentSessionId?: string;
}

const BLOCK_SEPARATOR = "\n\n";

export class ProgressBuffer {
	private text = "";
	private readonly tools = new Map<string, AskTool>();
	private agentSessionId: string | undefined;
	private hasWrittenText = false;

	add(event: AgentEvent): void {
		if (event.kind === "session") this.agentSessionId = event.sessionId;
		if (event.kind === "tool")
			this.tools.set(event.id, {
				id: event.id,
				name: event.name,
				state: event.state,
			});
		if (event.kind === "text") this.appendText(event.text);
	}

	take(): ProgressPatch | undefined {
		if (!this.text && this.tools.size === 0 && !this.agentSessionId)
			return undefined;
		const patch: ProgressPatch = {
			...(this.text ? { text: this.text } : {}),
			...(this.tools.size > 0 ? { tools: [...this.tools.values()] } : {}),
			...(this.agentSessionId ? { agentSessionId: this.agentSessionId } : {}),
		};
		this.text = "";
		this.tools.clear();
		this.agentSessionId = undefined;
		return patch;
	}

	private appendText(text: string): void {
		this.text += this.hasWrittenText ? `${BLOCK_SEPARATOR}${text}` : text;
		this.hasWrittenText = true;
	}
}
