import { afterEach, expect, test } from "bun:test";
import assert from "node:assert/strict";
import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	isRepositoryAutoUploadAllowed,
	loadAutoUploadConfig,
	updateAutoUploadConfig,
} from "../lib/auto-upload-config.js";

const originalConfig = process.env.OPALINE_CONFIG_DIR;
const fixtures: string[] = [];
afterEach(async () => {
	if (originalConfig === undefined) delete process.env.OPALINE_CONFIG_DIR;
	else process.env.OPALINE_CONFIG_DIR = originalConfig;
	await Promise.all(
		fixtures.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
	);
});

test("one store preserves other repository metadata and the default workspace", async () => {
	const dir = await fixture();
	const repository = {
		name: "A",
		paths: [join(dir, "a")],
		organizationId: "workspace-a",
		enabled: true,
	};
	await updateAutoUploadConfig(async (_existing, save) => {
		await save({
			version: 1,
			defaultOrganizationId: "workspace-a",
			repositories: { a: repository },
		});
	});
	await updateAutoUploadConfig(async (config, save) => {
		assert(config);
		config.repositories.b = { name: "B", paths: [], enabled: false };
		await save(config);
	});
	const saved = loadAutoUploadConfig();
	expect(saved?.defaultOrganizationId).toBe("workspace-a");
	expect(saved?.repositories.a).toMatchObject(repository);
	expect(isRepositoryAutoUploadAllowed("a", "claude_code")).toBe(true);
	expect(isRepositoryAutoUploadAllowed("b", "claude_code")).toBe(false);
	expect(isRepositoryAutoUploadAllowed("unknown", "codex")).toBe(false);
	const persisted = JSON.parse(
		await readFile(join(dir, "auto-upload.json"), "utf8"),
	);
	expect(persisted.repositories.a.sources).toEqual(["claude_code", "codex"]);
	expect(persisted.repositories.b.sources).toEqual([]);
	if (process.platform !== "win32") {
		expect((await stat(dir)).mode & 0o777).toBe(0o700);
		expect((await stat(join(dir, "auto-upload.json"))).mode & 0o777).toBe(
			0o600,
		);
	}
});

test("reads legacy allowlists and gives a canonical OFF entry precedence", async () => {
	const dir = await fixture();
	expect(loadAutoUploadConfig()).toBeNull();
	expect(isRepositoryAutoUploadAllowed("repo", "claude_code")).toBe(true);
	await writeFile(
		join(dir, "auto-upload.json"),
		JSON.stringify({
			version: 1,
			repositories: {
				legacy: { label: "Repository", sources: ["claude_code"] },
			},
		}),
	);
	expect(loadAutoUploadConfig()?.repositories.legacy).toMatchObject({
		name: "Repository",
		paths: [],
		enabled: true,
	});
	expect(isRepositoryAutoUploadAllowed("repo", "claude_code", ["legacy"])).toBe(
		true,
	);
	expect(isRepositoryAutoUploadAllowed("repo", "codex", ["legacy"])).toBe(
		false,
	);
	await updateAutoUploadConfig(async (config, save) => {
		assert(config);
		config.repositories.repo = {
			name: "Repository",
			paths: [],
			enabled: false,
		};
		await save(config);
	});
	expect(isRepositoryAutoUploadAllowed("repo", "claude_code", ["legacy"])).toBe(
		false,
	);
});

test("invalid settings fail closed without overwriting the file", async () => {
	const dir = await fixture();
	const invalid =
		'{"version":1,"repositories":{"repo":{"label":"Repo","sources":["unknown"]}}}';
	await writeFile(join(dir, "auto-upload.json"), invalid);
	expect(() => isRepositoryAutoUploadAllowed("repo", "claude_code")).toThrow();
	await expect(
		updateAutoUploadConfig(async (_existing, save) => {
			await save({ version: 1, repositories: {} });
		}),
	).rejects.toThrow();
	expect(await readFile(join(dir, "auto-upload.json"), "utf8")).toBe(invalid);
});

test("a killed owner releases the next save and competing recovery never overlaps writers", async () => {
	const dir = await fixture();
	const script = join(dir, "writer.ts");
	await writeFile(
		script,
		`
import { updateAutoUploadConfig } from ${JSON.stringify(fileURLToPath(new URL("../lib/auto-upload-config.ts", import.meta.url)))};
import { open, unlink } from "node:fs/promises";
import { join } from "node:path";
const dir = process.argv[2];
try {
 await updateAutoUploadConfig(async (existing, save) => {
  if (process.argv[3] === "hold") {
   process.stdout.write("locked");
   process.stdin.resume();
   await new Promise(() => {});
  }
  const marker = join(dir, "critical-section");
  const handle = await open(marker, "wx");
  await new Promise((resolve) => setTimeout(resolve, 40));
  const config = existing ?? { version: 1, repositories: {} };
  config.repositories[process.argv[3]] = { name: "writer", paths: [], enabled: false };
  await save(config);
  await handle.close();
  await unlink(marker);
 }, dir);
} catch (error) {
 if (error instanceof Error && error.message.includes("Another upload manager")) process.exit(2);
 console.error(error);
 process.exit(1);
}
`,
	);
	const executable = join(dir, "writer.mjs");
	const build = Bun.spawn(
		[
			process.execPath,
			"build",
			script,
			"--target=node",
			"--outfile",
			executable,
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	const [buildCode, buildError] = await Promise.all([
		build.exited,
		new Response(build.stderr).text(),
	]);
	expect(buildCode, buildError).toBe(0);
	const owner = Bun.spawn(["node", executable, dir, "hold"], {
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	const reader = owner.stdout.getReader();
	try {
		const ready = await reader.read();
		expect(new TextDecoder().decode(ready.value)).toBe("locked");
		await expect(updateAutoUploadConfig(async () => {}, dir)).rejects.toThrow(
			"Another upload manager",
		);
	} finally {
		owner.kill("SIGKILL");
		await owner.exited;
		reader.releaseLock();
	}
	const writers = Array.from({ length: 6 }, (_, index) =>
		Bun.spawn(["node", executable, dir, String(index)], {
			stdout: "pipe",
			stderr: "pipe",
		}),
	);
	const codes = await Promise.all(writers.map((writer) => writer.exited));
	const errors = await Promise.all(
		writers.map((writer) => new Response(writer.stderr).text()),
	);
	expect(errors).toEqual(Array(6).fill(""));
	expect(codes).toContain(0);
	expect(codes.every((code) => code === 0 || code === 2)).toBe(true);
	expect(Object.keys(loadAutoUploadConfig()?.repositories ?? {})).toHaveLength(
		codes.filter((code) => code === 0).length,
	);
	await updateAutoUploadConfig(async (config, save) => {
		assert(config);
		await save(config);
	});
});

test("recovers an empty lock directory left during release", async () => {
	const dir = await fixture();
	await mkdir(join(dir, ".auto-upload-lock"));
	await updateAutoUploadConfig(async (_existing, save) => {
		await save({ version: 1, repositories: {} });
	});
	expect(loadAutoUploadConfig()?.repositories).toEqual({});
});

async function fixture(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "opaline-auto-upload-"));
	fixtures.push(dir);
	process.env.OPALINE_CONFIG_DIR = dir;
	return dir;
}
