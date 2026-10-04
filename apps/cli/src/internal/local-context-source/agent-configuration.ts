import { filterContextMetadata } from "./metadata-filter.js";
import type {
	UserAgentConfiguration,
	UserAgentConfigurationSource,
	UserAgentHook,
	UserAgentMcpServer,
	UserAgentScopedMcpServer,
	UserAgentSettingsLayer,
} from "./types.js";

/**
 * Summaries of user-level agent configuration: hook commands, MCP servers,
 * plugins and permissions. Only these fields are kept. Values of environment
 * variables and HTTP headers are never kept (only their names), URLs lose
 * credentials and query strings, any value under a credential-like key is
 * replaced, and every string then passes the known-secret filter.
 */

const MAX_STRING_CHARS = 512;
const MAX_LIST_ITEMS = 200;
const MAX_SUMMARY_BYTES = 64 * 1024;
const CREDENTIAL_KEY =
	/(?:token|secret|passw(?:or)?d|authori[sz]ation|auth|api[-_]?key|cookie|credential|private[-_]?key|session)/iu;
const REDACTED = "[REDACTED]";
const MAX_SETTINGS_DEPTH = 8;

export interface AgentConfigurationInputs {
	readonly claudeSettings: ParsedSource;
	readonly claudeInstalledPlugins: readonly string[];
	readonly codexConfig: ParsedSource;
	readonly codexHooks: ParsedSource;
	/** Further Claude Code settings layers (user-local, project, managed). */
	readonly claudeSettingsLayers?: readonly ScopedSource[];
	/**
	 * ~/.claude.json reduced to its MCP sections when it was read: the rest of
	 * that file (project history, caches) is never passed here.
	 */
	readonly claudeState?: {
		readonly source: UserAgentConfigurationSource;
		readonly mcpServers: unknown;
		readonly projectMcpServers: unknown;
	};
	readonly managedMcp?: ParsedSource;
}

export interface ScopedSource extends ParsedSource {
	readonly scope: UserAgentSettingsLayer["scope"];
}

export interface ParsedSource {
	readonly path: string;
	readonly status: UserAgentConfigurationSource["status"];
	readonly value: unknown;
}

export function summarizeUserAgentConfiguration(
	inputs: AgentConfigurationInputs,
): UserAgentConfiguration {
	const claude = asRecord(inputs.claudeSettings.value);
	const codex = asRecord(inputs.codexConfig.value);
	const codexHooks = asRecord(inputs.codexHooks.value);
	const permissions = asRecord(claude?.permissions);
	const summary: UserAgentConfiguration = {
		claude: {
			settings: describeSource(inputs.claudeSettings),
			hooks: summarizeHooks(claude?.hooks),
			enabledPlugins: summarizeFlags(claude?.enabledPlugins, (value) =>
				typeof value === "boolean" ? value : null,
			),
			permissions: {
				defaultMode: cleanString(permissions?.defaultMode),
				allow: cleanStrings(permissions?.allow),
				deny: cleanStrings(permissions?.deny),
				ask: cleanStrings(permissions?.ask),
				additionalDirectories: cleanStrings(permissions?.additionalDirectories),
			},
			installedPlugins: cleanStrings(inputs.claudeInstalledPlugins),
			settingsLayers: [
				{ ...inputs.claudeSettings, scope: "user" as const },
				...(inputs.claudeSettingsLayers ?? []),
			].map(
				(layer): UserAgentSettingsLayer => ({
					scope: layer.scope,
					...describeSource(layer),
					settings:
						layer.status === "parsed" ? sanitizeSettings(layer.value, 0) : null,
				}),
			),
			mcpServers: [
				...scopeServers(inputs.claudeState?.mcpServers, "user"),
				...scopeServers(inputs.claudeState?.projectMcpServers, "project"),
				...scopeServers(
					asRecord(inputs.managedMcp?.value)?.mcpServers,
					"managed",
				),
			].slice(0, MAX_LIST_ITEMS),
			stateFile: inputs.claudeState?.source ?? {
				path: "~/.claude.json",
				status: "absent",
			},
		},
		codex: {
			config: describeSource(inputs.codexConfig),
			hooksFile: describeSource(inputs.codexHooks),
			mcpServers: summarizeMcpServers(codex?.mcp_servers),
			notify: cleanStrings(codex?.notify),
			hooks: summarizeHooks(codexHooks?.hooks),
			plugins: summarizeFlags(codex?.plugins, readEnabled),
			features: summarizeFlags(codex?.features, readEnabled),
			apps: summarizeFlags(codex?.apps, readEnabled),
			connectors: summarizeFlags(codex?.connectors, readEnabled),
			tools: summarizeFlags(codex?.tools, readEnabled),
			approvalPolicy: cleanString(codex?.approval_policy),
			sandboxMode: cleanString(codex?.sandbox_mode),
		},
		truncated: false,
	};
	const filtered = filterContextMetadata(summary);
	if (Buffer.byteLength(JSON.stringify(filtered)) <= MAX_SUMMARY_BYTES)
		return filtered;
	// Keep the inventory (names) and drop the bulky detail when oversized.
	return filterContextMetadata({
		...summary,
		claude: {
			...summary.claude,
			hooks: summary.claude.hooks.map((hook) => ({ ...hook, command: null })),
			settingsLayers: summary.claude.settingsLayers.map((layer) => ({
				...layer,
				settings: null,
			})),
			mcpServers: summary.claude.mcpServers.map((server) => ({
				...server,
				args: [],
			})),
			permissions: {
				...summary.claude.permissions,
				allow: [],
				deny: [],
				ask: [],
			},
		},
		codex: {
			...summary.codex,
			mcpServers: summary.codex.mcpServers.map((server) => ({
				...server,
				args: [],
			})),
			hooks: summary.codex.hooks.map((hook) => ({ ...hook, command: null })),
		},
		truncated: true,
	});
}

