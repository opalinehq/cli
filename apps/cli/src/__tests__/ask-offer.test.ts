import { expect, test } from "bun:test";
import { ORPCError } from "@orpc/client";
import type { AskBridgeConnection } from "../contracts/ask.js";
import { type AskOfferDependencies, offerAsk } from "../lib/ask/onboarding.js";
import type { ProviderState } from "../lib/ask/providers.js";

const CONNECTION: AskBridgeConnection = {
	convexUrl: "https://convex.test",
	token: "t",
	expiresAt: 0,
	mcpUrl: "https://opaline.test/mcp",
	mcpToken: "m",
	mcpTokenExpiresAt: 0,
	workspace: { id: "w1", slug: "acme", name: "Acme" },
};
const READY: ProviderState = {
	kind: "claude",
	version: "2.1.316",
	ready: true,
};

function setup(
	overrides: Partial<AskOfferDependencies> & { accept?: boolean } = {},
) {
	const shown: string[] = [];
	const installed: string[] = [];
	const dependencies: AskOfferDependencies = {
		interactive: true,
		serviceSupported: true,
		serviceInstalled: async () => false,
		detectClaude: async () => READY,
		connect: async () => CONNECTION,
		install: async (workspace) => {
			installed.push(workspace.slug);
		},
		askUrl: (slug) => `https://opaline.test/${slug}/ask`,
		screens: {
			offer: async (version) => {
				shown.push(`offer ${version}`);
				return overrides.accept ?? true;
			},
			askOn: (url) => shown.push(`on ${url}`),
			claudeLogin: (version) => shown.push(`login ${version}`),
			installFailed: (error) => shown.push(`failed ${error}`),
		},
		...overrides,
	};
	return { dependencies, shown, installed };
}

test("a workspace without Ask, a missing Claude Code or a non-interactive run shows nothing", async () => {
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
		{
			detectClaude: async (): Promise<ProviderState> => ({
				kind: "claude",
				ready: false,
			}),
		},
		{ interactive: false },
		{ serviceInstalled: async () => true },
	]) {
		const { dependencies, shown, installed } = setup(overrides);
		expect(await offerAsk(dependencies)).toBe("not-shown");
		expect(shown).toEqual([]);
		expect(installed).toEqual([]);
	}
});

test("a logged-out Claude Code gets the login screen, and an accepted offer installs the service for the workspace", async () => {
	const loggedOut = setup({
		detectClaude: async () => ({ ...READY, ready: false }),
	});
	expect(await offerAsk(loggedOut.dependencies)).toBe("claude-login");
	expect(loggedOut.shown).toEqual(["login 2.1.316"]);
	expect(loggedOut.installed).toEqual([]);

	const accepted = setup();
	expect(await offerAsk(accepted.dependencies)).toBe("turned-on");
	expect(accepted.shown).toEqual([
		"offer 2.1.316",
		"on https://opaline.test/acme/ask",
	]);
	expect(accepted.installed).toEqual(["acme"]);

	const declined = setup({ accept: false });
	expect(await offerAsk(declined.dependencies)).toBe("declined");
	expect(declined.installed).toEqual([]);
});
