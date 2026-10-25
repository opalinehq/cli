import { afterAll, expect, test } from "bun:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const root = await mkdtemp(join(tmpdir(), "opaline-analytics-tests-"));
await writeFile(join(root, "package.json"), JSON.stringify({ type: "module" }));
const result = await Bun.build({
	entrypoints: [join(import.meta.dir, "helpers/product-analytics-probe.ts")],
	outdir: root,
	target: "node",
});
if (!result.success)
	throw new AggregateError(result.logs, "Probe build failed");
const probe = join(root, "product-analytics-probe.js");
const unusedListener = createServer();
await new Promise<void>((resolve) =>
	unusedListener.listen(0, "127.0.0.1", resolve),
);
const address = unusedListener.address();
assert(address && typeof address !== "string");
const unavailableHost = `http://127.0.0.1:${address.port}`;
await new Promise<void>((resolve, reject) =>
	unusedListener.close((error) => (error ? reject(error) : resolve())),
);
const StateSchema = z.object({
	cli_first_run_event_id: z.string().uuid().optional(),
	cli_first_run_delivered: z.boolean().optional(),
	cli_login_attempt_count: z.number().optional(),
});

afterAll(async () => {
	await rm(root, { recursive: true, force: true });
});

test("disabled tracking neither consumes first run nor writes analytics state", async () => {
	for (const optOut of [{ POSTHOG_ENABLED: "false" }, { DO_NOT_TRACK: "1" }]) {
		const configDir = await mkdtemp(join(root, "disabled-"));
		await runProbe("first-run", configDir, optOut);
		expect(existsSync(join(configDir, "product-analytics.json"))).toBe(false);
	}
});

test("failed delivery retries an old consumed first run with the same event UUID", async () => {
	const configDir = await mkdtemp(join(root, "retry-"));
	const statePath = join(configDir, "product-analytics.json");
	await writeFile(statePath, JSON.stringify({ cli_first_run_tracked: true }));
	await runProbe("first-run", configDir);
	const first = StateSchema.parse(
		JSON.parse(await readFile(statePath, "utf8")),
	);
	expect(first.cli_first_run_event_id).toBeDefined();
	expect(first.cli_first_run_delivered).not.toBe(true);
	await runProbe("first-run", configDir);
	const retried = StateSchema.parse(
		JSON.parse(await readFile(statePath, "utf8")),
	);
	expect(retried.cli_first_run_event_id).toBe(first.cli_first_run_event_id);
	expect(retried.cli_first_run_delivered).not.toBe(true);
});

test("a confirmed first run is not sent again", async () => {
	const configDir = await mkdtemp(join(root, "delivered-"));
	const statePath = join(configDir, "product-analytics.json");
	const original = JSON.stringify({ cli_first_run_delivered: true });
	await writeFile(statePath, original);
	await runProbe("first-run", configDir);
	const state = StateSchema.parse(
		JSON.parse(await readFile(statePath, "utf8")),
	);
	expect(state.cli_first_run_event_id).toBeUndefined();
	expect(state.cli_first_run_delivered).toBe(true);
});

test("corrupt optional analytics state does not break login attempts", async () => {
	const configDir = await mkdtemp(join(root, "corrupt-"));
	await writeFile(
		join(configDir, "product-analytics.json"),
		JSON.stringify({ cli_login_attempt_count: "not a number" }),
	);
	expect((await runProbe("login-attempt", configDir)).trim()).toBe("1");
});

test("unwritable optional analytics state does not break the command", async () => {
	const configDir = join(root, "file-instead-of-directory");
	await writeFile(configDir, "cannot create a directory here");
	await runProbe("first-run", configDir);
	expect(await readFile(configDir, "utf8")).toBe(
		"cannot create a directory here",
	);
});

test("account switching and logout start separate anonymous identities", async () => {
	const configDir = await mkdtemp(join(root, "identity-"));
	const output = await runProbe("identity", configDir);
	const ids = z
		.object({ before: z.string(), switched: z.string(), loggedOut: z.string() })
		.parse(JSON.parse(output));
	expect(new Set(Object.values(ids)).size).toBe(3);
});

