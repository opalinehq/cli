import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";

/**
 * Process start identities tell a reused PID apart from the process that
 * registered it. Linux reads the start time in clock ticks since boot from
 * `/proc/<pid>/stat` (immune to wall-clock steps); macOS reads `ps -o lstart`.
 * Anything else, or a `ps` without `lstart` (for example BusyBox), yields no
 * identity: callers then rely on `kill(pid, 0)` alone, and never treat a
 * missing identity as a dead process.
 */
export async function readProcessStartIdentities(
	pids: readonly number[],
): Promise<Map<number, string>> {
	const identities = new Map<number, string>();
	const unique = [...new Set(pids)].filter(
		(pid) => Number.isSafeInteger(pid) && pid > 0,
	);
	if (unique.length === 0) return identities;
	if (process.platform === "linux") {
		await Promise.all(
			unique.map(async (pid) => {
				const stat = await readProcStat(pid);
				if (stat) identities.set(pid, `linux:${stat.startTime}`);
			}),
		);
		return identities;
	}
	if (process.platform !== "darwin") return identities;
	const output = await runPs(["-o", "pid=,lstart=", "-p", unique.join(",")]);
	for (const line of output?.split("\n") ?? []) {
		const match = /^\s*(\d+)\s+(\S.*\S)\s*$/u.exec(line);
		if (!match?.[1] || !match[2]) continue;
		identities.set(Number(match[1]), `darwin:${match[2]}`);
	}
	return identities;
}

export interface AncestorProcess {
	readonly pid: number;
	readonly identity: string | null;
}

/**
 * The nearest ancestor of `startPid` (excluding itself) whose executable
 * basename satisfies `matches`. POSIX only; null when none is found.
 */
export async function findAncestorProcess(
	startPid: number,
	matches: (executableName: string) => boolean,
	maxDepth = 16,
): Promise<AncestorProcess | null> {
	if (process.platform !== "linux" && process.platform !== "darwin")
		return null;
	let pid = startPid;
	for (let depth = 0; depth < maxDepth; depth += 1) {
		const parent = await readParent(pid);
		if (!parent || parent.ppid <= 1) return null;
		const ancestor = await readProcessInfo(parent.ppid);
		if (!ancestor) return null;
		if (matches(basename(ancestor.name))) {
			const identity =
				ancestor.identity ??
				(await readProcessStartIdentities([parent.ppid])).get(parent.ppid) ??
				null;
			return { identity, pid: parent.ppid };
		}
		pid = parent.ppid;
	}
	return null;
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

async function readProcStat(pid: number): Promise<ProcStat | null> {
	try {
		return parseProcStat(await readFile(`/proc/${pid}/stat`, "utf8"));
	} catch {
		return null;
	}
}

async function readParent(pid: number): Promise<{ ppid: number } | null> {
	if (process.platform === "linux") return readProcStat(pid);
	const output = await runPs(["-o", "ppid=", "-p", String(pid)]);
	const ppid = Number(output?.trim());
	return output && Number.isSafeInteger(ppid) ? { ppid } : null;
}

async function readProcessInfo(
	pid: number,
): Promise<{ name: string; identity: string | null } | null> {
	if (process.platform === "linux") {
		const stat = await readProcStat(pid);
		return stat
			? { identity: `linux:${stat.startTime}`, name: stat.comm }
			: null;
	}
	const output = (await runPs(["-o", "comm=", "-p", String(pid)]))?.trim();
	return output ? { identity: null, name: output } : null;
}

function runPs(args: readonly string[]): Promise<string | undefined> {
	return new Promise((resolve) => {
		execFile(
			"ps",
			[...args],
			{
				env: { ...process.env, LC_ALL: "C" },
				timeout: 5_000,
				windowsHide: true,
			},
			(error, stdout) => resolve(error && !stdout ? undefined : stdout),
		);
	});
}
