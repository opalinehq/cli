import { buildApplication, buildRouteMap } from "@stricli/core";
import pkg from "../package.json" with { type: "json" };
import { connectCommand } from "./commands/connect.js";
import { devRouteMap } from "./commands/dev/index.js";
import { doctorCommand } from "./commands/doctor.js";
import { hooksRouteMap } from "./commands/hooks/index.js";
import { importCommand } from "./commands/import.js";
import { loginCommand } from "./commands/login.js";
import { logoutCommand } from "./commands/logout.js";
import { setOrgCommand } from "./commands/set-org.js";
import { uploadCommand } from "./commands/upload.js";
import { whoamiCommand } from "./commands/whoami.js";

const routes = buildRouteMap({
	routes: {
		connect: connectCommand,
		login: loginCommand,
		logout: logoutCommand,
		whoami: whoamiCommand,
		upload: uploadCommand,
		import: importCommand,
		enable: uploadCommand,
		disable: uploadCommand,
		doctor: doctorCommand,
		"set-org": setOrgCommand,
		hooks: hooksRouteMap,
		dev: devRouteMap,
	},
	defaultCommand: "upload",
	docs: {
		brief: "Opaline CLI for Claude Code and Codex session analytics",
		hideRoute: {
			hooks: true,
			dev: true,
			connect: true,
			import: true,
			enable: true,
			disable: true,
			doctor: true,
			"set-org": true,
		},
	},
});

export const app = buildApplication(routes, {
	name: "opaline",
	versionInfo: {
		currentVersion: pkg.version,
	},
	scanner: {
		caseStyle: "allow-kebab-for-camel",
	},
});
