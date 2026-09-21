import { buildRouteMap } from "@stricli/core";
import { sessionEndCommand } from "./session-end.js";
import { sessionStartCommand } from "./session-start.js";

export const claudeRouteMap = buildRouteMap({
	routes: {
		"session-start": sessionStartCommand,
		"session-end": sessionEndCommand,
	},
	docs: {
		brief: "Claude Code hook handlers",
	},
});
