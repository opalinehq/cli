import { buildRouteMap } from "@stricli/core";
import { askRunCommand } from "../ask/run.js";
import { listSessionsCommand } from "./list-sessions.js";

export const devRouteMap = buildRouteMap({
	routes: {
		ask: askRunCommand,
		"list-sessions": listSessionsCommand,
	},
	docs: {
		brief: "Development utilities (not available in published builds)",
	},
});
