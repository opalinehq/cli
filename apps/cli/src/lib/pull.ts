import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import {
	type FileHandle,
	mkdir,
	open,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
	CLI_DATA_PLAN_MAX_SESSIONS,
	CLI_DATA_TABLE_MAX_SESSIONS,
	CLI_DATA_TABLES,
	type CliDataPullPlan,
	CliDataPullPlanOutputSchema,
	type CliDataPullPlanSession,
	type CliDataTable,
	type DataDone,
} from "../contracts/cli-data.js";
import {
	type DataApi,
	DataExportError,
	formatBytes,
	formatCount,
	formatRows,
	isRetryable,
	LineSplitter,
	lastPullPath,
	type Progress,
	readChunks,
} from "./data-export.js";

export const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;
export const DAY = /^\d{4}-\d{2}-\d{2}$/u;
export const PATTERN_ID = /^[a-z]{2}_[0-9a-f]{10}$/u;
export const RECORDS_BATCH_BYTES = 32 * 1024 * 1024;
export const RETRY_DELAYS_MS = [1_000, 4_000];

export const SESSION_FILES = "sessions/<session_id>.jsonl";

export const PULL_FILES: ReadonlyArray<{
	readonly file: string;
	readonly description: string;
}> = [
	{
		file: SESSION_FILES,
		description:
			"one object per stored record of the session's committed build, ordered by agent_id, record_idx, block_idx",
	},
	{ file: "runs.jsonl", description: "runs view rows (all columns)" },
	{ file: "calls.jsonl", description: "calls view rows" },
	{ file: "git.jsonl", description: "git_events view rows" },
	{
		file: "edges.jsonl",
		description:
			"edges of these sessions, and the GitHub edges of the commits/PRs they reach",
	},
	{
		file: "ci_jobs.jsonl",
		description: "ci_jobs of the CI runs these sessions and their edges reach",
	},
	{ file: "setup_files.jsonl", description: "setup_files view rows" },
	{
		file: "setup_texts.jsonl",
		description: "the whole text of each setup file version those rows name",
	},
	{
		file: "github_prs.jsonl",
		description: "GitHub's PR rows for the PRs these sessions reach",
	},
	{
		file: "github_pr_commits.jsonl",
		description: "GitHub's PR commit rows for those PRs and commits",
	},
	{
		file: "github_ci_run_prs.jsonl",
		description: "GitHub's CI-run-to-PR rows for those PRs",
	},
	{
		file: "github_ci_runs.jsonl",
		description: "GitHub's CI run rows for those PRs and commits",
	},
	{
		file: "github_sha_candidates.jsonl",
		description:
			"the full SHAs each abbreviated SHA these sessions name could be",
	},
	{
		file: "github_repositories.jsonl",
		description: "the workspace's connected GitHub repositories",
	},
	{
		file: "pattern.json",
		description:
			"with --pattern: the pattern as the server returned it (its row and evidence runs), its scope and its sessions",
	},
	{
		file: "MANIFEST.json",
		description:
			"scope, workspace, CLI version, rows and bytes of every file, what each file holds, notices",
	},
];

const DESCRIPTIONS = new Map(PULL_FILES.map((f) => [f.file, f.description]));

export function tableFile(table: Exclude<CliDataTable, "records">): string {
	return `${table}.jsonl`;
}

const dedupes = (table: CliDataTable) =>
	table === "ci_jobs" || table.startsWith("github_");

export interface PullOptions {
	readonly workspace?: string;
	readonly repo?: string;
	readonly from?: string;
	readonly to?: string;
	readonly sessions?: readonly string[];
	readonly sessionsFile?: string;
	readonly pattern?: string;
	readonly out?: string;
}

export interface PullEnv {
	readonly api: DataApi;
	readonly cacheRoot: string;
	readonly version: string;
	readonly progress: Progress;
	readonly now?: () => Date;
	readonly retryDelaysMs?: readonly number[];
	readonly recordsBatchBytes?: number;
	readonly sleep?: (ms: number) => Promise<void>;
}

export interface PulledFile {
	rows: number;
	bytes: number;
}

