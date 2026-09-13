import { afterAll, expect, test } from "bun:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
