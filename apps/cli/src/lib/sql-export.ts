import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, extname } from "node:path";
import type { CliDataFormat } from "../contracts/cli-data.js";
import {
	type DataApi,
	DataExportError,
	formatBytes,
	formatRows,
	readChunks,
} from "./data-export.js";

export interface SqlResult {
	readonly path: string;
	readonly rows: number;
	readonly bytes: number;
	readonly notices: string[];
}

export function sqlFormatOf(path: string): CliDataFormat | null {
	const ext = extname(path).toLowerCase();
	return ext === ".jsonl" ? "jsonl" : ext === ".csv" ? "csv" : null;
}

export async function runSql(
	input: { query: string; out: string; workspace?: string },
	api: DataApi,
): Promise<SqlResult> {
	const format = sqlFormatOf(input.out);
	if (!format) throw new DataExportError("--out must end in .jsonl or .csv");
	await mkdir(dirname(input.out), { recursive: true });
	const partial = `${input.out}.partial`;
	const handle = await open(partial, "w");
	let bytes = 0;
	try {
		const done = await readChunks(
			await api.sql({
				...(input.workspace !== undefined
					? { workspace: input.workspace }
					: {}),
				query: input.query,
				format,
			}),
			async (text) => {
				const buffer = Buffer.from(text);
				await handle.write(buffer);
				bytes += buffer.length;
			},
		);
		await handle.close();
		await rename(partial, input.out);
		return { path: input.out, rows: done.rows, bytes, notices: done.notices };
	} catch (error) {
		await handle.close().catch(() => {});
		await rm(partial, { force: true });
		throw error;
	}
}

export function formatSqlSummary(result: SqlResult): string {
	return [
		`Wrote ${formatRows(result.rows)} (${formatBytes(result.bytes)}) to ${result.path}`,
		...result.notices,
	].join("\n");
}