export interface PullResult {
	readonly dir: string;
	readonly plan: CliDataPullPlan;
	readonly sessions: number;
	readonly records: PulledFile & { files: number };
	readonly files: Record<string, PulledFile>;
	readonly notices: string[];
	readonly ms: number;
}

export function checkPullOptions(options: PullOptions): string | null {
	if (options.from !== undefined && !DAY.test(options.from))
		return "--from must be YYYY-MM-DD";
	if (options.to !== undefined && !DAY.test(options.to))
		return "--to must be YYYY-MM-DD";
	if (options.pattern !== undefined && options.sessions !== undefined)
		return "--pattern picks the sessions itself; leave out --sessions";
	if (options.pattern !== undefined && !PATTERN_ID.test(options.pattern))
		return "--pattern takes a pattern id from the patterns tool, e.g. fc_1a2b3c4d5e";
	if (
		options.pattern === undefined &&
		options.sessions === undefined &&
		options.repo === undefined &&
		options.from === undefined &&
		options.to === undefined
	)
		return "pull needs --sessions, --repo, --from/--to or --pattern. See 'opaline pull --help'.";
	if (
		options.sessions !== undefined &&
		options.sessions.length > CLI_DATA_PLAN_MAX_SESSIONS
	)
		return `pull takes at most ${formatCount(CLI_DATA_PLAN_MAX_SESSIONS)} sessions; ${options.sessionsFile ?? "--sessions"} names ${formatCount(options.sessions.length)}`;
	if (options.sessions?.length === 0)
		return `${options.sessionsFile ?? "--sessions"} names no sessions`;
	return null;
}

export function parseSessionList(raw: string, path: string): string[] {
	const text = raw.trim();
	let entries: unknown[];
	if (text.startsWith("[") || text.startsWith("{")) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch (error) {
			throw new DataExportError(
				`${path}: not valid JSON (${(error as Error).message})`,
			);
		}
		const list = Array.isArray(parsed)
			? parsed
			: typeof parsed === "object" &&
					parsed !== null &&
					Array.isArray((parsed as { sessions?: unknown }).sessions)
				? (parsed as { sessions: unknown[] }).sessions
				: null;
		if (!list)
			throw new DataExportError(
				`${path}: expected a JSON array or an object with a "sessions" array`,
			);
		entries = list;
	} else
		entries = text
			.split(/\r?\n/u)
			.map((line) => line.trim())
			.filter((line) => line !== "" && !line.startsWith("#"));
	const ids = entries.map((value) =>
		typeof value === "string"
			? value
			: typeof value === "object" && value !== null && "session_id" in value
				? String((value as { session_id: unknown }).session_id)
				: "",
	);
	const bad = ids.filter((id) => !SESSION_ID.test(id));
	if (bad.length)
		throw new DataExportError(
			`${path}: ${bad.length} entries are not session ids (first: ${JSON.stringify(bad[0])})`,
		);
	return [...new Set(ids)];
}

export function readSessionFile(path: string): string[] {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		throw new DataExportError(
			`cannot read ${path}: ${(error as Error).message}`,
		);
	}
	return parseSessionList(raw, path);
}

export function batchSessions(
	sessions: readonly CliDataPullPlanSession[],
	maxBytes: number,
	maxSessions = CLI_DATA_TABLE_MAX_SESSIONS,
): CliDataPullPlanSession[][] {
	const batches: CliDataPullPlanSession[][] = [];
	let current: CliDataPullPlanSession[] = [];
	let bytes = 0;
	for (const session of sessions) {
		if (
			current.length > 0 &&
			(bytes + session.bytes > maxBytes || current.length >= maxSessions)
		) {
			batches.push(current);
			current = [];
			bytes = 0;
		}
		current.push(session);
		bytes += session.bytes;
	}
	if (current.length) batches.push(current);
	return batches;
}

const safeName = (value: string) =>
	value.replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/^[.-]+/u, "");

