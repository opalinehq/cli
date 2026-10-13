import { afterAll, describe, expect, test } from "bun:test";
import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getLegacyRemoteUrl, normalizeRemoteUrl } from "../lib/git-info.js";

const REPO_ROOT = resolve(import.meta.dir, "../../../..");
const FAKE_TOKEN = "fake_pat_RUD204";
const PROJECT_CONFIG_SCRIPT = `
import { getProjectOrgId, setProjectOrgId } from "./apps/cli/src/lib/project-config.ts";

const action = process.argv[1];
const projectDir = process.argv[2];
if (action === "set") {
	await setProjectOrgId(projectDir, "org-123");
} else {
	process.stdout.write((await getProjectOrgId(projectDir)) ?? "");
}
`;
const LOCAL_STATE_SCRIPT = `
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { recordFailedUpload } from "./apps/cli/src/lib/failed-uploads.ts";
import { cacheRemotes } from "./apps/cli/src/lib/remote-cache.ts";
import { disposeLogging, setupHookLogging } from "./apps/cli/src/logging.ts";

const configDir = process.env.RUDEL_CONFIG_DIR;
if (!configDir) throw new Error("RUDEL_CONFIG_DIR is required");

const logDir = join(configDir, "logs");
const failedUploadsPath = join(configDir, "failed-uploads.json");
const remoteCachePath = join(configDir, "remote-cache.json");
const logPath = join(logDir, "hook-upload.log");

await mkdir(logDir, { recursive: true });
await Promise.all([
	writeFile(failedUploadsPath, JSON.stringify({ failures: [] })),
	writeFile(remoteCachePath, "{}"),
	writeFile(logPath, "existing log\\n"),
]);
await Promise.all([
	chmod(configDir, 0o755),
	chmod(logDir, 0o755),
	chmod(failedUploadsPath, 0o644),
	chmod(remoteCachePath, 0o644),
	chmod(logPath, 0o644),
]);

await recordFailedUpload({
	sessionId: "session-123",
	transcriptPath: "/private/transcript.jsonl",
	projectPath: "/private/project",
	error: "upload failed",
});
await cacheRemotes({ encodedProject: "github.com/acme/widget" });
await setupHookLogging();
await disposeLogging();
`;

const tempRoot = await mkdtemp(join(tmpdir(), "rudel-local-state-security-"));

afterAll(async () => {
	await rm(tempRoot, { recursive: true, force: true });
});

