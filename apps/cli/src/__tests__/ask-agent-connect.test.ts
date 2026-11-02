import { expect, test } from "bun:test";
import { ORPCError } from "@orpc/client";
import type { AskBridgeConnection } from "../contracts/ask.js";
import {
	type AgentConnectDependencies,
	connectAgents,
} from "../lib/ask/onboarding.js";
import type { ProviderState } from "../lib/ask/providers.js";

const CONNECTION: AskBridgeConnection = {
	convexUrl: "https://convex.test",
	token: "t",
	expiresAt: 0,
	mcpUrl: "https://opaline.test/mcp",
	mcpToken: "m",
	mcpTokenExpiresAt: 0,
	askUrl: "https://opaline.test/acme/ask",
	workspace: { id: "w1", slug: "acme", name: "Acme" },
};
const CLAUDE: ProviderState = {
	kind: "claude",
	version: "2.1.316",
	ready: true,
};
const CODEX: ProviderState = { kind: "codex", version: "0.156.0", ready: true };

function setup(
	overrides: Partial<AgentConnectDependencies> = {},
	accept = true,
) {
	const shown: string[] = [];
	const installed: string[] = [];
	const dependencies: AgentConnectDependencies = {
		interactive: true,
		serviceSupported: true,
		serviceInstalled: async () => false,
		detectProviders: async () => [CLAUDE, CODEX],
		connect: async () => CONNECTION,
		install: async (workspace) => {
			installed.push(workspace.slug);
		},
		screens: {
			offer: async () => {
				shown.push("offer");
				return accept;
			},
			connected: (agents) => shown.push(`connected ${agents}`),
			needsAgent: () => shown.push("needs agent"),
			installFailed: (error) => shown.push(`failed ${error}`),
		},
		...overrides,
	};
	return { dependencies, shown, installed };
}

test("Ask off for the workspace, a non-interactive run or an installed service shows nothing", async () => {
	for (const overrides of [
		{
			connect: async () => {
				throw new ORPCError("FORBIDDEN");
			},
		},
		{
			connect: async () => {
				throw new ORPCError("PRECONDITION_FAILED");
			},
		},
		{ interactive: false },
		{ serviceInstalled: async () => true },
	]) {
		const { dependencies, shown, installed } = setup(overrides);
		expect(await connectAgents(dependencies)).toBe("not-shown");
		expect(shown).toEqual([]);
		expect(installed).toEqual([]);
	}
});

test("a ready agent is offered, Connect installs the service, Later installs nothing, and no ready agent shows the one-line next step", async () => {
	const codexOnly = setup({
		detectProviders: async () => [{ ...CLAUDE, ready: false }, CODEX],
	});
	expect(await connectAgents(codexOnly.dependencies)).toBe("connected");
	expect(codexOnly.shown).toEqual(["offer", "connected Codex 0.156.0"]);
	expect(codexOnly.installed).toEqual(["acme"]);

	const both = setup();
	await connectAgents(both.dependencies);
	expect(both.shown).toEqual([
		"offer",
		"connected Claude Code 2.1.316 and Codex 0.156.0",
	]);

	const later = setup({}, false);
	expect(await connectAgents(later.dependencies)).toBe("later");
	expect(later.shown).toEqual(["offer"]);
	expect(later.installed).toEqual([]);

	const none = setup({
		detectProviders: async () => [{ ...CLAUDE, ready: false }],
	});
	expect(await connectAgents(none.dependencies)).toBe("needs-agent");
	expect(none.shown).toEqual(["needs agent"]);
	expect(none.installed).toEqual([]);
});