export function defaultPullDir(
	root: string,
	plan: CliDataPullPlan,
	options: Pick<PullOptions, "repo" | "from" | "to" | "pattern">,
): string {
	const repository = plan.scope.repository ?? options.repo;
	const repo =
		(repository &&
			safeName(
				repository
					.replace(/[/\\]+$/u, "")
					.split(/[/\\]/u)
					.pop() ?? "",
			)) ||
		"sessions";
	const from = safeName(plan.scope.from ?? options.from ?? "") || "all";
	const to = safeName(plan.scope.to ?? options.to ?? "") || "all";
	const pattern = options.pattern ? `_${safeName(options.pattern)}` : "";
	return join(
		root,
		"pulls",
		safeName(plan.workspace.slug) || plan.workspace.id,
		`${repo}_${from}_${to}${pattern}`,
	);
}

function isEarlierPull(dir: string): boolean {
	if (!existsSync(dir)) return true;
	if (readdirSync(dir).length === 0) return true;
	return (
		existsSync(join(dir, "MANIFEST.json")) || existsSync(join(dir, "sessions"))
	);
}

const nonce = () => `${process.pid}-${randomBytes(4).toString("hex")}`;

function isRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

async function removeAbandoned(target: string): Promise<void> {
	const parent = dirname(target);
	for (const prefix of [".partial-", ".old-"].map(
		(kind) => `.${basename(target)}${kind}`,
	))
		for (const name of readdirSync(parent)) {
			if (!name.startsWith(prefix)) continue;
			const pid = Number(name.slice(prefix.length).split("-")[0]);
			if (Number.isInteger(pid) && pid > 0 && !isRunning(pid))
				await rm(join(parent, name), { recursive: true, force: true });
		}
}

async function swapIn(built: string, target: string): Promise<void> {
	if (!existsSync(target)) {
		await rename(built, target);
		return;
	}
	const old = join(dirname(target), `.${basename(target)}.old-${nonce()}`);
	await rename(target, old);
	try {
		await rename(built, target);
	} catch (error) {
		await rename(old, target);
		throw error;
	}
	await rm(old, { recursive: true, force: true });
}

async function writeAtomic(path: string, text: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temp = `${path}.${nonce()}.tmp`;
	await writeFile(temp, text);
	await rename(temp, path);
}

class TableWriter {
	private position = 0;
	rows = 0;

	private constructor(private readonly handle: FileHandle) {}

	static async create(path: string): Promise<TableWriter> {
		return new TableWriter(await open(path, "w"));
	}

	get bytes(): number {
		return this.position;
	}

	mark(): { position: number; rows: number } {
		return { position: this.position, rows: this.rows };
	}

	async write(text: string, rows: number): Promise<void> {
		if (text === "") return;
		const buffer = Buffer.from(text);
		await this.handle.write(buffer, 0, buffer.length, this.position);
		this.position += buffer.length;
		this.rows += rows;
	}

	async rollback(mark: { position: number; rows: number }): Promise<void> {
		await this.handle.truncate(mark.position);
		this.position = mark.position;
		this.rows = mark.rows;
	}

	close(): Promise<void> {
		return this.handle.close();
	}
}

class SessionFiles {
	private current: { id: string; handle: FileHandle } | null = null;
	private readonly opened = new Set<string>();
	readonly stats = new Map<string, PulledFile>();

	constructor(private readonly dir: string) {}

	async write(id: string, text: string, rows: number): Promise<void> {
		if (this.current?.id !== id) {
			await this.close();
			const flag = this.opened.has(id) ? "a" : "w";
			this.opened.add(id);
			this.current = { id, handle: await open(this.pathOf(id), flag) };
		}
		const buffer = Buffer.from(text);
		await this.current.handle.write(buffer);
		const stat = this.stats.get(id) ?? { rows: 0, bytes: 0 };
		stat.rows += rows;
		stat.bytes += buffer.length;
		this.stats.set(id, stat);
	}

	async close(): Promise<void> {
		const current = this.current;
		this.current = null;
		if (current) await current.handle.close();
	}

	async discard(ids: Iterable<string>): Promise<void> {
		await this.close();
		for (const id of ids) {
			this.stats.delete(id);
			this.opened.delete(id);
			await rm(this.pathOf(id), { force: true });
		}
	}

