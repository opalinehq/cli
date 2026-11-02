import { z } from "zod";

export const AskBridgeConnectInputSchema = z
	.object({
		organizationId: z.string().min(1).max(200),
		deviceId: z.string().regex(/^[A-Za-z0-9_-]{8,80}$/u),
	})
	.strict();

export const AskBridgeConnectionSchema = z.object({
	convexUrl: z.string().url(),
	token: z.string(),
	expiresAt: z.number().int(),
	mcpUrl: z.string().url(),
	mcpToken: z.string(),
	mcpTokenExpiresAt: z.number().int(),
	workspace: z.object({ id: z.string(), slug: z.string(), name: z.string() }),
});

export type AskBridgeConnectInput = z.infer<typeof AskBridgeConnectInputSchema>;
export type AskBridgeConnection = z.infer<typeof AskBridgeConnectionSchema>;
