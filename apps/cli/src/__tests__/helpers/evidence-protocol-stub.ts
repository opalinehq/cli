import { createHash, randomUUID } from "node:crypto";
import {
	REPOSITORY_EVIDENCE_PART_SIZE_BYTES,
	REPOSITORY_EVIDENCE_PROTOCOL,
	RepositoryEvidenceCommitInputSchema,
	type RepositoryEvidenceInitInput,
	RepositoryEvidenceInitInputSchema,
} from "../../contracts/index.js";
import type {
	CaptureRuntime,
	ToolResultReferences,
	UserAgentConfiguration,
} from "../../internal/local-context-source/index.js";
import { type IngestStub, startIngestStub } from "./ingest-stub.js";

/**
 * Repository-evidence protocol simulator on top of the loopback ingest stub:
 * init plans multipart uploads for objects the "server" does not have yet,
 * PUTs store part bytes, commit assembles and hash-verifies every object and
 * records the capture. Faults are injected per request. Like the real API, a
 * commit of an upload plan that a newer init of the same operation replaced
 * is rejected as a conflict, so concurrent deliveries are visible.
 */

export interface EvidenceStubFaults {
	/** Return an HTTP status (or a delay) for the n-th request of a kind. */
	init?: (index: number) => EvidenceStubFault;
	put?: (index: number) => EvidenceStubFault;
	commit?: (index: number) => EvidenceStubFault;
	/** Server-side capture switch; true answers EVIDENCE_CAPTURE_DISABLED. */
	disabled?: () => boolean;
}

export type EvidenceStubFault =
	| { readonly status: number }
	| { readonly delayMs: number }
	| { readonly hang: Promise<void> }
	| undefined;

export interface CommittedEvidence {
	readonly input: RepositoryEvidenceInitInput;
	readonly manifest: CommittedManifest;
	readonly objects: ReadonlyMap<string, Uint8Array>;
	readonly committedAt: number;
}

export interface CommittedManifest {
	readonly localContext: {
		readonly captureId: string;
		readonly entries: readonly {
			readonly rootId: string;
			readonly path: string;
			readonly kind: string;
			readonly categories: readonly string[];
			readonly content?: {
				readonly status: string;
				readonly blobId?: string;
				readonly reason?: string;
				readonly detail?: string | null;
				readonly secretFilter?: { readonly redactedBytes: number };
			};
			readonly hash?: {
				readonly status: string;
				readonly value?: string;
				readonly scope?: string;
			};
		}[];
		readonly roots: readonly {
			readonly id: string;
			readonly label?: string;
			readonly status: string;
			readonly absolutePath: string;
			readonly aliases?: readonly {
				readonly id: string;
				readonly relation: string;
			}[];
		}[];
		readonly git: {
			readonly status: string;
			readonly truncatedSections?: readonly string[];
			readonly worktrees?: readonly unknown[];
		};
		readonly coverage: {
			readonly limitsReached: readonly string[];
			readonly truncated?: unknown;
		};
		readonly userConfiguration?: UserAgentConfiguration;
		readonly toolResultReferences?: ToolResultReferences;
		readonly runtime?: CaptureRuntime;
	};
	readonly contextIndex: {
		readonly facets: readonly {
			readonly kind: string;
			readonly rootId: string;
			readonly coverage: string;
			readonly presence: string;
		}[];
	};
	readonly transcriptRevision: {
		readonly chunks: readonly {
			readonly sha256: string;
			readonly endByte: number;
		}[];
		readonly watermark: { readonly byteOffset: number };
	};
}

export interface EvidenceProtocolStub {
	readonly stub: IngestStub;
	readonly base: string;
	readonly committed: Map<string, CommittedEvidence>;
	readonly counts: {
		init: number;
		put: number;
		commit: number;
		conflicts: number;
	};
	readonly transcriptUploads: string[];
	readonly faults: EvidenceStubFaults;
	stop(): void;
}

interface PlannedUpload {
	readonly input: RepositoryEvidenceInitInput;
	readonly parts: Map<string, Map<number, Uint8Array>>;
}

