import { afterAll, expect, test } from "bun:test";
import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isFileLeaseHeld, tryAcquireFileLease } from "../lib/file-lease.js";

const root = await mkdtemp(join(tmpdir(), "opaline-file-lease-"));

afterAll(async () => {
	await rm(root, { force: true, recursive: true });
});

test("a lease is exclusive until it is released", async () => {
	const path = join(root, "exclusive.lease");
	const first = await tryAcquireFileLease(path);
	assert(first);
	expect(await isFileLeaseHeld(path)).toBe(true);
	expect(await tryAcquireFileLease(path)).toBeNull();
	await first.release();
	expect(await isFileLeaseHeld(path)).toBe(false);
	const second = await tryAcquireFileLease(path);
	assert(second);
	await second.release();
});

test.each<[string, string | null, number]>([
	["a dead owner process", "999999999:dead", 0],
	["an owner file that was never written", null, 60_000],
	[
		"a live owner whose heartbeat stopped long ago",
		`${process.pid}:hung`,
		600_000,
	],
	["an unreadable owner token", "garbage", 0],
])("recovers a lease left by %s", async (name, owner, ageMs) => {
	const path = join(root, `${name.replaceAll(" ", "-")}.lease`);
	await mkdir(path, { recursive: true });
	if (owner !== null) await writeFile(join(path, "owner"), owner);
	const stamp = new Date(Date.now() - ageMs);
	await utimes(path, stamp, stamp);
	const lease = await tryAcquireFileLease(path);
	assert(lease);
	await lease.release();
});

test.each<[string, string | null]>([
	["a live owner", `${process.pid}:live`],
	["an owner that is still writing its token", null],
])("keeps a fresh lease held by %s", async (name, owner) => {
	const path = join(root, `${name.replaceAll(" ", "-")}.lease`);
	await mkdir(path, { recursive: true });
	if (owner !== null) await writeFile(join(path, "owner"), owner);
	expect(await tryAcquireFileLease(path)).toBeNull();
	await rm(path, { force: true, recursive: true });
});
