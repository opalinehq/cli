import { buildRouteMap } from "@stricli/core";
import { askRunCommand } from "./run.js";
import { askOffCommand, askOnCommand, askStatusCommand } from "./service.js";

export const askRouteMap = buildRouteMap({
	routes: {
		run: askRunCommand,
		on: askOnCommand,
		off: askOffCommand,
		status: askStatusCommand,
	},
	docs: { brief: "Answer Opaline Ask questions with Claude Code" },
});
