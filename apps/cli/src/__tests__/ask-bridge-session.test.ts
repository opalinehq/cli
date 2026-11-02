import { expect, test } from "bun:test";
import type { AskBridgeConnection } from "../contracts/ask.js";
import { BridgeSession } from "../lib/ask/bridge-session.js";

const MINUTE = 60_000;

function connection(n: number, now: number): AskBridgeConnection {
	return {
		convexUrl: "https://convex.test",
		token: `token-${n}`,
		expiresAt: now + 30 * MINUTE,
		mcpUrl: "https://opaline.test/mcp",
		mcpToken: `mcp-${n}`,
		mcpTokenExpiresAt: now + 60 * MINUTE,
		workspace: { id: "w", slug: "w", name: "W" },
	};
}

test("the bridge reconnects once for parallel token requests and only when a token is close to expiry", async () => {
	let now = 0;
	let connects = 0;
	const session = await BridgeSession.open(
		async () => connection(++connects, now),
		() => {},
		() => now,
	);

	expect(await session.fetchConvexToken({ forceRefreshToken: false })).toBe(
		"token-1",
	);
	expect((await session.mcpAccess()).mcpToken).toBe("mcp-1");
	expect(connects).toBe(1);

	now = 50 * MINUTE;
	const [first, second, mcp] = await Promise.all([
		session.fetchConvexToken({ forceRefreshToken: false }),
		session.fetchConvexToken({ forceRefreshToken: true }),
		session.mcpAccess(),
	]);
	expect([first, second, mcp.mcpToken]).toEqual([
		"token-2",
		"token-2",
		"mcp-2",
	]);
	expect(connects).toBe(2);
});

test("a failed reconnect keeps a still-valid Convex token and gives up an expired one", async () => {
	let now = 0;
	let fail = false;
	const errors: unknown[] = [];
	const session = await BridgeSession.open(
		async () => {
			if (fail) throw new Error("offline");
			return connection(1, now);
		},
		(error) => errors.push(error),
		() => now,
	);
	fail = true;

	now = 29 * MINUTE;
	expect(await session.fetchConvexToken({ forceRefreshToken: true })).toBe(
		"token-1",
	);
	now = 31 * MINUTE;
	expect(
		await session.fetchConvexToken({ forceRefreshToken: true }),
	).toBeNull();
	expect(errors).toHaveLength(2);
});
