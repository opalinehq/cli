import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";

/**
 * The parent process at CLI start-up. Read when the bundle loads, before any
 * asynchronous work: a short-lived parent (for example `codex exec`, which
 * may exit right after spawning its notify command) can be gone moments
 * later, and the process is then re-parented.
 */
export const STARTUP_PARENT_PID = process.ppid;

const MAX_PID = 2_147_483_647;

export function isValidPid(value: unknown): value is number {
	return (
		typeof value === "number" &&
		Number.isSafeInteger(value) &&
		value > 1 &&
		value <= MAX_PID
	);
}

/**
 * Process start identities tell a reused PID apart from the process that
 * registered it. Linux: start time in clock ticks since boot from
 * `/proc/<pid>/stat` (immune to wall-clock steps). macOS: `ps -o lstart` in
 * UTC, compared with a small tolerance (see `isSameStartIdentity`). Anything
 * else, or a `ps` without `lstart` (for example BusyBox), yields no identity:
 * callers then rely on `kill(pid, 0)` alone and never treat a missing
 * identity as a dead process.
 */
export async function readProcessStartIdentities(
	pids: readonly number[],
	timeoutMs = 2_000,
): Promise<Map<number, string>> {
	const identities = new Map<number, string>();
	const unique = [...new Set(pids)].filter(isValidPid);
	if (unique.length === 0) return identities;
	if (process.platform === "linux") {
		await Promise.all(
			unique.map(async (pid) => {
				try {
					const stat = parseProcStat(
						await readFile(`/proc/${pid}/stat`, "utf8"),
					);
					if (stat) identities.set(pid, `linux:${stat.startTime}`);
				} catch {
					// Gone, or not readable.
				}
			}),
		);
		return identities;
	}
	if (process.platform !== "darwin") return identities;
	const output = await runPs(
		["-o", "pid=,lstart=", "-p", unique.join(",")],
		timeoutMs,
	);
	for (const line of output?.split("\n") ?? []) {
		const match = /^\s*(\d+)\s+(\S.*\S)\s*$/u.exec(line);
		const identity = match?.[2] ? darwinIdentity(match[2]) : undefined;
		if (match?.[1] && identity) identities.set(Number(match[1]), identity);
	}
	return identities;
}

/** The start identity of a process, synchronously; Linux only (cheap). */
export function readLinuxStartIdentitySync(pid: number): string | null {
	if (process.platform !== "linux" || !isValidPid(pid)) return null;
	try {
		const stat = parseProcStat(readFileSync(`/proc/${pid}/stat`, "utf8"));
		return stat ? `linux:${stat.startTime}` : null;
	} catch {
		return null;
	}
}

/**
 * macOS identities are start times in whole seconds from `ps`, which may be
 * one second apart between calls; Linux identities are exact.
 */
export function isSameStartIdentity(left: string, right: string): boolean {
	if (left === right) return true;
	const a = /^darwin:(\d+)$/u.exec(left)?.[1];
	const b = /^darwin:(\d+)$/u.exec(right)?.[1];
	return (
		a !== undefined && b !== undefined && Math.abs(Number(a) - Number(b)) <= 2
	);
}

export type AncestorLookup =
	| {
			readonly kind: "found";
			readonly pid: number;
			readonly identity: string | null;
	  }
	| { readonly kind: "exited" }
	| { readonly kind: "unknown" };

/**
 * Looks for the nearest ancestor (from `parentPid` up) whose executable
 * basename satisfies `matches`. `exited` when the process that started this
 * one is already gone; `unknown` when no matching ancestor is found or the
 * platform cannot tell. Bounded: one `ps` call (macOS, `timeoutMs`) or
 * `/proc` reads (Linux).
 */
