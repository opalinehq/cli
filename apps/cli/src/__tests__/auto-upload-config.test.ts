import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	clearAutoUploadRepositories,
	enableAutoUploadRepository,
	getRequiredAutoUploadSources,
	isRepositoryAutoUploadAllowed,
	loadAutoUploadConfig,
	saveVisibleAutoUploadSelections,
} from "../lib/auto-upload-config.js";

const originalConfigDir = process.env.OPALINE_CONFIG_DIR;
const tempRoot = await mkdtemp(join(tmpdir(), "rudel-auto-upload-config-"));

beforeAll(() => {
	process.env.OPALINE_CONFIG_DIR = tempRoot;
});

beforeEach(async () => {
	await rm(join(tempRoot, "auto-upload.json"), { force: true });
});

afterAll(async () => {
	if (originalConfigDir === undefined) {
		delete process.env.OPALINE_CONFIG_DIR;
	} else {
		process.env.OPALINE_CONFIG_DIR = originalConfigDir;
	}
	await rm(tempRoot, { force: true, recursive: true });
});

describe("repository-scoped automatic upload", () => {
	test("keeps legacy global hooks allowed until repository choices are saved", () => {
		expect(loadAutoUploadConfig()).toBeNull();
		expect(isRepositoryAutoUploadAllowed("path:rudel-v2", "claude_code")).toBe(
			true,
		);
		expect(isRepositoryAutoUploadAllowed("path:other", "codex")).toBe(true);
	});

	test("persists selected repositories and gates each agent source", async () => {
		const config = saveVisibleAutoUploadSelections(
			[
				{
					key: "path:rudel-v2",
					label: "rudel-v2",
					sources: ["claude_code"],
				},
				{
					key: "remote:github.com/acme/other",
					label: "acme/other",
					sources: ["claude_code"],
				},
			],
			new Set(["path:rudel-v2"]),
		);

		expect(isRepositoryAutoUploadAllowed("path:rudel-v2", "claude_code")).toBe(
			true,
		);
		expect(isRepositoryAutoUploadAllowed("path:rudel-v2", "codex")).toBe(false);
		expect(
			isRepositoryAutoUploadAllowed(
				"remote:github.com/acme/other",
				"claude_code",
			),
		).toBe(false);
		expect(getRequiredAutoUploadSources(config)).toEqual(
			new Set(["claude_code"]),
		);
		expect((await stat(tempRoot)).mode & 0o777).toBe(0o700);
		expect((await stat(join(tempRoot, "auto-upload.json"))).mode & 0o777).toBe(
			0o600,
		);
		expect(
			await readFile(join(tempRoot, "auto-upload.json"), "utf8"),
		).toContain('"path:rudel-v2"');
	});

	test("supports turning every repository off", () => {
		clearAutoUploadRepositories();

		expect(isRepositoryAutoUploadAllowed("path:rudel-v2", "claude_code")).toBe(
			false,
		);
		expect(getRequiredAutoUploadSources(loadRequiredConfig())).toEqual(
			new Set(),
		);
	});
});

function loadRequiredConfig() {
	const config = loadAutoUploadConfig();
	if (!config) throw new Error("Expected auto-upload configuration");
	return config;
}

test("migrates old worktree selections and keeps deselected repositories disabled", () => {
	const legacy = {
		key: "path:demo",
		label: "demo",
		sources: ["claude_code"] as const,
	};
	enableAutoUploadRepository(legacy);
	const repository = {
		key: "remote:github.com/acme/demo",
		label: "demo",
		sources: ["claude_code", "codex"] as const,
		legacyKeys: [legacy.key],
	};
	expect(
		isRepositoryAutoUploadAllowed(
			repository.key,
			"claude_code",
			repository.legacyKeys,
		),
	).toBe(true);
	saveVisibleAutoUploadSelections([repository], new Set([repository.key]));
	expect(loadRequiredConfig().repositories[legacy.key]).toBeUndefined();
	expect(
		isRepositoryAutoUploadAllowed(
			repository.key,
			"codex",
			repository.legacyKeys,
		),
	).toBe(true);
	saveVisibleAutoUploadSelections([repository], new Set());
	expect(
		isRepositoryAutoUploadAllowed(
			repository.key,
			"claude_code",
			repository.legacyKeys,
		),
	).toBe(false);
	expect(isRepositoryAutoUploadAllowed(legacy.key, "claude_code")).toBe(false);
});
