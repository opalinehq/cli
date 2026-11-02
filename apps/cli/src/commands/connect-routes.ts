import { buildRouteMap } from "@stricli/core";
import {
	askOffCommand,
	askOnCommand,
	askStatusCommand,
} from "./ask/service.js";
import { connectCommand } from "./connect.js";

export const connectSubRouteMap = buildRouteMap({
	routes: { on: askOnCommand, off: askOffCommand, status: askStatusCommand },
	defaultCommand: "on",
	docs: { brief: "Connect your Claude Code / Codex subscription" },
});

export const connectRouteMap = buildRouteMap({
	routes: { pair: connectCommand, sub: connectSubRouteMap },
	defaultCommand: "pair",
	docs: {
		brief: "Connect your selected repositories to browser setup",
		hideRoute: { pair: true },
	},
});