function describeSource(source: ParsedSource): UserAgentConfigurationSource {
	return { path: source.path, status: source.status };
}

/** Claude Code and Codex share the `{ event: [{ matcher, hooks: [...] }] }` shape. */
function summarizeHooks(value: unknown): readonly UserAgentHook[] {
	const events = asRecord(value);
	if (!events) return [];
	const hooks: UserAgentHook[] = [];
	for (const [event, groups] of Object.entries(events)) {
		if (!Array.isArray(groups)) continue;
		for (const group of groups) {
			const record = asRecord(group);
			const matcher = cleanString(record?.matcher);
			const entries = Array.isArray(record?.hooks) ? record.hooks : [];
			for (const entry of entries) {
				const hook = asRecord(entry);
				if (!hook) continue;
				hooks.push({
					event: cleanString(event) ?? "",
					matcher,
					type: cleanString(hook.type),
					command: cleanString(hook.command),
					timeoutSeconds:
						typeof hook.timeout === "number" && Number.isFinite(hook.timeout)
							? hook.timeout
							: null,
					async: typeof hook.async === "boolean" ? hook.async : null,
				});
				if (hooks.length >= MAX_LIST_ITEMS) return hooks;
			}
		}
	}
	return hooks;
}

function readEnabled(value: unknown): boolean | null {
	if (typeof value === "boolean") return value;
	const enabled = asRecord(value)?.enabled;
	return typeof enabled === "boolean" ? enabled : null;
}

function scopeServers(
	value: unknown,
	scope: UserAgentScopedMcpServer["scope"],
): readonly UserAgentScopedMcpServer[] {
	return summarizeMcpServers(value).map((server) => ({ ...server, scope }));
}

/**
 * A settings layer with credentials removed: `env` keeps variable names only,
 * any value under a credential-like key is replaced, strings are cleaned and
 * length-bounded, and lists and nesting are bounded.
 */
function sanitizeSettings(value: unknown, depth: number): unknown {
	if (typeof value === "string") return truncate(value);
	if (typeof value === "number" || typeof value === "boolean" || value === null)
		return value;
	if (depth >= MAX_SETTINGS_DEPTH) return REDACTED;
	if (Array.isArray(value))
		return value
			.slice(0, MAX_LIST_ITEMS)
			.map((item) => sanitizeSettings(item, depth + 1));
	const record = asRecord(value);
	if (!record) return null;
	const sanitized: Record<string, unknown> = {};
	for (const [key, child] of Object.entries(record).slice(0, MAX_LIST_ITEMS)) {
		const name = truncate(key);
		if (key === "env") {
			sanitized[name] = Object.keys(asRecord(child) ?? {})
				.slice(0, MAX_LIST_ITEMS)
				.map((variable) => truncate(variable));
			continue;
		}
		sanitized[name] =
			CREDENTIAL_KEY.test(key) && child !== null && typeof child !== "boolean"
				? REDACTED
				: sanitizeSettings(child, depth + 1);
	}
	return sanitized;
}

