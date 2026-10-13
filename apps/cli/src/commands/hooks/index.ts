import { buildRouteMap } from "@stricli/core";
import { claudeRouteMap } from "./claude/index.js";
import { codexRouteMap } from "./codex/index.js";
import { evidenceDeliverCommand } from "./evidence-deliver.js";
import { liveFollowCommand } from "./live-follow.js";

export const hooksRouteMap = buildRouteMap({
	routes: {
		claude: claudeRouteMap,
		codex: codexRouteMap,
		"evidence-deliver": evidenceDeliverCommand,
		"live-follow": liveFollowCommand,
	},
	docs: {
		brief: "Hook handlers",
		hideRoute: { "live-follow": true },
	},
});
