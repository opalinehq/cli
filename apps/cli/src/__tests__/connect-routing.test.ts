import { expect, test } from "bun:test";
import { run } from "@stricli/core";
import { app } from "../app.js";

async function runOpaline(args: string[]) {
	const stdout: string[] = [];
	const stderr: string[] = [];
	const process = {
		stdout: { write: (text: string) => stdout.push(text) },
		stderr: { write: (text: string) => stderr.push(text) },
		exitCode: undefined as number | string | undefined,
	};
	await run(app, args, { process });
	return { stdout: stdout.join(""), stderr: stderr.join("") };
}

test("`opaline connect` keeps routing to browser pairing with its flags, and `connect sub` reaches the subscription commands", async () => {
	const withCode = await runOpaline(["connect", "--code", "not-a-code"]);
	expect(withCode.stderr).toContain("Invalid connection code");

	const bare = await runOpaline(["connect"]);
	expect(bare.stderr).toContain("--code");
	expect(bare.stderr).not.toContain("Invalid connection code");

	const pairingHelp = await runOpaline(["connect", "--code", "x", "--help"]);
	expect(pairingHelp.stdout).toContain("--no-browser");

	const subDefault = await runOpaline([
		"connect",
		"sub",
		"--workspace",
		"acme",
		"--help",
	]);
	expect(subDefault.stdout).toContain(
		"opaline connect sub [--workspace value]",
	);

	const sub = await runOpaline(["connect", "sub", "--help"]);
	expect(sub.stdout).toContain("opaline connect sub off");
	expect(sub.stdout).toContain("opaline connect sub status");

	const alias = await runOpaline(["ask", "--help"]);
	expect(alias.stdout).toContain("opaline ask run");
	expect(alias.stdout).toContain("opaline ask on");
});
