/**
 * Loopback Opaline API stub for the direct-R2 ingest protocol: init, one
 * multipart part per object, commit and status, with scripted commit and
 * status answers. Every RPC body is kept for assertions.
 */

export interface R2StubCall {
	readonly pathname: string;
	readonly input: Record<string, unknown>;
}

export type R2StubCommitAnswer =
	| { readonly kind: "completed" }
	| {
			readonly kind: "unavailable";
			readonly reason: string;
			readonly queued?: boolean;
	  };

export type R2StubStatusAnswer =
	| { readonly kind: "pending" | "running"; readonly errorCode?: string }
	| {
			readonly kind: "completed";
			/** Defaults to the session of the init that created the job. */
			readonly sessionId?: string;
			readonly analysisId?: string;
	  }
	| { readonly kind: "failed"; readonly code: string; readonly message: string }
	| { readonly kind: "not-found" }
	| {
			readonly kind: "http-error";
			readonly status: number;
			readonly code: string;
			readonly message: string;
	  };

export interface R2IngestStub {
	readonly baseUrl: string;
	readonly calls: R2StubCall[];
	/** Job id handed out by the next init. */
	nextJobId: string;
	commit: (jobId: string) => R2StubCommitAnswer;
	status: (jobId: string) => R2StubStatusAnswer;
	stop: () => Promise<void>;
}

export function startR2IngestStub(): R2IngestStub {
	const calls: R2StubCall[] = [];
	const stub: R2IngestStub = {
		baseUrl: "",
		calls,
		nextJobId: "00000000-0000-4000-8000-000000000001",
		commit: () => ({ kind: "completed" }),
		status: () => ({ kind: "completed" }),
		stop: async () => {
			await server.stop(true);
		},
	};
	const sessions = new Map<string, string>();
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			if (url.pathname.startsWith("/r2/")) {
				await request.arrayBuffer();
				return new Response(null, { headers: { etag: '"stub-etag"' } });
			}
			const input = readRpcInput(await request.text());
			calls.push({ pathname: url.pathname, input });
			if (url.pathname === "/rpc/ingest/init") {
				const jobId = stub.nextJobId;
				sessions.set(jobId, String(input.sessionId));
				const objects = Array.isArray(input.objects) ? input.objects : [];
				return rpc({
					expiresAt: new Date(Date.now() + 900_000).toISOString(),
					jobId,
					objects: objects.map((object, index) => {
						const record = isRecord(object) ? object : {};
						const byteLength = Number(record.byteLength);
						return {
							...record,
							objectKey: `ingest/${jobId}/${index}.jsonl`,
							parts: [
								{
									byteLength,
									headers: { "Content-Length": byteLength.toString() },
									partNumber: 1,
									uploadUrl: `${stub.baseUrl}/r2/${jobId}/${index}`,
								},
							],
							uploadId: `upload-${index}`,
						};
					}),
					partSizeBytes: 8 * 1024 * 1024,
					protocol: "r2_multipart_v1",
				});
			}
			const jobId = String(input.jobId);
			const result = {
				redacted: {},
				redactedBytes: 0,
				sessionId: sessions.get(jobId) ?? "unknown-session",
				success: true,
			};
			if (url.pathname === "/rpc/ingest/commit") {
				const answer = stub.commit(jobId);
				if (answer.kind === "completed")
					return rpc({
						jobId,
						protocol: "r2_multipart_v1",
						result,
						status: "completed",
					});
				return Response.json(
					{
						json: {
							code: "SERVICE_UNAVAILABLE",
							data: {
								queued: answer.queued,
								reason: answer.reason,
								retryAfterMs: 1_000,
							},
							defined: false,
							message: "Ingest job is waiting for its retry window",
							status: 503,
						},
					},
					{ status: 503 },
				);
			}
			if (url.pathname === "/rpc/ingest/status") {
				const answer = stub.status(jobId);
				if (answer.kind === "not-found" || answer.kind === "http-error") {
					const error =
						answer.kind === "not-found"
							? {
									code: "NOT_FOUND",
									message: "Ingest job not found",
									status: 404,
								}
							: answer;
					return Response.json(
						{
							json: {
								code: error.code,
								defined: false,
								message: error.message,
								status: error.status,
							},
						},
						{ status: error.status },
					);
				}
				return rpc({
					attempts: 1,
					availableAt: new Date().toISOString(),
					error:
						answer.kind === "failed"
							? { code: answer.code, message: answer.message }
							: (answer.kind === "pending" || answer.kind === "running") &&
									answer.errorCode
								? { code: answer.errorCode, message: "queued" }
								: null,
					jobId,
					leaseExpiresAt: null,
					protocol: "r2_multipart_v1",
					result:
						answer.kind === "completed"
							? {
									...result,
									sessionId: answer.sessionId ?? result.sessionId,
									...(answer.analysisId === undefined
										? {}
										: { analysisId: answer.analysisId }),
								}
							: null,
					status: answer.kind,
					updatedAt: new Date().toISOString(),
				});
			}
			return new Response("not found", { status: 404 });
		},
	});
	Object.assign(stub, { baseUrl: `http://127.0.0.1:${server.port}` });
	return stub;
}

function rpc(value: unknown): Response {
	return Response.json({ json: value });
}

function readRpcInput(body: string): Record<string, unknown> {
	if (!body) return {};
	const parsed: unknown = JSON.parse(body);
	return isRecord(parsed) && isRecord(parsed.json) ? parsed.json : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
