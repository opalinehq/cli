import { afterAll, expect, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const directories: string[] = [];
afterAll(async () => {
	await Promise.all(
		directories.map((path) => rm(path, { recursive: true, force: true })),
	);
});

function reposEnv(home: string, extra: Record<string, string> = {}) {
	const env: Record<string, string | undefined> = {
		...process.env,
		HOME: home,
		USERPROFILE: home,
		CODEX_HOME: join(home, ".codex"),
		OPALINE_CONFIG_DIR: join(home, ".opaline"),
		POSTHOG_ENABLED: "false",
		...extra,
	};
	delete env.OPALINE_API_BASE;
	return env;
}

async function runRepos(
	args: string[],
	home: string,
	cwd: string,
	extra: Record<string, string> = {},
) {
	const child = Bun.spawn(
		[process.execPath, resolve(import.meta.dir, "../bin/cli.ts"), ...args],
		{
			cwd,
			env: reposEnv(home, extra),
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return {
		code,
		stderr,
		lines: stdout
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line)),
	};
}

test("repos list and apply speak JSON without a terminal and never prompt", async () => {
	const home = await realpath(
		await mkdtemp(join(tmpdir(), "opaline-repos-json-")),
	);
	directories.push(home);
	const repository = join(home, "project");
	await mkdir(join(home, ".claude", "projects"), { recursive: true });
	await mkdir(repository);
	Bun.spawnSync(["git", "init", "-q", repository]);

	const list = await runRepos(["repos", "list", "--json"], home, repository);
	expect(list.code, list.stderr).toBe(0);
	expect(list.lines).toHaveLength(1);
	const [listed] = list.lines;
	expect(listed.signedIn).toBe(false);
	const current = listed.repositories.find(
		(row: { current: boolean }) => row.current,
	);
	expect(Object.keys(current).sort()).toEqual([
		"current",
		"enabled",
		"key",
		"name",
		"paths",
		"problem",
		"sessionCount",
		"sources",
		"uploadedCount",
	]);
	expect(current).toMatchObject({
		paths: [repository],
		enabled: false,
		sessionCount: 0,
		uploadedCount: null,
		problem: null,
	});

	const unknown = await runRepos(
		["repos", "apply", "--json", "--enable", "missing-repository"],
		home,
		repository,
	);
	expect(unknown.code).toBe(1);
	expect(unknown.lines.at(-1)).toEqual({
		type: "error",
		code: "unknown_repository",
		message: "Unknown repository: missing-repository",
	});

	const badCode = await runRepos(
		["repos", "apply", "--json", "--enable", current.key],
		home,
		repository,
		{ OPALINE_CONNECTION_CODE: "not-a-code" },
	);
	expect(badCode.code).toBe(1);
	expect(badCode.lines).toEqual([
		{
			type: "error",
			code: "invalid_code",
			message: "Invalid connection code. Copy the command again from Opaline.",
		},
	]);

	const signedOut = await runRepos(
		["repos", "apply", "--json", "--enable", current.key],
		home,
		repository,
	);
	expect(signedOut.code).toBe(1);
	expect(signedOut.lines.map((line) => line.type)).toEqual([
		"progress",
		"progress",
		"error",
	]);
	expect(signedOut.lines[1]).toEqual({ type: "progress", phase: "authorize" });
	expect(signedOut.lines[2]).toMatchObject({
		type: "error",
		code: "not_signed_in",
	});
}, 60_000);

test.each(["SIGTERM", "SIGINT"] as const)(
	"%s while waiting for setup approval cancels promptly and tells the setup page",
	async (signal) => {
		const home = await realpath(
			await mkdtemp(join(tmpdir(), "opaline-repos-cancel-")),
		);
		directories.push(home);
		const repository = join(home, "project");
		await mkdir(join(home, ".claude", "projects"), { recursive: true });
		await mkdir(repository);
		Bun.spawnSync(["git", "init", "-q", repository]);
		const list = await runRepos(["repos", "list", "--json"], home, repository);
		const current = list.lines[0].repositories.find(
			(row: { current: boolean }) => row.current,
		);
		const updates: Array<{ kind: string; state?: string }> = [];
		let polls = 0;
		const id = crypto.randomUUID();
		const server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			async fetch(request) {
				const path = new URL(request.url).pathname;
				const origin = `http://127.0.0.1:${server.port}`;
				const now = new Date().toISOString();
				const snapshot = {
					id,
					browserOrigin: origin,
					state: "waiting",
					revision: updates.length,
					createdAt: now,
					expiresAt: new Date(Date.now() + 600_000).toISOString(),
					lastSeenAt: now,
					repositories: [],
					organizationId: null,
					totals: null,
					failureReason: null,
				};
				if (path === "/api/cli/connections/redeem")
					return Response.json(snapshot);
				if (path === `/api/cli/connections/${id}/update`) {
					const body = (await request.json()) as {
						update: { kind: string; state?: string };
					};
					updates.push(body.update);
					return Response.json(snapshot);
				}
				if (path === "/api/auth/device/code")
					return Response.json({
						device_code: "device-code",
						user_code: "ABCD-EFGH",
						verification_uri: `${origin}/device`,
						expires_in: 600,
						interval: 5,
					});
				if (path === "/api/auth/device/token") {
					polls++;
					return Response.json(
						{ error: "authorization_pending" },
						{ status: 400 },
					);
				}
				return new Response("not found", { status: 404 });
			},
		});
		try {
			const bundle = join(home, "bundle");
			const build = Bun.spawnSync([
				process.execPath,
				"build",
				resolve(import.meta.dir, "../bin/cli.ts"),
				"--outdir",
				bundle,
				"--target=node",
				"--define=OPALINE_BUNDLED_ANALYTICS=null",
			]);
			expect(build.exitCode, build.stderr.toString()).toBe(0);
			await writeFile(join(bundle, "package.json"), '{"type":"module"}');
			const node = Bun.which("node");
			assert(node);
			const child = Bun.spawn(
				[
					node,
					join(bundle, "cli.js"),
					"repos",
					"apply",
					"--json",
					"--enable",
					current.key,
					"--api-base",
					`http://127.0.0.1:${server.port}`,
				],
				{
					cwd: repository,
					env: reposEnv(home, { OPALINE_CONNECTION_CODE: "a".repeat(43) }),
					stdin: "ignore",
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			const reader = child.stdout.getReader();
			const decoder = new TextDecoder();
			let output = "";
			while (!output.includes('"type":"authorize"')) {
				const chunk = await reader.read();
				if (chunk.done) break;
				output += decoder.decode(chunk.value, { stream: true });
			}
			expect(output).toContain('"type":"authorize"');
			while (polls === 0) await Bun.sleep(20);
			const signalledAt = performance.now();
			child.kill(signal);
			while (true) {
				const chunk = await reader.read();
				if (chunk.done) break;
				output += decoder.decode(chunk.value, { stream: true });
			}
			const code = await child.exited;
			const elapsed = performance.now() - signalledAt;
			const lines = output
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
			expect(lines.map((line) => line.type)).toEqual([
				"progress",
				"progress",
				"authorize",
				"error",
			]);
			expect(lines[2].url).toContain("user_code=ABCD-EFGH");
			expect(lines[2].url).toContain(`connect=${id}`);
			expect(lines[3]).toMatchObject({ type: "error", code: "cancelled" });
			expect(code).toBe(1);
			expect(elapsed).toBeLessThan(1_500);
			expect(updates.at(-1)).toEqual({
				kind: "status",
				state: "cancelled",
				failureReason: null,
			});
			expect(polls).toBe(1);
		} finally {
			server.stop(true);
		}
	},
	60_000,
);
