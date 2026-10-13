import { createHash } from "node:crypto";

/**
 * In-memory stand-in for the live session endpoints. It implements the
 * protocol's append rules (reset, append, already-committed, out-of-sync)
 * so follower tests can assert continuity, not just request shapes.
 */

export interface LiveStubAppendStream {
	readonly agentId: string | null;
	readonly reset?: boolean;
	readonly startLine: number;
	readonly previousLineSha256: string | null;
	readonly lines: string[];
}

export interface LiveStubAppend {
	readonly organizationId: string;
	readonly sessionId: string;
	readonly projectPath: string;
	readonly gitRemote?: string;
	readonly gitBranch?: string;
	readonly ended?: boolean;
	readonly streams: LiveStubAppendStream[];
}

export interface LiveStubStream {
	generation: number;
	lines: string[];
}

export interface LiveSessionStub {
	readonly base: string;
	readonly paths: string[];
	readonly appends: LiveStubAppend[];
	readonly streams: Map<string, LiveStubStream>;
	readonly statusCounts: Record<string, number>;
	ended: boolean;
	stop(): void;
}

export interface LiveSessionStubOptions {
	/** Defaults to true. */
	readonly liveSessions?: boolean;
	/**
	 * Override a response before the default handling, or apply an append
	 * and then answer 502 as if the response were lost.
	 */
	readonly intercept?: (info: {
		readonly pathname: string;
		readonly index: number;
		readonly body: unknown;
	}) => Response | "commit-then-fail" | undefined;
}

export function sha256(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

export function orpcError(
	status: number,
	code: string,
	data?: unknown,
): Response {
	return Response.json(
		{
			json: {
				code,
				data,
				defined: true,
				message: code,
				status,
			},
		},
		{ status },
	);
}

export function startLiveSessionStub(
	options: LiveSessionStubOptions = {},
): LiveSessionStub {
	const stub: Omit<LiveSessionStub, "base" | "stop"> = {
		appends: [],
		ended: false,
		paths: [],
		statusCounts: {},
		streams: new Map(),
	};
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const pathname = new URL(request.url).pathname;
			const index = stub.paths.length;
			stub.paths.push(pathname);
			const text = await request.text();
			const body: unknown = text ? JSON.parse(text).json : undefined;
			const intercepted = options.intercept?.({ body, index, pathname });
			if (intercepted instanceof Response) return intercepted;
			if (pathname === "/rpc/cli/authStatus")
				return Response.json({
					json: {
						capabilities:
							options.liveSessions === false ? {} : { liveSessions: true },
						email: "user@example.invalid",
						id: "user-1",
						name: "User",
					},
				});
			if (pathname === "/rpc/liveSession/state")
				return Response.json({
					json: {
						ended: stub.ended,
						streams: [...stub.streams.entries()]
							.sort(([left], [right]) =>
								left === "" ? -1 : right === "" ? 1 : left < right ? -1 : 1,
							)
							.map(([key, stream]) => ({
								agentId: key === "" ? null : key,
								committedLines: stream.lines.length,
								lastLineSha256: lastSha(stream),
							})),
					},
				});
			if (pathname === "/rpc/liveSession/append") {
				const input = body as LiveStubAppend;
				stub.appends.push(input);
				const result = applyAppend(stub, input);
				if (result instanceof Response) return result;
				if (intercepted === "commit-then-fail")
					return new Response("bad gateway", { status: 502 });
				return Response.json({ json: { streams: result } });
			}
			return new Response("not found", { status: 404 });
		},
	});
	return Object.assign(stub, {
		base: `http://127.0.0.1:${server.port}`,
		stop: () => server.stop(true),
	});
}

function lastSha(stream: LiveStubStream): string | null {
	const last = stream.lines.at(-1);
	return last === undefined ? null : sha256(last);
}

function applyAppend(
	stub: Omit<LiveSessionStub, "base" | "stop">,
	input: LiveStubAppend,
) {
	const seen = new Set<string>();
	let totalBytes = 0;
	for (const stream of input.streams) {
		const key = stream.agentId ?? "";
		if (seen.has(key)) return orpcError(400, "BAD_REQUEST");
		seen.add(key);
		for (const line of stream.lines) {
			if (line.includes("\n")) return orpcError(400, "BAD_REQUEST");
			const bytes = Buffer.byteLength(line, "utf8");
			if (bytes > 1_048_576) return orpcError(400, "BAD_REQUEST");
			totalBytes += bytes;
		}
		if (
			stream.reset &&
			(stream.startLine !== 0 || stream.previousLineSha256 !== null)
		)
			return orpcError(400, "BAD_REQUEST");
	}
	if (totalBytes > 1_572_864) return orpcError(400, "BAD_REQUEST");
	const results = input.streams.map((append) => {
		const key = append.agentId ?? "";
		let stream = stub.streams.get(key);
		if (!stream) {
			stream = { generation: 0, lines: [] };
			stub.streams.set(key, stream);
		}
		if (append.reset) {
			stream.generation += 1;
			stream.lines = [];
		}
		const committed = stream.lines.length;
		const sha = lastSha(stream);
		let status: "appended" | "already-committed" | "out-of-sync";
		if (append.startLine === committed && append.previousLineSha256 === sha) {
			stream.lines.push(...append.lines);
			status = append.lines.length > 0 ? "appended" : "already-committed";
		} else if (
			append.lines.length > 0 &&
			append.startLine + append.lines.length === committed &&
			sha256(append.lines.at(-1) as string) === sha
		) {
			status = "already-committed";
		} else {
			status = "out-of-sync";
		}
		stub.statusCounts[status] = (stub.statusCounts[status] ?? 0) + 1;
		return {
			agentId: append.agentId,
			committedLines: stream.lines.length,
			lastLineSha256: lastSha(stream),
			status,
		};
	});
	if (input.streams.some((stream) => stream.lines.length > 0))
		stub.ended = false;
	if (input.ended) stub.ended = true;
	return results;
}
