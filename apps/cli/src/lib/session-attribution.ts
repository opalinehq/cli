import type { Source } from "../contracts/index.js";
import type { FileBackedUploadSubagentDiscovery } from "../internal/agent-adapters/index.js";
import {
	describeAcceptedTranscriptPrefix,
	type TranscriptRevisionManifest,
} from "./transcript-revision.js";

export const SESSION_ATTRIBUTION_SCHEMA =
	"opaline-capture-attribution/v1" as const;

export type SessionAttributionHookKind =
	| "claude-session-start"
	| "claude-session-end"
	| "codex-agent-turn-complete";

export interface SessionAttributionSourceStream {
	readonly content: string;
	readonly declaredAgentId: string | null;
	readonly materializedAt: {
		readonly completedAt: string;
		readonly startedAt: string;
	};
	readonly role: "root" | "child";
}

export interface SessionAttributionManifest {
	readonly captureId: string;
	readonly coverage: {
		readonly childStreams: FileBackedUploadSubagentDiscovery;
		readonly nativeIdentity: "complete" | "partial" | "unavailable";
		readonly runIdentity: "complete" | "partial" | "unavailable";
	};
	readonly hook: {
		readonly kind: SessionAttributionHookKind;
		readonly nativeBeforeActionBoundary: boolean;
		readonly receivedAt: string;
	};
	readonly schema: typeof SESSION_ATTRIBUTION_SCHEMA;
	readonly streams: readonly SessionAttributionStream[];
}

interface SessionAttributionStreamBase {
	readonly materializedAt: {
		readonly completedAt: string;
		readonly startedAt: string;
	};
	readonly opalineSessionId: string;
	readonly prefix: {
		readonly byteRange: {
			readonly endExclusive: number;
			readonly startInclusive: 0;
		};
		readonly lastEventAt: string | null;
		readonly lastNativeOrdinal: number | null;
		readonly lastRecordIndex: number | null;
		readonly recordCount: number;
		readonly sha256: string;
		readonly terminal: boolean;
	};
	readonly role: "root" | "child";
	readonly sourceRevision: {
		readonly generation: number | null;
		readonly parentRevisionId: string | null;
		readonly revisionId: string | null;
	};
	readonly streamId: string;
}

interface CodexAttributionStream extends SessionAttributionStreamBase {
	readonly native: {
		readonly parentThreadId: string | null;
		readonly sessionId: string | null;
		readonly threadId: string | null;
		readonly turnIds: readonly string[];
	};
	readonly source: "codex";
}

interface ClaudeAttributionStream extends SessionAttributionStreamBase {
	readonly native: {
		readonly agentId: string | null;
		readonly parentAgentId: null;
		readonly sessionId: string | null;
		readonly turnIds: readonly [];
	};
	readonly source: "claude_code";
}

export type SessionAttributionStream =
	| ClaudeAttributionStream
	| CodexAttributionStream;

export function buildSessionAttribution(input: {
	readonly captureId: string;
	readonly childDiscovery: FileBackedUploadSubagentDiscovery;
	readonly hook: {
		readonly kind: SessionAttributionHookKind;
		readonly nativeBeforeActionBoundary: boolean;
		readonly receivedAt: string;
	};
	readonly opalineSessionId: string;
	readonly source: Source;
	readonly streams: readonly SessionAttributionSourceStream[];
	readonly terminal: boolean;
	readonly transcriptRevision: TranscriptRevisionManifest;
}): SessionAttributionManifest {
	const streams = input.streams.map((stream) =>
		buildStreamAttribution(stream, input),
	);
	const nativeIdentityCount = streams.filter(hasNativeIdentity).length;
	const nativeRunCount = streams.filter(hasNativeRunIdentity).length;
	return {
		captureId: input.captureId,
		coverage: {
			childStreams: input.childDiscovery,
			nativeIdentity:
				streams.length === 0
					? "unavailable"
					: nativeIdentityCount === streams.length
						? "complete"
						: nativeIdentityCount === 0
							? "unavailable"
							: "partial",
			runIdentity:
				nativeRunCount === 0
					? "unavailable"
					: nativeRunCount === streams.length
						? "complete"
						: "partial",
		},
		hook: {
			kind: input.hook.kind,
			nativeBeforeActionBoundary: input.hook.nativeBeforeActionBoundary,
			receivedAt: input.hook.receivedAt,
		},
		schema: SESSION_ATTRIBUTION_SCHEMA,
		streams,
	};
}

