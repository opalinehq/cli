import { describe, expect, test } from "bun:test";
import { buildLegacyTranscriptWatermark } from "../lib/repository-evidence-upload.js";
import {
	buildSessionAttribution,
	continueSessionAttribution,
} from "../lib/session-attribution.js";
import { planTranscriptRevision } from "../lib/transcript-revision.js";

const MATERIALIZED_AT = {
	completedAt: "2026-09-21T10:00:01.000Z",
	startedAt: "2026-09-21T10:00:00.000Z",
};

describe("session capture attribution", () => {
	test("retains only Codex identities and turns observed inside the accepted prefix", async () => {
		const acceptedRecords = [
			JSON.stringify({
				ordinal: 40,
				payload: {
					id: "thread-child",
					parent_thread_id: "thread-root",
					session_id: "session-root",
				},
				timestamp: "2026-09-21T09:59:00.000Z",
				type: "session_meta",
			}),
			JSON.stringify({
				ordinal: 41,
				payload: { turn_id: "turn-one" },
				timestamp: "2026-09-21T09:59:30.000Z",
				type: "turn_context",
			}),
		].join("\n");
		const content = `${acceptedRecords}\n${JSON.stringify({
			ordinal: 42,
			payload: { turn_id: "turn-not-accepted" },
			timestamp: "2026-09-21T10:00:30.000Z",
			type: "turn_context",
		})}`;
		const revision = await planTranscriptRevision({
			content: new TextEncoder().encode(content),
			previous: undefined,
			scope: {
				actorId: "account-id-must-not-be-native",
				provider: "codex",
				providerInstanceId: "installation-id",
				sessionId: "thread-child",
			},
			terminal: false,
		});

		const attribution = buildSessionAttribution({
			captureId: "3b0ae8dc-dc01-48d3-a5e6-b34f6db302bf",
			childDiscovery: {
				omittedCount: 0,
				reason: null,
				status: "complete",
			},
			hook: {
				kind: "codex-agent-turn-complete",
				nativeBeforeActionBoundary: false,
				receivedAt: "2026-09-21T10:00:02.000Z",
			},
			opalineSessionId: "thread-child",
			source: "codex",
			streams: [
				{
					content,
					declaredAgentId: null,
					materializedAt: MATERIALIZED_AT,
					role: "root",
				},
			],
			terminal: false,
			transcriptRevision: revision.manifest,
		});

		expect(attribution.streams).toHaveLength(1);
		expect(attribution.coverage.runIdentity).toBe("complete");
		const stream = attribution.streams[0];
		expect(stream?.source).toBe("codex");
		if (stream?.source !== "codex") throw new Error("Expected Codex stream");
		expect(stream.native).toEqual({
			parentThreadId: "thread-root",
			sessionId: "session-root",
			threadId: "thread-child",
			turnIds: ["turn-one"],
		});
		expect(stream.prefix).toMatchObject({
			lastEventAt: "2026-09-21T09:59:30.000Z",
			lastNativeOrdinal: 41,
			lastRecordIndex: 1,
			recordCount: 2,
			terminal: false,
		});
		expect(stream.prefix.byteRange.endExclusive).toBe(
			new TextEncoder().encode(`${acceptedRecords}\n`).byteLength,
		);
		expect(JSON.stringify(attribution)).not.toContain(
			"account-id-must-not-be-native",
		);
		const next = await planTranscriptRevision({
			content: new TextEncoder().encode(`${content}\n`),
			previous: revision.manifest,
			scope: revision.manifest.scope,
			terminal: true,
		});
		const continued = continueSessionAttribution(
			attribution,
			"continuation-capture",
			next.manifest,
		);
		expect(continued.captureId).toBe("continuation-capture");
		expect(continued.streams[0]?.sourceRevision).toEqual({
			generation: next.manifest.generation,
			parentRevisionId: revision.manifest.revisionId,
			revisionId: next.manifest.revisionId,
		});
		expect(continued.streams[0]?.prefix).toEqual(stream.prefix);
		expect(continued.streams[0]?.native).toEqual(stream.native);
	});

	test("keeps Claude child identity without inventing parent or run IDs", async () => {
		const rootContent = `${JSON.stringify({
			sessionId: "claude-session",
			timestamp: "2026-09-21T09:00:00.000Z",
			type: "user",
			uuid: "root-record",
		})}\n`;
		const childContent = `${JSON.stringify({
			agentId: "child-native",
			parentUuid: "record-parent-not-agent-parent",
			sessionId: "claude-session",
			timestamp: "2026-09-21T09:01:00.000Z",
			type: "assistant",
			uuid: "child-record",
		})}\n`;
		const revision = await planTranscriptRevision({
			content: new TextEncoder().encode(rootContent),
			previous: undefined,
			scope: {
				actorId: "account-id",
				provider: "claude_code",
				providerInstanceId: "installation-id",
				sessionId: "claude-session",
			},
			terminal: true,
		});

		const attribution = buildSessionAttribution({
			captureId: "3b0ae8dc-dc01-48d3-a5e6-b34f6db302bf",
			childDiscovery: {
				omittedCount: 0,
				reason: null,
				status: "complete",
			},
			hook: {
				kind: "claude-session-end",
				nativeBeforeActionBoundary: false,
				receivedAt: "2026-09-21T10:00:02.000Z",
			},
			opalineSessionId: "claude-session",
			source: "claude_code",
			streams: [
				{
					content: rootContent,
					declaredAgentId: null,
					materializedAt: MATERIALIZED_AT,
					role: "root",
				},
				{
					content: childContent,
					declaredAgentId: "child-native",
					materializedAt: MATERIALIZED_AT,
					role: "child",
				},
			],
			terminal: true,
			transcriptRevision: revision.manifest,
		});

		const child = attribution.streams[1];
		expect(child?.source).toBe("claude_code");
		if (child?.source !== "claude_code") {
			throw new Error("Expected Claude child stream");
		}
		expect(child.native).toEqual({
			agentId: "child-native",
			parentAgentId: null,
			sessionId: "claude-session",
			turnIds: [],
		});
		expect(child.streamId).toBe(
			"claude_code:session:claude-session:agent:child-native",
		);
		expect(child.sourceRevision).toEqual({
			generation: null,
			parentRevisionId: null,
			revisionId: null,
		});
		expect(JSON.stringify(child)).not.toContain(
			"record-parent-not-agent-parent",
		);
	});

	test("represents an empty prefix without a fake ordinal", async () => {
		const revision = await planTranscriptRevision({
			content: new Uint8Array(),
			previous: undefined,
			scope: {
				actorId: "account-id",
				provider: "claude_code",
				providerInstanceId: "installation-id",
				sessionId: "empty-session",
			},
			terminal: false,
		});
		const attribution = buildSessionAttribution({
			captureId: "3b0ae8dc-dc01-48d3-a5e6-b34f6db302bf",
			childDiscovery: {
				omittedCount: null,
				reason: "No child directory was available",
				status: "unavailable",
			},
			hook: {
				kind: "claude-session-start",
				nativeBeforeActionBoundary: true,
				receivedAt: "2026-09-21T10:00:02.000Z",
			},
			opalineSessionId: "empty-session",
			source: "claude_code",
			streams: [
				{
					content: "",
					declaredAgentId: null,
					materializedAt: MATERIALIZED_AT,
					role: "root",
				},
			],
			terminal: false,
			transcriptRevision: revision.manifest,
		});

		expect(attribution.hook.nativeBeforeActionBoundary).toBe(true);
		expect(attribution.coverage).toMatchObject({
			nativeIdentity: "unavailable",
			runIdentity: "unavailable",
		});
		expect(attribution.streams[0]?.prefix).toMatchObject({
			byteRange: { endExclusive: 0, startInclusive: 0 },
			lastEventAt: null,
			lastNativeOrdinal: null,
			lastRecordIndex: null,
			recordCount: 0,
		});
		expect(buildLegacyTranscriptWatermark(revision, null)).toBeNull();
	});

	test("keeps the legacy ordinal non-null for a nonempty provider stream", async () => {
		const revision = await planTranscriptRevision({
			content: new TextEncoder().encode('{"type":"user"}\n'),
			previous: undefined,
			scope: {
				actorId: "account-id",
				provider: "claude_code",
				providerInstanceId: "installation-id",
				sessionId: "nonempty-session",
			},
			terminal: false,
		});

		expect(buildLegacyTranscriptWatermark(revision, null)).toEqual({
			byteOffset: 16,
			eventOrdinal: 0,
			lastEventAt: null,
		});
	});
});
