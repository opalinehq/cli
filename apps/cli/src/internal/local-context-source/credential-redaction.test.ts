import { describe, expect, test } from "bun:test";
import {
	filterContextText,
	isCredentialName,
	sanitizeArgumentList,
	sanitizeCommandString,
	sanitizeMcpText,
} from "./credential-redaction.js";

const OPAQUE = "kQ9zr2_Opaque7Value";

describe("credential text redaction", () => {
	test.each([
		[`password: ${OPAQUE}`, "credential-assignment"],
		[`db_password = "${OPAQUE}"`, "credential-assignment"],
		[`INTERNAL_API_KEY=${OPAQUE}`, "credential-assignment"],
		[`export FOO_TOKEN='${OPAQUE} with spaces'`, "credential-assignment"],
		[`{"apiKey": "${OPAQUE}"}`, "credential-assignment"],
		[
			`https://api.example/v1?access_token=${OPAQUE}&page=2`,
			"credential-assignment",
		],
		[`run --token ${OPAQUE} --region eu`, "credential-flag"],
		[`run --client-secret "${OPAQUE}"`, "credential-flag"],
		[`curl -H "Authorization: Bearer ${OPAQUE}"`, "authorization-value"],
		[
			`DATABASE_URL=postgres://app:${OPAQUE}@db.internal:5432/app`,
			"connection-string-password",
		],
		[
			`mongodb+srv://reader:${OPAQUE}@cluster0.example.net/db`,
			"connection-string-password",
		],
		[`redis://:${OPAQUE}@cache:6379/0`, "connection-string-password"],
		[
			"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
			"jwt",
		],
	])("redacts %s", (text, ruleId) => {
		const result = filterContextText(text);
		expect(result.text).not.toContain(OPAQUE);
		expect(result.text).not.toContain("dozjgNryP4J3jVmNHl0w5N");
		expect(result.counts[ruleId]).toBeGreaterThan(0);
		expect(filterContextText(result.text).text).toBe(result.text);
	});

	test("redacts private key blocks", () => {
		const key = [
			"-----BEGIN PRIVATE KEY-----",
			"MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj",
			"MzEfYyjiWA4R4/M2bS1GB4t7NXp98C3SC6dVMvDuictGeurT8jNbvJZHtCSuYEvu",
			"-----END PRIVATE KEY-----",
		].join("\n");
		const result = filterContextText(`Deploy key:\n${key}\n`);
		expect(result.text).not.toContain("MIIEvQIBADANBgkqhkiG9w0BAQEFAASC");
		expect(result.counts["private-key"]).toBe(1);
	});

	test("keeps JSON documents valid", () => {
		const result = filterContextText(
			JSON.stringify({ apiKey: OPAQUE, sessionToken: OPAQUE, port: 5432 }),
		);
		expect(JSON.parse(result.text)).toEqual({
			apiKey: "[REDACTED:credential-assignment]",
			sessionToken: "[REDACTED:credential-assignment]",
			port: 5432,
		});
	});

	test.each([
		"The token: string field holds the value.",
		"password: optional",
		"apiKey: config.apiKey",
		"key: value",
		"auth: required",
		"Use the --token flag to pass it.",
		"tokenCount: 1234567",
		"Authorization: Bearer",
		"postgres://${DB_USER}:${DB_PASSWORD}@localhost/app",
		"monkey: banana",
	])("leaves prose, types and references alone: %s", (text) => {
		expect(filterContextText(text).text).toBe(text);
	});

	test("recognizes credential words as name parts only", () => {
		for (const name of [
			"INTERNAL_API_KEY",
			"apiKey",
			"x-api-key",
			"dbPassword",
			"AUTH_TOKEN",
			"session_cookie",
			"github.pat",
			"accesskey",
		])
			expect(isCredentialName(name)).toBe(true);
		for (const name of ["keyboard", "author", "passage", "tokenizer", "region"])
			expect(isCredentialName(name)).toBe(false);
	});
});

describe("command and MCP sanitizing", () => {
	test("tokenizes commands and redacts credential assignments and flags", () => {
		expect(
			sanitizeCommandString(
				`INTERNAL_API_KEY=${OPAQUE} export FOO_TOKEN="${OPAQUE}" deploy --token ${OPAQUE} --password=${OPAQUE} -H 'Authorization: Bearer ${OPAQUE}' --region eu`,
			),
		).toBe(
			`INTERNAL_API_KEY=[REDACTED] export FOO_TOKEN="[REDACTED]" deploy --token [REDACTED] --password=[REDACTED] -H 'Authorization: Bearer [REDACTED]' --region eu`,
		);
		expect(sanitizeCommandString("opaline hooks claude session-end")).toBe(
			"opaline hooks claude session-end",
		);
	});

	test("redacts argument lists", () => {
		expect(
			sanitizeArgumentList([
				"server.js",
				"--api-key",
				OPAQUE,
				`--token=${OPAQUE}`,
				"--port",
				"3000",
			]),
		).toEqual([
			"server.js",
			"--api-key",
			"[REDACTED]",
			"--token=[REDACTED]",
			"--port",
			"3000",
		]);
	});

	test("sanitizes an MCP document structurally and keeps names", () => {
		const result = sanitizeMcpText(
			JSON.stringify({
				mcpServers: {
					internal: {
						command: "npx",
						args: ["-y", "@corp/mcp", "--api-key", OPAQUE],
						env: { INTERNAL_API_KEY: OPAQUE, LOG_LEVEL: "info" },
					},
					remote: {
						type: "http",
						url: `https://user:${OPAQUE}@mcp.corp.example/sse?token=${OPAQUE}`,
						headers: { Authorization: `Bearer ${OPAQUE}`, "X-Team": "core" },
					},
				},
			}),
		);
		expect(result).not.toBeNull();
		expect(result?.text).not.toContain(OPAQUE);
		expect(JSON.parse(result?.text ?? "")).toEqual({
			mcpServers: {
				internal: {
					command: "npx",
					args: ["-y", "@corp/mcp", "--api-key", "[REDACTED]"],
					env: { INTERNAL_API_KEY: "[REDACTED]", LOG_LEVEL: "[REDACTED]" },
				},
				remote: {
					type: "http",
					url: "https://mcp.corp.example/sse",
					headers: { Authorization: "[REDACTED]", "X-Team": "[REDACTED]" },
				},
			},
		});
		expect(sanitizeMcpText("{ not json")).toBeNull();
	});
});