function buildStreamAttribution(
	stream: SessionAttributionSourceStream,
	input: {
		readonly opalineSessionId: string;
		readonly source: Source;
		readonly terminal: boolean;
		readonly transcriptRevision: TranscriptRevisionManifest;
	},
): SessionAttributionStream {
	const accepted = describeAcceptedTranscriptPrefix(
		new TextEncoder().encode(stream.content),
		input.terminal,
	);
	const records = parseRecords(accepted.bytes);
	const prefix = {
		byteRange: {
			endExclusive: accepted.bytes.byteLength,
			startInclusive: 0 as const,
		},
		lastEventAt: findLastEventAt(records),
		lastNativeOrdinal: accepted.lastOrdinal,
		lastRecordIndex:
			accepted.recordCount === 0 ? null : accepted.recordCount - 1,
		recordCount: accepted.recordCount,
		sha256: accepted.prefixSha256,
		terminal: input.terminal && accepted.acceptedTerminalSuffix,
	};
	const sourceRevision =
		stream.role === "root"
			? {
					generation: input.transcriptRevision.generation,
					parentRevisionId: input.transcriptRevision.parentRevisionId ?? null,
					revisionId: input.transcriptRevision.revisionId,
				}
			: {
					generation: null,
					parentRevisionId: null,
					revisionId: null,
				};
	if (input.source === "codex") {
		const native = readCodexIdentity(records);
		return {
			materializedAt: stream.materializedAt,
			native,
			opalineSessionId: input.opalineSessionId,
			prefix,
			role: stream.role,
			source: "codex",
			sourceRevision,
			streamId: native.threadId
				? `codex:thread:${native.threadId}`
				: `codex:session:${input.opalineSessionId}`,
		};
	}
	const native = readClaudeIdentity(records, stream.declaredAgentId);
	return {
		materializedAt: stream.materializedAt,
		native,
		opalineSessionId: input.opalineSessionId,
		prefix,
		role: stream.role,
		source: "claude_code",
		sourceRevision,
		streamId:
			stream.role === "child" && native.agentId
				? `claude_code:session:${native.sessionId ?? input.opalineSessionId}:agent:${native.agentId}`
				: `claude_code:session:${native.sessionId ?? input.opalineSessionId}:root`,
	};
}

function parseRecords(bytes: Uint8Array): readonly Record<string, unknown>[] {
	const records: Record<string, unknown>[] = [];
	for (const line of new TextDecoder().decode(bytes).split("\n")) {
		if (!line.trim()) continue;
		try {
			const value: unknown = JSON.parse(line);
			if (isRecord(value)) records.push(value);
		} catch {
			// Malformed records remain counted and hashed, but cannot supply identity.
		}
	}
	return records;
}

function readCodexIdentity(records: readonly Record<string, unknown>[]) {
	let sessionId: string | null = null;
	let threadId: string | null = null;
	let parentThreadId: string | null = null;
	const turnIds = new Set<string>();
	for (const record of records) {
		const payload = isRecord(record.payload) ? record.payload : null;
		if (record.type === "session_meta" && payload) {
			if (typeof payload.session_id === "string") {
				sessionId = payload.session_id;
			}
			if (typeof payload.id === "string") threadId = payload.id;
			if (typeof payload.parent_thread_id === "string") {
				parentThreadId = payload.parent_thread_id;
			}
		}
		if (
			(record.type === "turn_context" || record.type === "event_msg") &&
			payload &&
			typeof payload.turn_id === "string"
		) {
			turnIds.add(payload.turn_id);
		}
	}
	return { parentThreadId, sessionId, threadId, turnIds: [...turnIds] };
}

function readClaudeIdentity(
	records: readonly Record<string, unknown>[],
	declaredAgentId: string | null,
) {
	let sessionId: string | null = null;
	let agentId: string | null = null;
	for (const record of records) {
		if (typeof record.sessionId === "string") sessionId = record.sessionId;
		if (
			typeof record.agentId === "string" &&
			(declaredAgentId === null || record.agentId === declaredAgentId)
		) {
			agentId = record.agentId;
		}
	}
	return {
		agentId,
		parentAgentId: null,
		sessionId,
		turnIds: [] as const,
	};
}

function findLastEventAt(
	records: readonly Record<string, unknown>[],
): string | null {
	let lastEventAt: string | null = null;
	for (const record of records) {
		if (
			typeof record.timestamp === "string" &&
			Number.isFinite(Date.parse(record.timestamp))
		) {
			lastEventAt = new Date(Date.parse(record.timestamp)).toISOString();
		}
	}
	return lastEventAt;
}

function hasNativeIdentity(stream: SessionAttributionStream): boolean {
	return stream.source === "codex"
		? stream.native.sessionId !== null && stream.native.threadId !== null
		: stream.native.sessionId !== null &&
				(stream.role === "root" || stream.native.agentId !== null);
}

function hasNativeRunIdentity(stream: SessionAttributionStream): boolean {
	return stream.source === "codex" && stream.native.turnIds.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
