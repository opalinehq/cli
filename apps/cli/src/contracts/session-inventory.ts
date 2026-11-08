import { z } from "zod";
import { SourceSchema } from "./source.js";

export const SESSION_INVENTORY_MAX_SESSIONS = 20_000;
const UINT32_MAX = 4_294_967_295;

export const SessionInventoryEntrySchema = z.object({
	sessionId: z.string().min(1).max(200),
	source: SourceSchema,
	mainLines: z.number().int().nonnegative().max(UINT32_MAX),
	subagentLines: z.number().int().nonnegative().max(UINT32_MAX),
	subagentFiles: z.number().int().nonnegative().max(UINT32_MAX),
	mainBytes: z.number().int().nonnegative(),
	subagentBytes: z.number().int().nonnegative(),
	modifiedAt: z.string().datetime(),
	startedAt: z.string().datetime().optional(),
});

export const SessionInventoryInputSchema = z.object({
	organizationId: z.string().min(1).max(200).optional(),
	cliVersion: z.string().max(200).optional(),
	omitted: z.number().int().nonnegative().max(UINT32_MAX).optional(),
	sessions: z
		.array(SessionInventoryEntrySchema)
		.max(SESSION_INVENTORY_MAX_SESSIONS),
});

export const SessionInventoryOutputSchema = z.object({
	organizationId: z.string(),
	sessions: z.number().int().nonnegative(),
});

export type SessionInventoryEntry = z.infer<typeof SessionInventoryEntrySchema>;
