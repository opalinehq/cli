import { expect, test } from "bun:test";
import {
	askServiceEnvironment,
	launchAgentPlist,
	systemdUnit,
} from "../lib/ask/service-definition.js";

const environment = askServiceEnvironment({
	PATH: "/opt/homebrew/bin:/usr/bin",
	OPALINE_API_BASE: "http://localhost:3000",
	OPALINE_CONFIG_DIR: "/tmp/opaline & co/100%",
	RUDEL_CONFIG_DIR: "/tmp/rudel",
	ANTHROPIC_API_KEY: "sk-ant-secret",
	HOME: "/Users/someone",
});
const definition = {
	command: [
		"/usr/local/bin/node",
		"/Users/someone/.rudel/runtime/cli.js",
		"ask",
		"run",
		"--workspace",
		"acme",
	],
	environment,
	logPath: "/Users/someone/.rudel/logs/ask.log",
};

test("the service carries the API base, config directories and PATH, and nothing else from the environment", () => {
	expect(environment).toEqual({
		PATH: "/opt/homebrew/bin:/usr/bin",
		OPALINE_API_BASE: "http://localhost:3000",
		OPALINE_CONFIG_DIR: "/tmp/opaline & co/100%",
		RUDEL_CONFIG_DIR: "/tmp/rudel",
	});
});

test("the LaunchAgent runs the installed CLI at login, keeps it alive and escapes XML", () => {
	const plist = launchAgentPlist(definition);
	expect(plist).toContain("<string>so.opaline.ask</string>");
	expect(plist).toContain(
		"<string>/Users/someone/.rudel/runtime/cli.js</string>\n\t\t<string>ask</string>\n\t\t<string>run</string>\n\t\t<string>--workspace</string>\n\t\t<string>acme</string>",
	);
	expect(plist).toContain("<key>RunAtLoad</key>\n\t<true/>");
	expect(plist).toContain("<key>KeepAlive</key>\n\t<true/>");
	expect(plist).toContain(
		"<key>OPALINE_CONFIG_DIR</key>\n\t\t<string>/tmp/opaline &amp; co/100%</string>",
	);
	expect(plist).toContain(
		"<key>StandardErrorPath</key>\n\t<string>/Users/someone/.rudel/logs/ask.log</string>",
	);
	expect(plist).not.toContain("sk-ant-secret");
});

test("the systemd unit quotes arguments and escapes specifiers in the environment", () => {
	const unit = systemdUnit({
		...definition,
		command: [...definition.command.slice(0, 5), 'we"ird $slug'],
	});
	expect(unit).toContain(
		'ExecStart="/usr/local/bin/node" "/Users/someone/.rudel/runtime/cli.js" "ask" "run" "--workspace" "we\\"ird $$slug"',
	);
	expect(unit).toContain(
		'Environment="OPALINE_CONFIG_DIR=/tmp/opaline & co/100%%"',
	);
	expect(unit).toContain(
		'Environment="OPALINE_API_BASE=http://localhost:3000"',
	);
	expect(unit).toContain("Restart=always");
	expect(unit).toContain("WantedBy=default.target");
});