export async function findAncestorProcess(
	matches: (executableName: string) => boolean,
	parentPid: number = STARTUP_PARENT_PID,
	timeoutMs = 500,
): Promise<AncestorLookup> {
	if (!isValidPid(parentPid)) return { kind: "exited" };
	let table: Map<number, ProcessEntry> | undefined;
	if (process.platform === "linux") table = undefined;
	else if (process.platform === "darwin") {
		table = await readDarwinProcessTable(timeoutMs);
		if (!table) return { kind: "unknown" };
	} else return { kind: "unknown" };
	const lookup = (pid: number): ProcessEntry | undefined =>
		table ? table.get(pid) : readLinuxProcessEntry(pid);
	let pid = parentPid;
	for (let depth = 0; depth < 16; depth += 1) {
		// Re-parented to init (or a subreaper's root): the process that started
		// this one is gone.
		if (!isValidPid(pid)) return { kind: "exited" };
		const entry = lookup(pid);
		if (!entry) return depth === 0 ? { kind: "exited" } : { kind: "unknown" };
		if (matches(basename(entry.name)))
			return { identity: entry.identity, kind: "found", pid };
		pid = entry.ppid;
	}
	return { kind: "unknown" };
}

interface ProcessEntry {
	readonly ppid: number;
	readonly name: string;
	readonly identity: string | null;
}

interface ProcStat {
	readonly comm: string;
	readonly ppid: number;
	readonly startTime: string;
}

/** Parses `/proc/<pid>/stat`; `comm` may itself contain spaces and parentheses. */
export function parseProcStat(text: string): ProcStat | null {
	const open = text.indexOf("(");
	const close = text.lastIndexOf(")");
	if (open < 0 || close < open) return null;
	const fields = text
		.slice(close + 1)
		.trim()
		.split(/\s+/u);
	// fields[0] is field 3 (state): ppid is field 4, starttime field 22.
	const ppid = Number(fields[1]);
	const startTime = fields[19];
	if (!Number.isSafeInteger(ppid) || !startTime || !/^\d+$/u.test(startTime))
		return null;
	return { comm: text.slice(open + 1, close), ppid, startTime };
}

/** `ps -o lstart` text (`LC_ALL=C TZ=UTC`) as `darwin:<epoch seconds>`. */
export function darwinIdentity(lstart: string): string | undefined {
	const match =
		/^[A-Z][a-z]{2}\s+([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})$/u.exec(
			lstart.trim(),
		);
	if (!match) return undefined;
	const month = MONTHS.indexOf(match[1] as string);
	if (month < 0) return undefined;
	const seconds =
		Date.UTC(
			Number(match[6]),
			month,
			Number(match[2]),
			Number(match[3]),
			Number(match[4]),
			Number(match[5]),
		) / 1_000;
	return Number.isFinite(seconds) ? `darwin:${seconds}` : undefined;
}

const MONTHS = [
	"Jan",
	"Feb",
	"Mar",
	"Apr",
	"May",
	"Jun",
	"Jul",
	"Aug",
	"Sep",
	"Oct",
	"Nov",
	"Dec",
];

function readLinuxProcessEntry(pid: number): ProcessEntry | undefined {
	try {
		const stat = parseProcStat(readFileSync(`/proc/${pid}/stat`, "utf8"));
		return stat
			? {
					identity: `linux:${stat.startTime}`,
					name: stat.comm,
					ppid: stat.ppid,
				}
			: undefined;
	} catch {
		return undefined;
	}
}

async function readDarwinProcessTable(
	timeoutMs: number,
): Promise<Map<number, ProcessEntry> | undefined> {
	const output = await runPs(
		["-A", "-o", "pid=,ppid=,lstart=,comm="],
		timeoutMs,
	);
	if (!output) return undefined;
	const table = new Map<number, ProcessEntry>();
	for (const line of output.split("\n")) {
		const tokens = line.trim().split(/\s+/u);
		if (tokens.length < 8) continue;
		const pid = Number(tokens[0]);
		const ppid = Number(tokens[1]);
		if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(ppid)) continue;
		table.set(pid, {
			identity: darwinIdentity(tokens.slice(2, 7).join(" ")) ?? null,
			name: tokens.slice(7).join(" "),
			ppid,
		});
	}
	return table;
}

function runPs(
	args: readonly string[],
	timeoutMs: number,
): Promise<string | undefined> {
	return new Promise((resolve) => {
		try {
			execFile(
				"ps",
				[...args],
				{
					env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
					killSignal: "SIGKILL",
					maxBuffer: 16 * 1024 * 1024,
					timeout: timeoutMs,
					windowsHide: true,
				},
				(error, stdout) =>
					resolve(
						error && ((error as { killed?: boolean }).killed || !stdout)
							? undefined
							: stdout,
					),
			);
		} catch {
			resolve(undefined);
		}
	});
}