export function startEvidenceProtocolStub(
	faults: EvidenceStubFaults = {},
): EvidenceProtocolStub {
	const uploads = new Map<string, PlannedUpload>();
	const latestUploadByOperation = new Map<string, string>();
	const stored = new Map<string, Uint8Array>();
	const committed = new Map<string, CommittedEvidence>();
	const counts = { init: 0, put: 0, commit: 0, conflicts: 0 };
	const transcriptUploads: string[] = [];
	const stub = startIngestStub({
		hostname: "127.0.0.1",
		captureBodies: false,
		async respond(info) {
			const { pathname } = info;
			if (pathname === "/rpc/repositoryEvidence/init") {
				const index = counts.init++;
				const failure = await applyFault(faults.init?.(index), true);
				if (failure) return failure;
				if (faults.disabled?.()) return disabledResponse();
				const input = RepositoryEvidenceInitInputSchema.parse(
					JSON.parse(info.body).json,
				);
				const uploadReceiptId = randomUUID();
				const host = info.headers.get("host") ?? `${info.hostname}`;
				const missing = input.objects.filter(
					(object) => !stored.has(object.objectId),
				);
				uploads.set(uploadReceiptId, { input, parts: new Map() });
				latestUploadByOperation.set(input.operationId, uploadReceiptId);
				return Response.json({
					json: {
						expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
						missingObjects: missing.map((object) => ({
							byteLength: object.byteLength,
							objectId: object.objectId,
							objectKey: `evidence/${object.sha256}`,
							parts: planParts(object.byteLength).map((part) => ({
								byteLength: part.byteLength,
								headers: { "Content-Length": String(part.byteLength) },
								partNumber: part.partNumber,
								uploadUrl: `http://${host}/r2/${uploadReceiptId}/${object.sha256}/${part.partNumber}`,
							})),
							uploadId: `upload-${object.sha256.slice(0, 16)}`,
						})),
						partSizeBytes: REPOSITORY_EVIDENCE_PART_SIZE_BYTES,
						protocol: REPOSITORY_EVIDENCE_PROTOCOL,
						reusedObjectIds: input.objects
							.filter((object) => stored.has(object.objectId))
							.map((object) => object.objectId),
						uploadReceiptId,
					},
				});
			}
			if (pathname.startsWith("/r2/") && info.method === "PUT") {
				const index = counts.put++;
				const failure = await applyFault(faults.put?.(index), false);
				if (failure) return failure;
				const [, , receiptId, sha256, partNumber] = pathname.split("/");
				const upload = uploads.get(receiptId ?? "");
				if (!upload || !sha256 || !partNumber)
					return new Response("unknown upload", { status: 404 });
				const parts = upload.parts.get(`sha256:${sha256}`) ?? new Map();
				const bytes = info.rawBody;
				parts.set(Number(partNumber), bytes);
				upload.parts.set(`sha256:${sha256}`, parts);
				return new Response(null, {
					status: 200,
					headers: { etag: `"${hashBytes(bytes)}"` },
				});
			}
			if (pathname === "/rpc/repositoryEvidence/commit") {
				const index = counts.commit++;
				const failure = await applyFault(faults.commit?.(index), true);
				if (failure) return failure;
				if (faults.disabled?.()) return disabledResponse();
				const input = RepositoryEvidenceCommitInputSchema.parse(
					JSON.parse(info.body).json,
				);
				const upload = uploads.get(input.uploadReceiptId);
				if (!upload) return orpcError("EVIDENCE_NOT_FOUND", 404);
				const plan = upload.input;
				const existing = committed.get(plan.capture.contextId);
				if (existing && existing.input.operationId === plan.operationId)
					return Response.json({
						json: commitOutput(plan, input.uploadReceiptId, "duplicate"),
					});
				if (
					latestUploadByOperation.get(plan.operationId) !==
					input.uploadReceiptId
				) {
					counts.conflicts += 1;
					return orpcError("EVIDENCE_UPLOAD_CONFLICT", 409);
				}
				for (const object of input.objects) {
					const parts = upload.parts.get(object.objectId);
					if (!parts) return orpcError("EVIDENCE_OBJECT_MISMATCH", 409);
					const ordered = [...object.parts]
						.sort((left, right) => left.partNumber - right.partNumber)
						.map((part) => parts.get(part.partNumber));
					if (ordered.some((part) => part === undefined))
						return orpcError("EVIDENCE_OBJECT_MISMATCH", 409);
					const bytes = Buffer.concat(
						ordered.filter((part) => part !== undefined),
					);
					if (`sha256:${hashBytes(bytes)}` !== object.objectId)
						return orpcError("EVIDENCE_OBJECT_MISMATCH", 409);
					stored.set(object.objectId, new Uint8Array(bytes));
				}
				const objects = new Map<string, Uint8Array>();
				for (const descriptor of plan.objects) {
					const bytes = stored.get(descriptor.objectId);
					if (!bytes) return orpcError("EVIDENCE_OBJECT_MISMATCH", 409);
					objects.set(descriptor.objectId, bytes);
				}
				const manifestBytes = objects.get(plan.manifestObjectId);
				if (!manifestBytes) return orpcError("EVIDENCE_OBJECT_MISMATCH", 409);
				committed.set(plan.capture.contextId, {
					committedAt: Date.now(),
					input: plan,
					manifest: JSON.parse(new TextDecoder().decode(manifestBytes)),
					objects,
				});
				return Response.json({
					json: commitOutput(plan, input.uploadReceiptId, "accepted"),
				});
			}
			if (pathname === "/rpc/ingest/init")
				return orpcError("NOT_FOUND", 404, "older ingest");
			if (pathname === "/rpc/cli/authStatus")
				return Response.json({
					json: {
						capabilities: { analysisLinkedUploads: true },
						email: "test@example.invalid",
						id: "user-1",
						name: "Test",
					},
				});
			if (pathname === "/rpc/ingestSession") {
				transcriptUploads.push(info.body);
				// Analysis-linked uploads (`opaline import --analysis`) need the
				// link echoed back, as the real API does.
				const analysisId: unknown = JSON.parse(info.body).json?.analysisId;
				return Response.json({
					json: {
						success: true,
						sessionId: "stub-session",
						...(typeof analysisId === "string" ? { analysisId } : {}),
					},
				});
			}
			return Response.json({
				json: { success: true, sessionId: "stub-session" },
			});
		},
	});
	return {
		stub,
		base: stub.loopbackBase,
		committed,
		counts,
		transcriptUploads,
		faults,
		stop: () => stub.server.stop(true),
	};
}