describe("git remote sanitization", () => {
	test.each([
		[
			`https://oauth2:${FAKE_TOKEN}@github.com/acme/widget.git`,
			"github.com/acme/widget",
		],
		[
			"ssh://git:fake-password@git.example.com/acme/widget.git",
			"git.example.com/acme/widget",
		],
		["git@github.com:acme/widget.git", "github.com/acme/widget"],
	])("normalizes %s without credentials", (remote, expected) => {
		expect(normalizeRemoteUrl(remote)).toBe(expected);
	});

	test.each([
		"https://git.example.com:8443/acme/widget.git",
		`https://oauth2:${FAKE_TOKEN}@git.example.com:8443/acme/widget.git`,
		"ssh://git@git.example.com:2222/acme/widget.git",
		"git://git.example.com/acme/widget.git",
		"deploy@git.example.com:acme/widget.git",
		"git.example.com:acme/widget",
	])("drops the port and user from %s", (remote) => {
		expect(normalizeRemoteUrl(remote)).toBe("git.example.com/acme/widget");
	});

	test("keeps the key older releases saved for remotes with a port", () => {
		expect(
			getLegacyRemoteUrl("https://git.example.com:8443/acme/widget.git"),
		).toBe("git.example.com/8443/acme/widget");
		expect(
			getLegacyRemoteUrl("git@github.com:acme/widget.git"),
		).toBeUndefined();
	});

	test("resolves a project saved under the pre-port-fix key, then rewrites it", async () => {
		const fixtureRoot = join(tempRoot, "project-port");
		const configDir = join(fixtureRoot, "config");
		const projectDir = join(fixtureRoot, "repo");
		const projectsPath = join(configDir, "projects.json");
		await Promise.all([
			mkdir(configDir, { recursive: true }),
			mkdir(projectDir, { recursive: true }),
		]);
		await writeFile(
			projectsPath,
			JSON.stringify({
				projects: {
					"git.example.com/8443/acme/widget": { organizationId: "org-legacy" },
				},
			}),
		);
		await runCommand(["git", "-C", projectDir, "init", "-q"]);
		await runCommand([
			"git",
			"-C",
			projectDir,
			"remote",
			"add",
			"origin",
			"https://git.example.com:8443/acme/widget.git",
		]);

		const legacyResult = await runProjectConfig("get", projectDir, configDir);
		expect(legacyResult.stdout).toBe("org-legacy");

		expect(
			(await runProjectConfig("set", projectDir, configDir)).exitCode,
		).toBe(0);
		const config = JSON.parse(await readFile(projectsPath, "utf8"));
		expect(Object.keys(config.projects)).toEqual([
			"git.example.com/acme/widget",
		]);
		await runCommand([
			"git",
			"-C",
			projectDir,
			"remote",
			"set-url",
			"origin",
			"git@git.example.com:acme/widget.git",
		]);
		const getResult = await runProjectConfig("get", projectDir, configDir);
		expect(getResult.stdout).toBe("org-123");
	});

	test("persists the sanitized key and resolves it across remote formats", async () => {
		const fixtureRoot = join(tempRoot, "project");
		const configDir = join(fixtureRoot, "config");
		const projectDir = join(fixtureRoot, "repo");
		const projectsPath = join(configDir, "projects.json");
		await Promise.all([
			mkdir(configDir, { recursive: true }),
			mkdir(projectDir, { recursive: true }),
		]);
		await writeFile(projectsPath, JSON.stringify({ projects: {} }));
		await Promise.all([
			chmod(configDir, 0o755),
			chmod(projectsPath, 0o644),
			runCommand(["git", "-C", projectDir, "init", "-q"]),
		]);
		await runCommand([
			"git",
			"-C",
			projectDir,
			"remote",
			"add",
			"origin",
			`https://oauth2:${FAKE_TOKEN}@github.com/acme/widget.git`,
		]);

		const setResult = await runProjectConfig("set", projectDir, configDir);
		expect(setResult.exitCode).toBe(0);
		const config = await readFile(projectsPath, "utf8");
		expect(config).not.toContain(FAKE_TOKEN);
		expect(config).toContain('"github.com/acme/widget"');
		expect(await permissions(configDir)).toBe(0o700);
		expect(await permissions(projectsPath)).toBe(0o600);

		await runCommand([
			"git",
			"-C",
			projectDir,
			"remote",
			"set-url",
			"origin",
			"git@github.com:acme/widget.git",
		]);
		const getResult = await runProjectConfig("get", projectDir, configDir);
		expect(getResult.exitCode).toBe(0);
		expect(getResult.stdout).toBe("org-123");
	});
});

test("repairs private local-state permissions", async () => {
	const home = join(tempRoot, "local-state");
	const configDir = join(home, ".rudel");
	const result = await runBunScript(LOCAL_STATE_SCRIPT, {
		HOME: home,
		RUDEL_CONFIG_DIR: configDir,
	});

	expect(result.exitCode).toBe(0);
	expect(result.stderr).toBe("");
	expect(await permissions(configDir)).toBe(0o700);
	expect(await permissions(join(configDir, "logs"))).toBe(0o700);
	expect(await permissions(join(configDir, "failed-uploads.json"))).toBe(0o600);
	expect(await permissions(join(configDir, "remote-cache.json"))).toBe(0o600);
	expect(await permissions(join(configDir, "logs", "hook-upload.log"))).toBe(
		0o600,
	);
});

interface ProcessResult {
	exitCode: number;
	stderr: string;
	stdout: string;
}

async function runProjectConfig(
	action: "get" | "set",
	projectDir: string,
	configDir: string,
): Promise<ProcessResult> {
	return runBunScript(PROJECT_CONFIG_SCRIPT, { RUDEL_CONFIG_DIR: configDir }, [
		action,
		projectDir,
	]);
}

async function runBunScript(
	script: string,
	env: Record<string, string>,
	args: readonly string[] = [],
): Promise<ProcessResult> {
	return runProcess([process.execPath, "-e", script, ...args], env);
}

async function runCommand(command: readonly string[]): Promise<ProcessResult> {
	const result = await runProcess(command);
	expect(result.exitCode).toBe(0);
	return result;
}

async function runProcess(
	command: readonly string[],
	env: Record<string, string> = {},
): Promise<ProcessResult> {
	const processHandle = Bun.spawn(command, {
		cwd: REPO_ROOT,
		env: { ...process.env, ...env },
		stderr: "pipe",
		stdout: "pipe",
	});
	const [exitCode, stderr, stdout] = await Promise.all([
		processHandle.exited,
		new Response(processHandle.stderr).text(),
		new Response(processHandle.stdout).text(),
	]);
	return { exitCode, stderr, stdout };
}

async function permissions(path: string): Promise<number> {
	return (await stat(path)).mode & 0o777;
}
