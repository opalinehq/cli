export const ASK_SERVICE_LABEL = "so.opaline.ask";
export const ASK_SYSTEMD_UNIT = "opaline-ask.service";

const PASSED_ENVIRONMENT = [
	"PATH",
	"OPALINE_API_BASE",
	"RUDEL_API_BASE",
	"OPALINE_CONFIG_DIR",
	"RUDEL_CONFIG_DIR",
	"OPALINE_ALLOW_INSECURE_API_BASE",
	"CLAUDE_CONFIG_DIR",
];
const RESTART_DELAY_SECONDS = 30;

export interface AskServiceDefinition {
	readonly command: readonly string[];
	readonly environment: Readonly<Record<string, string>>;
	readonly logPath: string;
}

export function askServiceEnvironment(
	environment: NodeJS.ProcessEnv,
): Record<string, string> {
	const passed: Record<string, string> = {};
	for (const name of PASSED_ENVIRONMENT) {
		const value = environment[name];
		if (value) passed[name] = value;
	}
	return passed;
}

export function launchAgentPlist(definition: AskServiceDefinition): string {
	const strings = (values: readonly string[]) =>
		values.map((value) => `\t\t<string>${xml(value)}</string>`).join("\n");
	const environment = Object.entries(definition.environment)
		.map(
			([name, value]) =>
				`\t\t<key>${xml(name)}</key>\n\t\t<string>${xml(value)}</string>`,
		)
		.join("\n");
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${ASK_SERVICE_LABEL}</string>
	<key>ProgramArguments</key>
	<array>
${strings(definition.command)}
	</array>
	<key>EnvironmentVariables</key>
	<dict>
${environment}
	</dict>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>ThrottleInterval</key>
	<integer>${RESTART_DELAY_SECONDS}</integer>
	<key>ProcessType</key>
	<string>Background</string>
	<key>StandardOutPath</key>
	<string>${xml(definition.logPath)}</string>
	<key>StandardErrorPath</key>
	<string>${xml(definition.logPath)}</string>
</dict>
</plist>
`;
}

export function systemdUnit(definition: AskServiceDefinition): string {
	const environment = Object.entries(definition.environment).map(
		([name, value]) => `Environment=${systemdQuote(`${name}=${value}`)}`,
	);
	return [
		"[Unit]",
		"Description=Opaline Ask bridge",
		"After=network-online.target",
		"",
		"[Service]",
		`ExecStart=${definition.command.map(systemdQuote).join(" ")}`,
		...environment,
		"Restart=always",
		`RestartSec=${RESTART_DELAY_SECONDS}`,
		`StandardOutput=append:${systemdPath(definition.logPath)}`,
		`StandardError=append:${systemdPath(definition.logPath)}`,
		"",
		"[Install]",
		"WantedBy=default.target",
		"",
	].join("\n");
}

function xml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&apos;");
}

function systemdQuote(value: string): string {
	const escaped = value
		.replaceAll("\\", "\\\\")
		.replaceAll('"', '\\"')
		.replaceAll("%", "%%")
		.replaceAll("$", "$$$$");
	return `"${escaped}"`;
}

function systemdPath(value: string): string {
	return value.replaceAll("%", "%%");
}
