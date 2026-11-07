import { homedir } from "node:os";
import { join, resolve } from "node:path";
import * as p from "@clack/prompts";
import { ORPCError } from "@orpc/client";
import {
	type CliDataPullPlanInput,
	type CliDataPullTableInput,
	type CliDataSqlInput,
	DataChunkSchema,
	type DataDone,
} from "../contracts/cli-data.js";
import { describeSavedCredentialsApiBaseRisk } from "./api-base.js";
import { createApiClient } from "./api-client.js";
import { getApiBaseOverride } from "./api-target.js";
import { loadCredentials } from "./credentials.js";

export interface DataApi {
	sql(input: CliDataSqlInput): Promise<AsyncIterable<unknown>>;
	pullPlan(input: CliDataPullPlanInput): Promise<unknown>;
	pullTable(input: CliDataPullTableInput): Promise<AsyncIterable<unknown>>;
}

export interface CapabilityClient {
	cli: {
		authStatus(
			input?: undefined,
			options?: { signal?: AbortSignal },
		): Promise<{ capabilities?: { dataExport?: true } }>;
	};
}

export class DataExportError extends Error {
	constructor(
		message: string,
		readonly retryable = false,
	) {
		super(message);
		this.name = "DataExportError";
	}
}

export function cacheRoot(): string {
	return join(homedir(), ".cache", "opaline");
}

export function lastPullPath(root: string): string {
	return join(root, "pulls", "LAST");
}

export function callerPath(path: string, cwd: string): string {
	return resolve(cwd, path.replace(/^~(?=$|[/\\])/u, homedir()));
}

export async function checkDataExport(
	client: CapabilityClient,
	apiBase: string,
): Promise<undefined | Error> {
	try {
		const status = await client.cli.authStatus(undefined, {
			signal: AbortSignal.timeout(15_000),
		});
		if (status.capabilities?.dataExport === true) return undefined;
		return new Error(
			`The Opaline server at ${apiBase} does not support data export yet.`,
		);
	} catch (error) {
		return new Error(describeDataError(error, apiBase));
	}
}

export async function connectDataApi(): Promise<DataApi | Error> {
	const credentials = loadCredentials();
	if (!credentials)
		return new Error("Not logged in. Run `opaline login` first.");
	const risk = describeSavedCredentialsApiBaseRisk();
	if (risk) p.log.warn(risk, { output: process.stderr });
	const apiBase = getApiBaseOverride() ?? credentials.apiBaseUrl;
	const client = createApiClient({
		apiBaseUrl: apiBase,
		token: credentials.token,
		authType: credentials.authType,
	});
	const unsupported = await checkDataExport(client, apiBase);
	if (unsupported) return unsupported;
	return withErrorContext(client.cli.data, apiBase);
}

export function withErrorContext(api: DataApi, apiBase: string): DataApi {
	const wrap =
		<I, O>(call: (input: I) => Promise<O>) =>
		async (input: I) => {
			try {
				return await call(input);
			} catch (error) {
				throw toDataExportError(error, apiBase);
			}
		};
	return {
		sql: wrap(async (input) => guard(await api.sql(input), apiBase)),
		pullPlan: wrap((input) => api.pullPlan(input)),
		pullTable: wrap(async (input) =>
			guard(await api.pullTable(input), apiBase),
		),
	};
}

async function* guard(
	chunks: AsyncIterable<unknown>,
	apiBase: string,
): AsyncGenerator<unknown> {
	try {
		for await (const chunk of chunks) yield chunk;
	} catch (error) {
		throw toDataExportError(error, apiBase);
	}
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function isRetryable(error: unknown): boolean {
	if (error instanceof DataExportError) return error.retryable;
	if (error instanceof ORPCError)
		return error.status >= 500 || error.status === 408;
	return true;
}

export function toDataExportError(
	error: unknown,
	apiBase: string,
): DataExportError {
	if (error instanceof DataExportError) return error;
	return new DataExportError(
		describeDataError(error, apiBase),
		isRetryable(error),
	);
}

export function describeDataError(error: unknown, apiBase: string): string {
	if (error instanceof DataExportError) return error.message;
	if (error instanceof ORPCError) {
		if (error.status === 401)
			return "Session expired or invalid. Run `opaline login` to re-authenticate.";
		return error.message || String(error.code);
	}
	const message = error instanceof Error ? error.message : String(error);
	return `Could not reach ${apiBase}: ${message}`;
}

export async function readChunks(
	chunks: AsyncIterable<unknown>,
	onText: (text: string) => void | Promise<void>,
): Promise<DataDone> {
	for await (const raw of chunks) {
		const parsed = DataChunkSchema.safeParse(raw);
		if (!parsed.success)
			throw new DataExportError(
				"The server sent a chunk this CLI cannot read.",
			);
		if (parsed.data.type === "done") return parsed.data;
		await onText(parsed.data.text);
	}
	throw new DataExportError(
		"The server ended the export before it finished.",
		true,
	);
}

export class LineSplitter {
	private rest = "";

	push(text: string): string[] {
		const joined = this.rest + text;
		const lines = joined.split("\n");
		this.rest = lines.pop() ?? "";
		return lines.map((line) =>
			line.endsWith("\r") ? line.slice(0, -1) : line,
		);
	}

	end(): string[] {
		const rest = this.rest;
		this.rest = "";
		return rest === "" ? [] : [rest];
	}
}

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

export function formatCount(value: number): string {
	return value.toLocaleString("en-US");
}

export function formatRows(rows: number): string {
	return `${formatCount(rows)} ${rows === 1 ? "row" : "rows"}`;
}

export interface Progress {
	update(message: string): void;
	warn(message: string): void;
	stop(): void;
}

export function createProgress(
	stream: NodeJS.WriteStream = process.stderr,
): Progress {
	if (!stream.isTTY)
		return {
			update: (message) => stream.write(`${message}\n`),
			warn: (message) => stream.write(`warning: ${message}\n`),
			stop: () => {},
		};
	const spin = p.spinner({ output: stream });
	let running = false;
	return {
		update(message) {
			if (running) spin.message(message);
			else spin.start(message);
			running = true;
		},
		warn(message) {
			if (running) spin.clear();
			running = false;
			p.log.warn(message, { output: stream });
		},
		stop() {
			if (running) spin.clear();
			running = false;
		},
	};
}
