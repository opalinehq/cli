import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	findCodexThread,
	getCodexHomeDir,
	getUuidV7Time,
	resolveCodexThreadFamily,
} from "../lib/codex-thread-family.js";
import { codexThreadId, writeCodexRollout } from "./helpers/codex-rollouts.js";

const homes: string[] = [];

afterAll(async () => {
	await Promise.all(
		homes.map((home) => rm(home, { force: true, recursive: true })),
	);
});

async function createCodexHome(): Promise<string> {
	const home = await mkdtemp(join(tmpdir(), "opaline-codex-family-"));
	homes.push(home);
	return home;
}

describe("Codex thread family", () => {
	test("resolves the parent chain and every subagent of the chat, not reviewers or strangers", async () => {
		const codexHome = await createCodexHome();
		const base = Date.parse("2026-10-04T09:21:11.000Z");
		const root = codexThreadId(base);
		const child = codexThreadId(base + 30_000);
		const grandchild = codexThreadId(base + 60_000);
		const sibling = codexThreadId(base + 90_000);
		const guardian = codexThreadId(base + 120_000);
		const stranger = codexThreadId(base + 150_000);
		await writeCodexRollout(codexHome, { threadId: root });
		await writeCodexRollout(codexHome, { threadId: child, spawnedBy: root });
		await writeCodexRollout(codexHome, {
			threadId: grandchild,
			spawnedBy: child,
		});
		await writeCodexRollout(codexHome, { threadId: sibling, spawnedBy: root });
		await writeCodexRollout(codexHome, {
			threadId: guardian,
			guardianOf: child,
		});
		await writeCodexRollout(codexHome, { threadId: stranger });

		const family = await resolveCodexThreadFamily(child, {
			codexHome,
			now: new Date(base + 3_600_000),
		});

		expect(family?.self.threadId).toBe(child);
		expect(family?.ancestors.map((thread) => thread.threadId)).toEqual([root]);
		// The sibling was spawned by the parent: it is part of the same chat.
		expect(family?.descendants.map((thread) => thread.threadId)).toEqual([
			sibling,
			grandchild,
		]);
	});

	test("follows payload.parent_thread_id and finds children on later days", async () => {
		const codexHome = await createCodexHome();
		const base = Date.parse("2026-10-01T12:00:00.000Z");
		const root = codexThreadId(base);
		const lateChild = codexThreadId(base + 2 * 86_400_000);
		await writeCodexRollout(codexHome, { threadId: root });
		await writeCodexRollout(codexHome, {
			threadId: lateChild,
			parentThreadIdOnly: root,
		});

		const family = await resolveCodexThreadFamily(root, {
			codexHome,
			now: new Date(base + 3 * 86_400_000),
		});

		expect(family?.ancestors).toEqual([]);
		expect(family?.descendants.map((thread) => thread.threadId)).toEqual([
			lateChild,
		]);
	});

	test("returns null for an unknown thread and finds non-UUIDv7 ids by file name", async () => {
		const codexHome = await createCodexHome();
		await writeCodexRollout(codexHome, {
			threadId: "legacy-thread-id",
			date: new Date("2026-08-12T10:00:00.000Z"),
		});

		expect(
			await resolveCodexThreadFamily(codexThreadId(Date.now()), { codexHome }),
		).toBeNull();
		expect(
			(await findCodexThread("legacy-thread-id", codexHome))?.threadId,
		).toBe("legacy-thread-id");
	});

	test("reads CODEX_HOME before ~/.codex and decodes UUIDv7 time", () => {
		expect(getCodexHomeDir({ CODEX_HOME: "/custom/codex" })).toBe(
			"/custom/codex",
		);
		expect(getCodexHomeDir({ CODEX_HOME: " " })).toMatch(/\.codex$/u);
		expect(getUuidV7Time("01a105ca-4f78-7732-9257-3e83ad6d0eb4")).toBe(
			0x01a105ca4f78,
		);
		expect(getUuidV7Time("6f1c2a1e-1b2c-4d3e-8f40-123456789abc")).toBe(
			undefined,
		);
	});
});
