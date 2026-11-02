import { buildRouteMap } from "@stricli/core";
import { askCommand } from "./ask.js";
import { listSessionsCommand } from "./list-sessions.js";

export const devRouteMap = buildRouteMap({
	routes: {
		ask: askCommand,
		"list-sessions": listSessionsCommand,
	},
	docs: {
		brief: "Development utilities (not available in published builds)",
	},
});
