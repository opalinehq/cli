import {
	addHook,
	ensureSessionStartHook,
	getClaudeSettingsPath,
	isHookEnabled,
	removeHook,
} from "../../internal/agent-adapters/adapters/claude-code/settings.js";

if (process.argv[2] === "install") addHook();
if (process.argv[2] === "remove") removeHook();
const healed =
	process.argv[2] === "heal" ? ensureSessionStartHook() : undefined;
console.log(
	JSON.stringify({
		path: getClaudeSettingsPath(),
		enabled: isHookEnabled(),
		...(healed === undefined ? {} : { healed }),
	}),
);