/** RPC faults use the oRPC error envelope the CLI parses; PUTs are plain. */
async function applyFault(
	fault: EvidenceStubFault,
	rpc: boolean,
): Promise<Response | undefined> {
	if (fault === undefined) return undefined;
	if ("delayMs" in fault) {
		await Bun.sleep(fault.delayMs);
		return undefined;
	}
	if ("hang" in fault) {
		await fault.hang;
		return new Response("released", { status: 503 });
	}
	return rpc
		? orpcError("INJECTED_FAILURE", fault.status)
		: new Response("injected failure", { status: fault.status });
}

function planParts(byteLength: number) {
	const parts: { partNumber: number; byteLength: number }[] = [];
	for (
		let offset = 0, partNumber = 1;
		offset < byteLength;
		offset += REPOSITORY_EVIDENCE_PART_SIZE_BYTES, partNumber += 1
	) {
		parts.push({
			partNumber,
			byteLength: Math.min(
				REPOSITORY_EVIDENCE_PART_SIZE_BYTES,
				byteLength - offset,
			),
		});
	}
	return parts;
}

function commitOutput(
	plan: RepositoryEvidenceInitInput,
	uploadReceiptId: string,
	status: "accepted" | "duplicate",
) {
	return {
		acceptedAt: new Date().toISOString(),
		contextId: plan.capture.contextId,
		manifestObjectId: plan.manifestObjectId,
		protocol: plan.protocol,
		receiptId: randomUUID(),
		status,
		storedObjectIds: plan.objects.map((object) => object.objectId),
		uploadReceiptId,
	};
}

function disabledResponse(): Response {
	return Response.json(
		{
			json: {
				defined: true,
				code: "EVIDENCE_CAPTURE_DISABLED",
				status: 403,
				message: "Repository evidence capture is temporarily disabled.",
				data: { pauseSeconds: 3_600 },
			},
		},
		{ status: 403 },
	);
}

function orpcError(code: string, status: number, message = code): Response {
	return Response.json(
		{ json: { defined: true, code, status, message } },
		{ status },
	);
}

function hashBytes(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}
