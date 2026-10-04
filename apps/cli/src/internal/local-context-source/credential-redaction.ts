import {
	filterKnownSecrets,
	getUtf8ByteLength,
	mergeRedactionCounts,
	type RedactionCounts,
	type SecretFilterResult,
} from "../secret-filter/index.js";

/**
 * Credential redaction for captured context (memory, instructions, rules,
 * personal files, saved tool outputs, supporting files, configuration
 * summaries). The vendor-pattern secret filter only knows token formats;
 * these rules add what people write by hand:
 * - credential assignments (`password: x`, `INTERNAL_API_KEY=x`,
 *   `"apiKey": "x"`, `?token=x`) whose name has a credential word as one of
 *   its parts;
 * - credential flags (`--token x`, `--api-key=x`);
 * - `Authorization`-style `Bearer x` / `Basic x` / `Token x` values;
 * - passwords in connection strings (`postgres://user:pass@host`);
 * - JWT-shaped tokens.
 * Names and structure stay; only values are replaced.
 */

export const CREDENTIAL_ASSIGNMENT_RULE = "credential-assignment";
export const CREDENTIAL_FLAG_RULE = "credential-flag";
export const AUTHORIZATION_VALUE_RULE = "authorization-value";
export const CONNECTION_STRING_RULE = "connection-string-password";
export const JWT_RULE = "jwt";
export const REDACTED = "[REDACTED]";

type Redactor = (ruleId: string, original: string) => string;

const CREDENTIAL_WORDS: ReadonlySet<string> = new Set([
	"key",
	"apikey",
	"token",
	"tokens",
	"secret",
	"secrets",
	"password",
	"passwords",
	"passwd",
	"pwd",
	"pass",
	"credential",
	"credentials",
	"auth",
	"authorization",
	"cookie",
	"cookies",
	"session",
	"sessionid",
	"pat",
]);
const CREDENTIAL_SUFFIXES = [
	"key",
	"token",
	"secret",
	"password",
	"passwd",
	"pwd",
];
const STOP_VALUES: ReadonlySet<string> = new Set([
	"true",
	"false",
	"null",
	"none",
	"nil",
	"undefined",
	"required",
	"optional",
	"enabled",
	"disabled",
	"redacted",
]);

const ASSIGNMENT_PATTERN =
	/(?<![A-Za-z0-9_])(["']?)([A-Za-z_][A-Za-z0-9_.-]{0,80})\1([ \t]*(?::|=)[ \t]*)(?:"([^"\n]{1,4096})"|'([^'\n]{1,4096})'|([^\s"'`,;&|)}\]]{1,4096}))/gu;
const FLAG_PATTERN =
	/(?<![A-Za-z0-9_-])(--?[A-Za-z][A-Za-z0-9-]{0,60})([ \t]+)(?!-)(?:"([^"\n]{1,4096})"|'([^'\n]{1,4096})'|([^\s"'`|;&]{1,4096}))/gu;
const AUTHORIZATION_PATTERN =
	/\b(Bearer|Basic|Token)([ \t]+)([A-Za-z0-9._~+/=-]{8,4096})/gu;