function summarizeMcpServers(value: unknown): readonly UserAgentMcpServer[] {
	const servers = asRecord(value);
	if (!servers) return [];
	return Object.entries(servers)
		.slice(0, MAX_LIST_ITEMS)
		.map(([name, configuration]): UserAgentMcpServer => {
			const server = asRecord(configuration);
			const command = cleanString(server?.command);
			const url = sanitizeUrl(server?.url);
			const declared = server?.type;
			return {
				name: cleanString(name) ?? "",
				transport:
					declared === "stdio" || (declared === undefined && command !== null)
						? "stdio"
						: declared === "http" ||
								declared === "sse" ||
								(declared === undefined && url !== null)
							? "http"
							: "unknown",
				command,
				args: cleanArguments(server?.args),
				url,
				enabled: typeof server?.enabled === "boolean" ? server.enabled : null,
				envKeys: Object.keys(asRecord(server?.env) ?? {})
					.slice(0, MAX_LIST_ITEMS)
					.map((key) => truncate(key)),
				headerKeys: [
					...Object.keys(asRecord(server?.http_headers) ?? {}),
					...Object.keys(asRecord(server?.env_http_headers) ?? {}),
					...Object.keys(asRecord(server?.headers) ?? {}),
				]
					.slice(0, MAX_LIST_ITEMS)
					.map((key) => truncate(key)),
				bearerTokenEnvVar: cleanString(server?.bearer_token_env_var),
			};
		});
}

function summarizeFlags(
	value: unknown,
	read: (value: unknown) => boolean | null,
): Readonly<Record<string, boolean>> {
	const record = asRecord(value);
	if (!record) return {};
	const flags: Record<string, boolean> = {};
	for (const [name, entry] of Object.entries(record).slice(0, MAX_LIST_ITEMS)) {
		const flag = read(entry);
		if (flag !== null) flags[truncate(name)] = flag;
	}
	return flags;
}

/**
 * Command-line arguments: a value following a credential-like flag
 * (`--api-key x`, `--token=x`) is replaced, as is any argument that names a
 * credential with `=`.
 */
function cleanArguments(value: unknown): readonly string[] {
	if (!Array.isArray(value)) return [];
	const cleaned: string[] = [];
	let redactNext = false;
	for (const item of value.slice(0, MAX_LIST_ITEMS)) {
		if (typeof item !== "string") continue;
		if (redactNext) {
			cleaned.push(REDACTED);
			redactNext = false;
			continue;
		}
		const assignment = /^(-{0,2}[^=\s]+)=(.*)$/su.exec(item);
		if (assignment?.[1] && CREDENTIAL_KEY.test(assignment[1])) {
			cleaned.push(`${assignment[1]}=${REDACTED}`);
			continue;
		}
		if (/^-{1,2}\S+$/u.test(item) && CREDENTIAL_KEY.test(item))
			redactNext = true;
		cleaned.push(truncate(item));
	}
	return cleaned;
}

function sanitizeUrl(value: unknown): string | null {
	if (typeof value !== "string" || value.trim().length === 0) return null;
	try {
		const url = new URL(value);
		url.username = "";
		url.password = "";
		url.search = "";
		url.hash = "";
		return truncate(url.toString());
	} catch {
		return REDACTED;
	}
}

function cleanStrings(value: unknown): readonly string[] {
	if (!Array.isArray(value)) return [];
	return value
		.slice(0, MAX_LIST_ITEMS)
		.flatMap((item) => (typeof item === "string" ? [truncate(item)] : []));
}

function cleanString(value: unknown): string | null {
	return typeof value === "string" ? truncate(value) : null;
}

/**
 * Every kept string also loses inline credentials the known-secret rules may
 * not recognize: `Bearer <value>` / `Basic <value>` and `<credential-name>=`
 * or `<credential-name>: <value>` pairs.
 */
function truncate(value: string): string {
	const redacted = value
		.replace(
			/\b(bearer|basic)(\s+)[A-Za-z0-9._~+/=-]{6,}/giu,
			`$1$2${REDACTED}`,
		)
		.replace(
			/\b((?:x-)?(?:api[-_]?key|access[-_]?token|auth[-_]?token|token|secret|password|passwd)\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s"',;&|]+)/giu,
			`$1${REDACTED}`,
		);
	return redacted.length > MAX_STRING_CHARS
		? `${redacted.slice(0, MAX_STRING_CHARS)}…`
		: redacted;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? Object.fromEntries(Object.entries(value))
		: undefined;
}