test("first run reports CI, interactive, and ephemeral state", async () => {
	const FirstRunSchema = z.object({
		batch: z.array(
			z.object({
				event: z.string(),
				properties: z.object({
					is_ci: z.boolean(),
					is_interactive: z.boolean(),
					is_ephemeral: z.boolean(),
				}),
			}),
		),
	});
	const received: z.infer<typeof FirstRunSchema>["batch"] = [];
	const collector = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(request) {
			const body = new Uint8Array(await request.arrayBuffer());
			const json =
				request.headers.get("content-encoding") === "gzip"
					? Bun.gunzipSync(body)
					: body;
			received.push(
				...FirstRunSchema.parse(JSON.parse(new TextDecoder().decode(json)))
					.batch,
			);
			return Response.json({ status: 1 });
		},
	});
	try {
		const host = { POSTHOG_HOST: `http://127.0.0.1:${collector.port}` };
		const saved = await mkdtemp(join(root, "first-run-saved-"));
		await runProbe("first-run", saved, { ...host, CI: "true" });
		const unwritable = join(root, "first-run-file-instead-of-directory");
		await writeFile(unwritable, "cannot create a directory here");
		await runProbe("first-run", unwritable, { ...host, CI: "" });
	} finally {
		await collector.stop(true);
	}
	expect(
		received.map(({ event, properties }) => ({ event, ...properties })),
	).toEqual([
		{
			event: "CLI First Run",
			is_ci: true,
			is_interactive: false,
			is_ephemeral: false,
		},
		{
			event: "CLI First Run",
			is_ci: false,
			is_interactive: false,
			is_ephemeral: true,
		},
	]);
});

const UUID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const OPT_OUTS = [{ POSTHOG_ENABLED: "false" }, { DO_NOT_TRACK: "1" }] as const;

test("the installation id is kept between processes with analytics off, without writing analytics state", async () => {
	for (const optOut of OPT_OUTS) {
		const configDir = await mkdtemp(join(root, "installation-off-"));
		const first = (await runProbe("installation-id", configDir, optOut)).trim();
		expect(first).toMatch(UUID);
		expect((await runProbe("installation-id", configDir, optOut)).trim()).toBe(
			first,
		);
		expect(existsSync(join(configDir, "product-analytics.json"))).toBe(false);
		const file = join(configDir, "installation-id.json");
		expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
			version: 1,
			installationId: first,
		});
		if (process.platform !== "win32")
			expect((await stat(file)).mode & 0o777).toBe(0o600);
	}
});

test("with analytics on, the same id is kept in both files and reused", async () => {
	const configDir = await mkdtemp(join(root, "installation-on-"));
	const first = (await runProbe("installation-id", configDir)).trim();
	expect(first).toMatch(UUID);
	expect(
		JSON.parse(
			await readFile(join(configDir, "product-analytics.json"), "utf8"),
		).cli_installation_id,
	).toBe(first);
	// Turning analytics off later keeps the installation's identity.
	expect(
		(await runProbe("installation-id", configDir, OPT_OUTS[0])).trim(),
	).toBe(first);
});

test("an id an earlier release kept in the analytics state is reused, whether or not analytics is on", async () => {
	const legacy = "6f1c2b9e-3d4a-4b5c-8d6e-7f8091a2b3c4";
	for (const environment of [{}, ...OPT_OUTS]) {
		const configDir = await mkdtemp(join(root, "installation-legacy-"));
		const statePath = join(configDir, "product-analytics.json");
		const original = JSON.stringify({ cli_installation_id: legacy });
		await writeFile(statePath, original);
		expect(
			(await runProbe("installation-id", configDir, environment)).trim(),
		).toBe(legacy);
		expect(await readFile(statePath, "utf8")).toBe(original);
	}
});

test("concurrent first runs agree on one installation id", async () => {
	const configDir = await mkdtemp(join(root, "installation-race-"));
	const ids = await Promise.all(
		Array.from({ length: 6 }, () =>
			runProbe("installation-id", configDir, OPT_OUTS[0]),
		),
	);
	expect(new Set(ids.map((id) => id.trim())).size).toBe(1);
});

test("a corrupt installation id file is replaced once, and an unwritable directory still yields an id", async () => {
	const configDir = await mkdtemp(join(root, "installation-corrupt-"));
	await writeFile(join(configDir, "installation-id.json"), "{not json");
	const replaced = (
		await runProbe("installation-id", configDir, OPT_OUTS[0])
	).trim();
	expect(replaced).toMatch(UUID);
	expect(
		(await runProbe("installation-id", configDir, OPT_OUTS[0])).trim(),
	).toBe(replaced);
	const unwritable = join(root, "installation-file-instead-of-directory");
	await writeFile(unwritable, "cannot create a directory here");
	expect(
		(await runProbe("installation-id", unwritable, OPT_OUTS[0])).trim(),
	).toMatch(UUID);
});

async function runProbe(
	mode: string,
	configDir: string,
	environment: NodeJS.ProcessEnv = {},
): Promise<string> {
	const child = Bun.spawn(["node", probe, mode], {
		env: {
			...process.env,
			OPALINE_CONFIG_DIR: configDir,
			POSTHOG_ENABLED: "true",
			POSTHOG_KEY: "phc_analytics_test",
			// Exercise a real refused connection, with no mocked SDK or collector.
			POSTHOG_HOST: unavailableHost,
			DO_NOT_TRACK: "0",
			...environment,
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	expect(exitCode, stderr).toBe(0);
	return stdout;
}