const CONNECTION_STRING_PATTERN =
	/\b([A-Za-z][A-Za-z0-9+.-]{1,30}:\/\/[^\s:/@"'`]{0,256}:)([^\s@/"'`]{1,512})(@)/gu;
const JWT_PATTERN =
	/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/gu;

/** Whether one of a name's parts (snake, kebab, dotted or camel case) is a credential word. */
export function isCredentialName(name: string): boolean {
	const parts = name
		.replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
		.toLowerCase()
		.split(/[^a-z0-9]+/u)
		.filter((part) => part.length > 0);
	return parts.some(
		(part) =>
			CREDENTIAL_WORDS.has(part) ||
			CREDENTIAL_SUFFIXES.some(
				(suffix) => part.length > suffix.length && part.endsWith(suffix),
			),
	);
}

/**
 * Whether a value next to a credential name is plausibly the credential
 * rather than prose, a type, a placeholder or a reference to one.
 */
export function isCredentialValue(value: string): boolean {
	const trimmed = value.trim();
	if (trimmed.length < 6) return false;
	if (STOP_VALUES.has(trimmed.toLowerCase())) return false;
	if (/^\[REDACTED/u.test(trimmed)) return false;
	if (/^(?:\$|%|<|\{\{|process\.env|os\.environ|env\.|ENV\[)/u.test(trimmed))
		return false;
	if (/^\d+(?:\.\d+)?$/u.test(trimmed)) return false;
	// Short single words are prose or type names ("string", "Promise").
	if (/^[A-Za-z]+$/u.test(trimmed) && trimmed.length < 12) return false;
	// Dotted identifiers and calls are code references ("config.apiKey").
	if (/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+$/u.test(trimmed)) return false;
	if (/^[A-Za-z_][\w.]*\(/u.test(trimmed)) return false;
	return true;
}

/** Credential rules only (no vendor patterns); returns counts per rule. */
export function redactCredentialText(
	text: string,
	redact: Redactor = (ruleId) => `[REDACTED:${ruleId}]`,
): SecretFilterResult {
	// Every rule needs one of these hints on the same line; most lines of code
	// and prose have none, so they are passed through untouched.
	if (!CREDENTIAL_HINT.test(text))
		return { text, counts: {}, redactedBytes: 0 };
	const counts: Record<string, number> = {};
	let redactedBytes = 0;
	const lines = text.split("\n");
	for (const [index, line] of lines.entries()) {
		if (!CREDENTIAL_HINT.test(line)) continue;
		const result = redactCredentialLine(line, redact);
		if (result.redactedBytes === 0) continue;
		lines[index] = result.text;
		redactedBytes += result.redactedBytes;
		for (const [ruleId, count] of Object.entries(result.counts))
			counts[ruleId] = (counts[ruleId] ?? 0) + count;
	}
	return {
		text: redactedBytes === 0 ? text : lines.join("\n"),
		counts,
		redactedBytes,
	};
}

const CREDENTIAL_HINT =
	/key|token|secret|pass|pwd|credential|auth|cookie|session|pat|bearer|basic|:\/\/|eyJ/iu;

function redactCredentialLine(
	text: string,
	redact: Redactor,
): SecretFilterResult {
	const counts: Record<string, number> = {};
	let redactedBytes = 0;
	const record = (ruleId: string, original: string) => {
		counts[ruleId] = (counts[ruleId] ?? 0) + 1;
		redactedBytes += getUtf8ByteLength(original);
		return redact(ruleId, original);
	};
	let result = text.replace(
		CONNECTION_STRING_PATTERN,
		(_match, prefix: string, password: string, at: string) =>
			isPlaceholder(password)
				? `${prefix}${password}${at}`
				: `${prefix}${record(CONNECTION_STRING_RULE, password)}${at}`,
	);
	result = result.replace(JWT_PATTERN, (token) => record(JWT_RULE, token));
	result = result.replace(
		AUTHORIZATION_PATTERN,
		(match, scheme: string, space: string, value: string) =>
			value.startsWith("[REDACTED") || !/\d|[._~+/=-]/u.test(value)
				? match
				: `${scheme}${space}${record(AUTHORIZATION_VALUE_RULE, value)}`,
	);
	result = replaceRescanning(result, ASSIGNMENT_PATTERN, (match) => {
		const [, quote = "", name = "", separator = ""] = match;
		const doubleQuoted = match[4];
		const singleQuoted = match[5];
		const value = doubleQuoted ?? singleQuoted ?? match[6] ?? "";
		if (!isCredentialName(name) || !isCredentialValue(value)) return null;
		// `Authorization: Bearer x` is handled by the authorization rule.
		if (/^(?:Bearer|Basic|Token)$/u.test(value)) return null;
		const replacement = record(CREDENTIAL_ASSIGNMENT_RULE, value);
		const wrapped =
			doubleQuoted !== undefined
				? `"${replacement}"`
				: singleQuoted !== undefined
					? `'${replacement}'`
					: replacement;
		return `${quote}${name}${quote}${separator}${wrapped}`;
	});
	result = result.replace(
		FLAG_PATTERN,
		(
			match,
			flag: string,
			separator: string,
			doubleQuoted: string | undefined,
			singleQuoted: string | undefined,
			bare: string | undefined,
		) => {
			const value = doubleQuoted ?? singleQuoted ?? bare ?? "";
			if (
				!isCredentialName(flag.replace(/^-+/u, "")) ||
				!isCredentialValue(value)
			)
				return match;
			const replacement = record(CREDENTIAL_FLAG_RULE, value);
			return `${flag}${separator}${
				doubleQuoted !== undefined
					? `"${replacement}"`
					: singleQuoted !== undefined
						? `'${replacement}'`
						: replacement
			}`;
		},
	);
	return { text: result, counts, redactedBytes };
}

/**
 * The filter for captured context text: vendor secret patterns, then the
 * credential rules. Counts of both are merged.
 */
export function filterContextText(text: string): SecretFilterResult {
	const known = filterKnownSecrets(text);
	const credentials = redactCredentialText(known.text);
	return {
		text: credentials.text,
		counts: mergeRedactionCounts(known.counts, credentials.counts),
		redactedBytes: known.redactedBytes + credentials.redactedBytes,
	};
}

/**
 * A shell command with credentials removed token by token: credential
 * environment assignments (`INTERNAL_API_KEY=x`, `export FOO_TOKEN=x`),
 * credential flags with `=` or space-separated values, and `Bearer`/`Basic`
 * values; then the credential and known-secret text rules.
 */
export function sanitizeCommandString(command: string): string {
	const tokens = tokenizeCommand(command);
	let redactNext = false;
	let bearerNext = false;
	const out = tokens.map((token) => {
		if (token.kind === "space") return token.text;
		const value = unquote(token.text);
		if (redactNext && !value.startsWith("-")) {
			redactNext = false;
			return requote(token.text, REDACTED);
		}
		redactNext = false;
		if (bearerNext) {
			bearerNext = false;
			if (value.length >= 6) return requote(token.text, REDACTED);
		}
		const assignment = /^((?:--?)?[A-Za-z_][A-Za-z0-9_.-]*)=(.*)$/su.exec(
			value,
		);
		if (
			assignment?.[1] &&
			isCredentialName(assignment[1].replace(/^-+/u, ""))
		) {
			const assigned = assignment[2] ?? "";
			if (assigned === "") return token.text;
			// Keep quotes around the value (`FOO_TOKEN="x"`) or the whole token.
			const valueQuote = /^(["']).*\1$/su.exec(assigned)?.[1];
			return valueQuote !== undefined && !/^["']/u.test(token.text)
				? `${assignment[1]}=${valueQuote}${REDACTED}${valueQuote}`
				: requote(token.text, `${assignment[1]}=${REDACTED}`);
		}
		if (/^--?[A-Za-z][A-Za-z0-9-]*$/u.test(value) && isCredentialName(value))
			redactNext = true;
		if (/^(?:Bearer|Basic|Token)$/u.test(value)) bearerNext = true;
		return token.text;
	});
	return filterKnownSecrets(
		redactCredentialText(out.join(""), () => REDACTED).text,
		() => REDACTED,
	).text;
}

/** A URL without user information, query string or fragment. */
export function sanitizeUrlString(value: string): string {
	try {
		const url = new URL(value);
		url.username = "";
		url.password = "";
		url.search = "";
		url.hash = "";
		return url.toString();
	} catch {
		return REDACTED;
	}
}

/**
 * Command-line arguments: a value following a credential-like flag
 * (`--api-key x`), a credential-named `=` assignment and any argument the
 * text rules recognize are replaced.
 */
export function sanitizeArgumentList(value: unknown): readonly string[] {
	if (!Array.isArray(value)) return [];
	const cleaned: string[] = [];
	let redactNext = false;
	for (const item of value) {
		if (typeof item !== "string") continue;
		if (redactNext && !item.startsWith("-")) {
			cleaned.push(REDACTED);
			redactNext = false;
			continue;
		}
		redactNext = false;
		const assignment = /^(-{0,2}[^=\s]+)=(.*)$/su.exec(item);
		if (
			assignment?.[1] &&
			isCredentialName(assignment[1].replace(/^-+/u, ""))
		) {
			cleaned.push(`${assignment[1]}=${REDACTED}`);
			continue;
		}
		if (/^-{1,2}\S+$/u.test(item) && isCredentialName(item.replace(/^-+/u, "")))
			redactNext = true;
		cleaned.push(sanitizeCommandString(item));
	}
	return cleaned;
}

const VALUE_ONLY_KEYS: ReadonlySet<string> = new Set([
	"env",
	"environment",
	"headers",
	"http_headers",
	"httpheaders",
	"env_http_headers",
	"requestheaders",
	"request_headers",
]);
const URL_KEYS: ReadonlySet<string> = new Set([
	"url",
	"uri",
	"endpoint",
	"serverurl",
	"server_url",
	"baseurl",
	"base_url",
]);
const MAX_DOCUMENT_DEPTH = 32;

/**
 * An MCP server configuration document with credentials removed and its
 * structure kept: values (not names) of environment variables and headers,
 * credential arguments, URL user information and query strings, values
 * under credential-named keys, and credentials inside commands and other
 * strings.
 */
export function sanitizeMcpDocument(value: unknown, depth = 0): unknown {
	if (depth > MAX_DOCUMENT_DEPTH) return REDACTED;
	if (typeof value === "string")
		return filterKnownSecrets(
			redactCredentialText(value, () => REDACTED).text,
			() => REDACTED,
		).text;
	if (Array.isArray(value))
		return value.map((item) => sanitizeMcpDocument(item, depth + 1));
	if (typeof value !== "object" || value === null) return value;
	const sanitized: Record<string, unknown> = {};
	for (const [key, child] of Object.entries(value)) {
		const normalized = key.toLowerCase();
		if (VALUE_ONLY_KEYS.has(normalized) && isRecord(child)) {
			sanitized[key] = Object.fromEntries(
				Object.keys(child).map((name) => [name, REDACTED]),
			);
		} else if (
			(normalized === "args" || normalized === "arguments") &&
			Array.isArray(child)
		) {
			sanitized[key] = sanitizeArgumentList(child);
		} else if (URL_KEYS.has(normalized) && typeof child === "string") {
			sanitized[key] = sanitizeUrlString(child);
		} else if (normalized === "command" && typeof child === "string") {
			sanitized[key] = sanitizeCommandString(child);
		} else if (
			isCredentialName(key) &&
			child !== null &&
			typeof child !== "boolean" &&
			typeof child !== "number" &&
			typeof child !== "object"
		) {
			sanitized[key] = REDACTED;
		} else {
			sanitized[key] = sanitizeMcpDocument(child, depth + 1);
		}
	}
	return sanitized;
}

/** Credential counts of a sanitized MCP document against its source text. */
export function sanitizeMcpText(text: string): {
	readonly text: string;
	readonly counts: RedactionCounts;
} | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return null;
	}
	const sanitized = `${JSON.stringify(sanitizeMcpDocument(parsed), null, 2)}\n`;
	const redactions = (sanitized.match(/\[REDACTED\]/gu) ?? []).length;
	return {
		text: sanitized,
		counts: redactions > 0 ? { "mcp-structural": redactions } : {},
	};
}

/**
 * Global replace that, when a match is rejected, resumes scanning where its
 * value starts (`valueGroupStart`), so a rejected match (`https://...`)
 * cannot hide an acceptable one inside its value (`?access_token=...`).
 */
function replaceRescanning(
	text: string,
	pattern: RegExp,
	replace: (match: RegExpExecArray) => string | null,
): string {
	const matcher = new RegExp(pattern.source, pattern.flags);
	const pieces: string[] = [];
	let cursor = 0;
	let match = matcher.exec(text);
	while (match !== null) {
		const replacement = replace(match);
		if (replacement === null) {
			// Skip the rejected name and separator, rescan the value.
			const head =
				(match[1] ?? "").length * 2 +
				(match[2] ?? "").length +
				(match[3] ?? "").length;
			matcher.lastIndex = match.index + Math.max(1, head);
		} else {
			pieces.push(text.slice(cursor, match.index), replacement);
			cursor = match.index + match[0].length;
			matcher.lastIndex = cursor;
		}
		match = matcher.exec(text);
	}
	pieces.push(text.slice(cursor));
	return pieces.join("");
}

interface CommandToken {
	readonly kind: "space" | "word";
	readonly text: string;
}

function tokenizeCommand(command: string): readonly CommandToken[] {
	const tokens: CommandToken[] = [];
	const pattern = /(\s+)|((?:"(?:[^"\\]|\\.)*"|'[^']*'|[^\s"'])+)|(["'])/gsu;
	for (const match of command.matchAll(pattern)) {
		if (match[1] !== undefined) tokens.push({ kind: "space", text: match[1] });
		else tokens.push({ kind: "word", text: match[0] });
	}
	return tokens;
}

function unquote(token: string): string {
	return token.replace(/^(["'])(.*)\1$/su, "$2");
}

function requote(token: string, value: string): string {
	const quote = /^(["']).*\1$/su.exec(token)?.[1];
	return quote === undefined ? value : `${quote}${value}${quote}`;
}

function isPlaceholder(value: string): boolean {
	return /^(?:\*+|x+|\$\{?\w+\}?|<[^>]*>|\[REDACTED[^\]]*\]|password|pass|secret)$/iu.test(
		value,
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