	private pathOf(id: string): string {
		return join(this.dir, `${id}.jsonl`);
	}
}

const SESSION_PREFIX = /^\{\s*"session_id"\s*:\s*"((?:[^"\\]|\\.)*)"/u;

function sessionIdOf(line: string): string {
	const prefix = SESSION_PREFIX.exec(line);
	let id: unknown;
	if (prefix) id = JSON.parse(`"${prefix[1]}"`);
	else {
		try {
			id = (JSON.parse(line) as { session_id?: unknown }).session_id;
		} catch {
			throw new DataExportError(
				`The server sent a records line that is not JSON: ${line.slice(0, 120)}`,
			);
		}
	}
	if (typeof id !== "string" || !SESSION_ID.test(id))
		throw new DataExportError(
			`The server sent a records line without a usable session_id: ${line.slice(0, 120)}`,
		);
	return id;
}

async function withRetry<T>(
	label: string,
	run: () => Promise<T>,
	env: PullEnv,
): Promise<T> {
	const delays = env.retryDelaysMs ?? RETRY_DELAYS_MS;
	const sleep =
		env.sleep ??
		((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
	for (let attempt = 0; ; attempt++) {
		try {
			return await run();
		} catch (error) {
			const delay = delays[attempt];
			if (delay === undefined || !isRetryable(error)) throw error;
			env.progress.warn(
				`${label} failed (${error instanceof Error ? error.message : String(error)}); retrying in ${Math.round(delay / 1000)} s`,
			);
			await sleep(delay);
		}
	}
}

function noticesOf(table: CliDataTable, done: DataDone, into: Set<string>) {
	for (const notice of done.notices)
		into.add(notice.startsWith(`${table}:`) ? notice : `${table}: ${notice}`);
}

export async function runPull(
	options: PullOptions,
	env: PullEnv,
): Promise<PullResult> {
	const started = performance.now();
	const now = env.now ?? (() => new Date());
	env.progress.update("Planning the pull…");
	const rawPlan = await env.api.pullPlan({
		...(options.workspace !== undefined
			? { workspace: options.workspace }
			: {}),
		...(options.repo !== undefined ? { repository: options.repo } : {}),
		...(options.from !== undefined ? { from: options.from } : {}),
		...(options.to !== undefined ? { to: options.to } : {}),
		...(options.sessions !== undefined
			? { sessions: [...options.sessions] }
			: {}),
		...(options.pattern !== undefined ? { pattern: options.pattern } : {}),
	});
	const parsedPlan = CliDataPullPlanOutputSchema.safeParse(rawPlan);
	if (!parsedPlan.success)
		throw new DataExportError(
			"The server sent a pull plan this CLI cannot read.",
		);
	const plan = parsedPlan.data;
	if (plan.sessions.length === 0)
		throw new DataExportError(
			[
				`No sessions selected${options.repo ? " (repositories are keyed like github.com/owner/name)" : ""}.`,
				...plan.notices,
			].join(" "),
		);
	for (const session of plan.sessions)
		if (!SESSION_ID.test(session.sessionId))
			throw new DataExportError(
				`The server planned a session id that cannot be a file name: ${JSON.stringify(session.sessionId)}`,
			);

	const target = options.out ?? defaultPullDir(env.cacheRoot, plan, options);
	if (!isEarlierPull(target))
		throw new DataExportError(
			`${target} exists and is not an earlier pull; choose an empty or new directory`,
		);
	await mkdir(dirname(target), { recursive: true });
	await removeAbandoned(target);
	const build = join(
		dirname(target),
		`.${basename(target)}.partial-${nonce()}`,
	);
	const workspace = plan.workspace.id;
	const notices = new Set(plan.notices);
	const files: Record<string, PulledFile> = {};
	const sessionFiles = new SessionFiles(join(build, "sessions"));
	try {
		await mkdir(join(build, "sessions"), { recursive: true });

		const recordBatches = batchSessions(
			plan.sessions,
			env.recordsBatchBytes ?? RECORDS_BATCH_BYTES,
		);
		for (const [index, batch] of recordBatches.entries()) {
			const ids = batch.map((s) => s.sessionId);
			const planned = batch.reduce((sum, s) => sum + s.bytes, 0);
			const label = `records batch ${index + 1}/${recordBatches.length}`;
			env.progress.update(
				`Pulling records: batch ${index + 1}/${recordBatches.length} (${batch.length} sessions, ${formatBytes(planned)})`,
			);
			const done = await withRetry(
				label,
				async () => {
					const before = new Set(sessionFiles.stats.keys());
					const splitter = new LineSplitter();
					const take = async (lines: string[]) => {
						let group: { id: string; text: string; rows: number } | null = null;
						for (const line of lines) {
							if (line === "") continue;
							const id = sessionIdOf(line);
							if (group && group.id !== id) {
								await sessionFiles.write(group.id, group.text, group.rows);
								group = null;
							}
							group ??= { id, text: "", rows: 0 };
							group.text += `${line}\n`;
							group.rows++;
						}
						if (group)
							await sessionFiles.write(group.id, group.text, group.rows);
					};
					try {
						const result = await readChunks(
							await env.api.pullTable({
								workspace,
								table: "records",
								sessions: ids,
							}),
							(text) => take(splitter.push(text)),
						);
						await take(splitter.end());
						await sessionFiles.close();
						return result;
					} catch (error) {
						await sessionFiles.discard(
							new Set([
								...ids,
								...[...sessionFiles.stats.keys()].filter(
									(id) => !before.has(id),
								),
							]),
						);
						throw error;
					}
				},
				env,
			);
			noticesOf("records", done, notices);
		}

		const sessionIds = plan.sessions.map((s) => s.sessionId);
		const tableBatches: string[][] = [];
		for (let i = 0; i < sessionIds.length; i += CLI_DATA_TABLE_MAX_SESSIONS)
			tableBatches.push(sessionIds.slice(i, i + CLI_DATA_TABLE_MAX_SESSIONS));
		for (const table of CLI_DATA_TABLES) {
			if (table === "records") continue;
			const file = tableFile(table);
			const writer = await TableWriter.create(join(build, file));
			const seen = dedupes(table) ? new Set<string>() : null;
			try {
				for (const [index, batch] of tableBatches.entries()) {
					env.progress.update(
						`Pulling ${table}${tableBatches.length > 1 ? `: batch ${index + 1}/${tableBatches.length}` : ""}`,
					);
					const done = await withRetry(
						`${table} batch ${index + 1}/${tableBatches.length}`,
						async () => {
							const mark = writer.mark();
							const added: string[] = [];
							const splitter = new LineSplitter();
							const take = async (lines: string[]) => {
								let text = "";
								let rows = 0;
								for (const line of lines) {
									if (line === "") continue;
									if (seen) {
										if (seen.has(line)) continue;
										seen.add(line);
										added.push(line);
									}
									text += `${line}\n`;
									rows++;
								}
								await writer.write(text, rows);
							};
							try {
								const result = await readChunks(
									await env.api.pullTable({
										workspace,
										table,
										sessions: batch,
									}),
									(text) => take(splitter.push(text)),
								);
								await take(splitter.end());
								return result;
							} catch (error) {
								await writer.rollback(mark);
								for (const line of added) seen?.delete(line);
								throw error;
							}
						},
						env,
					);
					noticesOf(table, done, notices);
				}
			} finally {
				await writer.close();
			}
			files[file] = { rows: writer.rows, bytes: writer.bytes };
		}

		const scope = {
			repository: plan.scope.repository ?? options.repo ?? null,
			from: plan.scope.from ?? options.from ?? null,
			to: plan.scope.to ?? options.to ?? null,
		};
		if (options.pattern !== undefined) {
			const text = `${JSON.stringify(
				plan.pattern ?? { id: options.pattern, scope, sessions: sessionIds },
				null,
				1,
			)}\n`;
			await writeFile(join(build, "pattern.json"), text);
			files["pattern.json"] = { rows: 1, bytes: Buffer.byteLength(text) };
		}

		const records = { files: 0, rows: 0, bytes: 0 };
		for (const stat of sessionFiles.stats.values()) {
			records.files++;
			records.rows += stat.rows;
			records.bytes += stat.bytes;
		}
		const differing = plan.sessions.filter(
			(s) => (sessionFiles.stats.get(s.sessionId)?.rows ?? 0) !== s.records,
		);
		if (differing.length) {
			const first = differing[0] as CliDataPullPlanSession;
			notices.add(
				`records: ${differing.length} sessions returned a different number of records than planned (first: ${first.sessionId}, planned ${first.records}, got ${sessionFiles.stats.get(first.sessionId)?.rows ?? 0})`,
			);
		}

		const manifest = {
			created_at: now().toISOString(),
			cli_version: env.version,
			workspace: plan.workspace,
			scope,
			selection: {
				repo: options.repo ?? null,
				from: options.from ?? null,
				to: options.to ?? null,
				sessions_file: options.sessionsFile ?? null,
				sessions_requested: options.sessions?.length ?? null,
				pattern: options.pattern ?? null,
			},
			counts: {
				sessions: plan.sessions.length,
				sessions_with_records: records.files,
				records: records.rows,
				bytes:
					records.bytes +
					Object.values(files).reduce((sum, f) => sum + f.bytes, 0),
			},
			files: {
				[SESSION_FILES]: {
					files: records.files,
					rows: records.rows,
					bytes: records.bytes,
					description: DESCRIPTIONS.get(SESSION_FILES),
				},
				...Object.fromEntries(
					Object.entries(files).map(([name, stat]) => [
						name,
						{ ...stat, description: DESCRIPTIONS.get(name) },
					]),
				),
				"MANIFEST.json": { description: DESCRIPTIONS.get("MANIFEST.json") },
			},
			sessions: plan.sessions.map((s) => ({
				session_id: s.sessionId,
				source: s.source,
				started_at: s.startedAt,
				rows: sessionFiles.stats.get(s.sessionId)?.rows ?? 0,
				bytes: sessionFiles.stats.get(s.sessionId)?.bytes ?? 0,
				planned_records: s.records,
				planned_bytes: s.bytes,
			})),
			notices: [...notices],
		};
		await writeFile(
			join(build, "MANIFEST.json"),
			`${JSON.stringify(manifest, null, 1)}\n`,
		);
		env.progress.update("Replacing the pull directory…");
		await swapIn(build, target);
		await writeAtomic(lastPullPath(env.cacheRoot), `${target}\n`);
		env.progress.stop();
		return {
			dir: target,
			plan,
			sessions: plan.sessions.length,
			records,
			files,
			notices: [...notices],
			ms: Math.round(performance.now() - started),
		};
	} catch (error) {
		env.progress.stop();
		await sessionFiles.close().catch(() => {});
		await rm(build, { recursive: true, force: true });
		throw error;
	}
}

export function formatPullSummary(result: PullResult): string {
	const rows: Array<[string, string]> = [
		[
			SESSION_FILES,
			`${formatCount(result.records.files)} files, ${formatRows(result.records.rows)}, ${formatBytes(result.records.bytes)}`,
		],
		...Object.entries(result.files).map(([name, stat]): [string, string] => [
			name,
			name === "pattern.json"
				? formatBytes(stat.bytes)
				: `${formatRows(stat.rows)}, ${formatBytes(stat.bytes)}`,
		]),
		["MANIFEST.json", "what every file holds, rows, bytes and notices"],
	];
	const width = Math.max(...rows.map(([name]) => name.length));
	const total =
		result.records.bytes +
		Object.values(result.files).reduce((sum, f) => sum + f.bytes, 0);
	return [
		`Pulled ${formatCount(result.sessions)} sessions (${formatCount(result.records.rows)} records, ${formatBytes(total)}) from ${result.plan.workspace.slug} in ${(result.ms / 1000).toFixed(1)} s`,
		...rows.map(([name, detail]) => `  ${name.padEnd(width)}  ${detail}`),
		...(result.notices.length
			? ["Notices:", ...result.notices.map((notice) => `  - ${notice}`)]
			: []),
		result.dir,
	].join("\n");
}
