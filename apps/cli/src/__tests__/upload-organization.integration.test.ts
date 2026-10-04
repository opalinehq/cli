import { afterAll, describe, expect, test } from "bun:test";
import {
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	getDefaultProjectOrgId,
	setProjectOrgId,
} from "../lib/project-config.js";
import { runCli } from "./helpers/ingest-stub.js";

/**
 * Imports and retries of sessions whose folder has no workspace mapping:
 * the CLI falls back to the `opaline set-org` default, then to an account's
 * only workspace, and never guesses between several. A server that cannot
 * choose answers like the API ("Choose an organization with --org or opaline
 * set-org"), which must stay retryable.
 */

const homes: string[] = [];
const servers: Array<{ stop: () => Promise<void> }> = [];

afterAll(async () => {
	await Promise.all(servers.map((server) => server.stop()));
	await Promise.all(
		homes.map((home) => rm(home, { force: true, recursive: true })),
	);
});

interface Stub {
	readonly baseUrl: string;
	readonly organizations: Array<string | undefined>;
}

/** Answers ingestSession like the API for an account in several workspaces. */
function startStub(): Stub {
	const organizations: Array<string | undefined> = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const { pathname } = new URL(request.url);
			const body = await request.text();
			if (pathname !== "/rpc/ingestSession")
				return new Response("not found", { status: 404 });
			const input = JSON.parse(body).json;
			organizations.push(input.organizationId);
			if (typeof input.organizationId !== "string")
				return Response.json(
					{
						json: {
							code: "BAD_REQUEST",
							defined: false,
							message: "Choose an organization with --org or opaline set-org",
							status: 400,
						},
					},
					{ status: 400 },
				);
			return Response.json({
				json: { success: true, sessionId: input.sessionId },
			});
		},
	});
	servers.push({ stop: () => server.stop(true) });
	return { baseUrl: `http://127.0.0.1:${server.port}`, organizations };
}

async function createHome(
	stub: Stub,
	options: {
		readonly organizations: readonly string[];
		readonly setOrgDefault?: string;
	},
) {
	const home = await realpath(
		await mkdtemp(join(tmpdir(), "opaline-upload-org-")),
	);
	homes.push(home);
	const configDir = join(home, ".rudel");
	await mkdir(configDir, { recursive: true });
	await writeFile(
		join(configDir, "credentials.json"),
		JSON.stringify({
			apiBaseUrl: stub.baseUrl,
			authType: "api-key",
			token: "upload-org-token",
			organizations: options.organizations.map((id) => ({
				id,
				name: id,
				slug: id,
			})),
		}),
	);
	if (options.setOrgDefault !== undefined)
		await writeFile(
			join(configDir, "projects.json"),
			JSON.stringify({
				projects: { "/elsewhere": { organizationId: options.setOrgDefault } },
				defaultOrganizationId: options.setOrgDefault,
			}),
		);
	const sessionId = "6c1d9a52-2d0e-4b8f-9a51-6f2f3c1d7e10";
	const projectPath = join(home, "unmapped");
	await mkdir(projectPath, { recursive: true });
	const transcriptPath = join(
		home,
		".claude",
		"projects",
		"-unmapped",
		`${sessionId}.jsonl`,
	);
	await mkdir(join(transcriptPath, ".."), { recursive: true });
	await writeFile(
		transcriptPath,
		`${JSON.stringify({
			cwd: projectPath,
			message: { content: "Summarize the week", role: "user" },
			sessionId,
			timestamp: "2026-10-04T10:00:00.000Z",
			type: "user",
		})}\n`,
	);
	return { configDir, home, projectPath, sessionId, transcriptPath };
}

function cli(home: string, args: readonly string[]) {
	return runCli(args, {
		home,
		projectPath: "",
		sessionId: "",
		transcriptPath: "",
	});
}

async function readFailures(configDir: string) {
	return JSON.parse(
		await readFile(join(configDir, "failed-uploads.json"), "utf8"),
	).failures;
}

describe("workspace fallback for unmapped sessions", () => {
	test("an import uses the set-org default", async () => {
		const stub = startStub();
		const fixture = await createHome(stub, {
			organizations: ["org-a", "org-b"],
			setOrgDefault: "org-b",
		});

		const result = await cli(fixture.home, ["import", fixture.transcriptPath]);

		expect(result.exitCode).toBe(0);
		expect(stub.organizations).toEqual(["org-b"]);
	});

	test("an import uses the account's only workspace", async () => {
		const stub = startStub();
		const fixture = await createHome(stub, { organizations: ["org-only"] });

		const result = await cli(fixture.home, ["import", fixture.transcriptPath]);

		expect(result.exitCode).toBe(0);
		expect(stub.organizations).toEqual(["org-only"]);
	});

	test("with several workspaces and no default it never guesses, and the session stays retryable", async () => {
		const stub = startStub();
		const fixture = await createHome(stub, {
			organizations: ["org-a", "org-b"],
		});

		const imported = await cli(fixture.home, [
			"import",
			fixture.transcriptPath,
		]);

		expect(imported.exitCode).not.toBe(0);
		expect(stub.organizations).toEqual([undefined]);
		expect(await readFailures(fixture.configDir)).toMatchObject([
			{
				sessionId: fixture.sessionId,
				status: "retryable",
				error: expect.stringContaining("opaline set-org"),
			},
		]);

		// A retry without a choice stays retryable; after set-org it uploads.
		const retried = await cli(fixture.home, ["import", "--retry", "--yes"]);
		expect(retried.exitCode).not.toBe(0);
		expect(await readFailures(fixture.configDir)).toMatchObject([
			{ sessionId: fixture.sessionId, status: "retryable" },
		]);
		await writeFile(
			join(fixture.configDir, "projects.json"),
			JSON.stringify({ projects: {}, defaultOrganizationId: "org-a" }),
		);
		const chosen = await cli(fixture.home, ["import", "--retry", "--yes"]);
		expect(chosen.exitCode).toBe(0);
		expect(stub.organizations.at(-1)).toBe("org-a");
		expect(await readFailures(fixture.configDir)).toEqual([]);
	});
});

test("opaline set-org also records the default for unmapped folders", async () => {
	const configDir = await mkdtemp(join(tmpdir(), "opaline-set-org-default-"));
	homes.push(configDir);
	const previous = process.env.OPALINE_CONFIG_DIR;
	process.env.OPALINE_CONFIG_DIR = configDir;
	try {
		expect(getDefaultProjectOrgId()).toBeUndefined();
		await setProjectOrgId(configDir, "org-chosen");
		expect(getDefaultProjectOrgId()).toBe("org-chosen");
	} finally {
		if (previous === undefined) delete process.env.OPALINE_CONFIG_DIR;
		else process.env.OPALINE_CONFIG_DIR = previous;
	}
});
