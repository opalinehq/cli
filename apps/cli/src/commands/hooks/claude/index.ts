import { buildRouteMap } from "@stricli/core";
import { liveFollowCommand } from "./live-follow.js";
import { sessionEndCommand } from "./session-end.js";
import { sessionStartCommand } from "./session-start.js";

export const claudeRouteMap = buildRouteMap({
	routes: {
		"session-start": sessionStartCommand,
		"session-end": sessionEndCommand,
		"live-follow": liveFollowCommand,
	},
	docs: {
		brief: "Claude Code hook handlers",
		hideRoute: { "live-follow": true },
	},
});
