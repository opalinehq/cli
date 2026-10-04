import { buildRouteMap } from "@stricli/core";
import { claudeRouteMap } from "./claude/index.js";
import { codexRouteMap } from "./codex/index.js";
import { evidenceDeliverCommand } from "./evidence-deliver.js";

export const hooksRouteMap = buildRouteMap({
	routes: {
		claude: claudeRouteMap,
		codex: codexRouteMap,
		"evidence-deliver": evidenceDeliverCommand,
	},
	docs: {
		brief: "Hook handlers",
	},
});
