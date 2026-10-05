import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ORPCError } from "@orpc/client";
import { withConfigLock } from "../lib/config-lock.js";
import {
	pauseRepositoryEvidenceCapture,
	readRepositoryEvidencePauseUntil,
} from "../lib/repository-evidence-pause.js";

const cases = [
	"fifo",
	"symlink",
	"directory",
	"oversized",
	"1e300",
	"fractional",
	"beyond-week",
	"garbage",
];
const reader = resolve(import.meta.dir, "../lib/repository-evidence-pause.ts");

test.each(cases)(
	"rejects and removes a %s marker without blocking",
	async (kind) => {
		const directory = await mkdtemp(join(tmpdir(), "opaline-pause-safety-"));
		try {
			const marker = await writeMarker(directory, kind);
			const output = execFileSync(
				process.execPath,
				[
					"--eval",
					`import { readRepositoryEvidencePauseUntil } from ${JSON.stringify(reader)}; console.log(JSON.stringify(readRepositoryEvidencePauseUntil(${JSON.stringify(directory)}) ?? null));`,
				],
				{ encoding: "utf8", timeout: 2_000 },
			);
			expect(output.trim()).toBe("null");
			expect(await lstat(marker).catch(() => undefined)).toBeUndefined();
			if (kind === "symlink")
				expect(await readFile(join(directory, "target"), "utf8")).toContain(
					"until",
				);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	},
);

test.each(cases)(
	"doctor handles a %s marker without throwing or blocking",
	async (kind) => {
		const directory = await mkdtemp(join(tmpdir(), "opaline-pause-doctor-"));
		try {
			await writeMarker(directory, kind);
			const preload = join(directory, "preload.ts");
			await writeFile(
				preload,
				`globalThis.fetch = async () => Response.json({ version: "0.10.0" });`,
			);
			const child = Bun.spawn(
				[
					process.execPath,
					"--preload",
					preload,
					resolve(import.meta.dir, "../bin/cli.ts"),
					"doctor",
				],
				{
					env: {
						...process.env,
						HOME: directory,
						OPALINE_CONFIG_DIR: directory,
						POSTHOG_ENABLED: "false",
					},
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			const timeout = setTimeout(() => child.kill(), 3_000);
			try {
				const [stdout, stderr] = await Promise.all([
					new Response(child.stdout).text(),
					new Response(child.stderr).text(),
					child.exited,
				]);
				expect(child.signalCode ?? null).toBeNull();
				expect(stdout).toContain("Doctor found");
				expect(stdout).not.toContain("server-paused");
				expect(stderr).not.toContain("RangeError");
			} finally {
				clearTimeout(timeout);
			}
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	},
);

test("concurrent pause writers preserve the latest requested expiry", async () => {
	const directory = await mkdtemp(join(tmpdir(), "opaline-pause-writers-"));
	const now = Date.now();
	try {
		const writer = async (pauseSeconds: number) => {
			const script = `import { ORPCError } from "@orpc/client";
import { pauseRepositoryEvidenceCapture } from ${JSON.stringify(reader)};
await pauseRepositoryEvidenceCapture(new ORPCError("EVIDENCE_CAPTURE_DISABLED", { status: 403, data: { pauseSeconds: ${pauseSeconds} } }), ${JSON.stringify(directory)}, ${now});`;
			const child = Bun.spawn([process.execPath, "--eval", script], {
				stdout: "pipe",
				stderr: "pipe",
			});
			const [exitCode, stderr] = await Promise.all([
				child.exited,
				new Response(child.stderr).text(),
			]);
			expect(stderr).toBe("");
			expect(exitCode).toBe(0);
		};
		await Promise.all([604_800, 3_600, 86_400, 3_600].map(writer));
		expect(readRepositoryEvidencePauseUntil(directory, now)).toBe(
			now + 604_800_000,
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("a pause writer waits for another config writer and keeps the longer expiry", async () => {
	const directory = await mkdtemp(join(tmpdir(), "opaline-pause-wait-"));
	const now = Date.now();
	const until = now + 604_800_000;
	try {
		let pause: Promise<void> | undefined;
		await withConfigLock(directory, async () => {
			pause = pauseRepositoryEvidenceCapture(
				new ORPCError("EVIDENCE_CAPTURE_DISABLED", {
					status: 403,
					data: { pauseSeconds: 3_600 },
				}),
				directory,
				now,
			);
			await Bun.sleep(200);
			await writeFile(
				join(directory, "repository-evidence-pause.json"),
				JSON.stringify({ until }),
			);
		});
		await pause;
		expect(readRepositoryEvidencePauseUntil(directory, now)).toBe(until);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("a reader keeps an expired marker while another process holds the config lock", async () => {
	const directory = await mkdtemp(join(tmpdir(), "opaline-pause-expired-"));
	const marker = join(directory, "repository-evidence-pause.json");
	const now = Date.now();
	try {
		await writeFile(marker, JSON.stringify({ until: now - 1 }));
		await withConfigLock(directory, async () => {
			expect(readRepositoryEvidencePauseUntil(directory, now)).toBeUndefined();
			expect(await readFile(marker, "utf8")).toContain("until");
		});
		expect(readRepositoryEvidencePauseUntil(directory, now)).toBeUndefined();
		expect(await lstat(marker).catch(() => undefined)).toBeUndefined();
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("pause updates cannot overwrite another config writer and re-read the latest expiry under the lock", async () => {
	const directory = await mkdtemp(join(tmpdir(), "opaline-pause-lock-"));
	const now = Date.now();
	const until = now + 604_800_000;
	const error = new ORPCError("EVIDENCE_CAPTURE_DISABLED", {
		status: 403,
		data: { pauseSeconds: 3_600 },
	});
	try {
		await withConfigLock(directory, async () => {
			await writeFile(
				join(directory, "repository-evidence-pause.json"),
				JSON.stringify({ until }),
			);
			await expect(
				pauseRepositoryEvidenceCapture(error, directory, now),
			).rejects.toThrow("Another upload manager is saving");
			expect(readRepositoryEvidencePauseUntil(directory, now)).toBe(until);
		});
		await pauseRepositoryEvidenceCapture(error, directory, now);
		expect(readRepositoryEvidencePauseUntil(directory, now)).toBe(until);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("accepts a regular marker at both the size and expiry limits", async () => {
	const directory = await mkdtemp(join(tmpdir(), "opaline-pause-limits-"));
	const now = Date.now();
	const until = now + 604_800_000;
	try {
		const contents = JSON.stringify({ until });
		await writeFile(
			join(directory, "repository-evidence-pause.json"),
			contents.padEnd(4_096, " "),
		);
		expect(readRepositoryEvidencePauseUntil(directory, now)).toBe(until);
		expect(
			await lstat(join(directory, "repository-evidence-pause.json")),
		).toBeDefined();
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

async function writeMarker(directory: string, kind: string): Promise<string> {
	const marker = join(directory, "repository-evidence-pause.json");
	const until = Date.now() + 3_600_000;
	if (kind === "fifo") execFileSync("mkfifo", [marker]);
	else if (kind === "directory") await mkdir(marker);
	else if (kind === "symlink") {
		const target = join(directory, "target");
		await writeFile(target, JSON.stringify({ until }));
		await symlink(target, marker);
	} else
		await writeFile(
			marker,
			kind === "oversized"
				? JSON.stringify({ until, padding: " ".repeat(4_096) })
				: kind === "1e300"
					? '{"until":1e300}'
					: kind === "fractional"
						? JSON.stringify({ until: until + 0.5 })
						: kind === "beyond-week"
							? JSON.stringify({ until: Date.now() + 604_800_000 + 60_000 })
							: "not json",
		);
	return marker;
}
