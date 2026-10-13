import { describe, expect, test } from "bun:test";
import { filterSessionTextFields } from "../index.js";

/**
 * Secrets that reached uploads through FILTER_VERSION 6, in the transcript
 * shapes they were found in: JSONL records whose strings escape quotes and
 * line breaks, tool calls whose arguments are JSON inside a JSON string, .env
 * and credentials-file dumps in tool results, and shell commands.
 *
 * This file is kept identical in opalinehq/athena (packages/secret-filter) and
 * opalinehq/cli (apps/cli/src/internal/secret-filter): both filters must turn
 * every input into the same bytes.
 *
 * Every value is fake and assembled at runtime.
 */

const pad = (value: string, length: number, fill: string) =>
	value.padEnd(length, fill);
const AWS_ID = ["AKIA", "CANARY234567ABCD"].join("");
const AWS_SESSION_ID = ["ASIA", "CANARY234567ABCD"].join("");
const AWS_SECRET = pad("CANARY/", 40, "Ab1+");
const OPENAI_PROJECT = ["sk-", "proj-", pad("CANARY", 48, "x")].join("");
const OPENAI_SERVICE = ["sk-", "svcacct-", pad("CANARY", 64, "y")].join("");
const OPENAI_LEGACY = ["sk-", pad("CANARY", 48, "z")].join("");
const ANTHROPIC_OAUTH = [
	"sk-ant-",
	"oat01-",
	pad("CANARY", 93, "q"),
	"AA",
].join("");
const ANTHROPIC_KEY = ["sk-ant-", "api03-", pad("CANARY", 93, "w"), "AA"].join(
	"",
);
const STRIPE_KEY = ["sk", "_live_", pad("CANARY", 24, "s")].join("");
const GITHUB_TOKEN = ["ghp", "_", pad("CANARY", 36, "g")].join("");
const JWT = [
	`eyJ${pad("CANARY", 33, "h")}`,
	`eyJ${pad("CANARY", 60, "p")}`,
	pad("CANARY", 43, "S"),
].join(".");
const DB_PASSWORD = pad("CANARYdb", 20, "9");
const OPAQUE_TOKEN = pad("CANARYtoken", 40, "T");
const PEM_LINES = [pad("CANARY", 64, "M"), pad("CANARY", 64, "N")];
const PEM_TAIL = [pad("CANARY", 64, "O"), pad("CANARY", 24, "P")];
const BEGIN = ["-----BEGIN", "PRIVATE KEY-----"].join(" ");
const END = ["-----END", "PRIVATE KEY-----"].join(" ");

const record = (content: unknown) =>
	JSON.stringify({ type: "user", message: { role: "user", content } });
const toolResult = (content: string) =>
	record([{ type: "tool_result", tool_use_id: "toolu_1", content }]);
const toolUse = (input: Record<string, unknown>) =>
	JSON.stringify({
		type: "assistant",
		message: {
			role: "assistant",
			content: [{ type: "tool_use", name: "Bash", id: "toolu_1", input }],
		},
	});
const codexCall = (command: string) =>
	JSON.stringify({
		type: "response_item",
		payload: {
			type: "function_call",
			name: "shell",
			arguments: JSON.stringify({ command: ["bash", "-lc", command] }),
		},
	});

interface LeakCase {
	readonly name: string;
	readonly input: string;
	readonly expected: string;
	readonly counts: Readonly<Record<string, number>>;
	readonly secrets: readonly string[];
}

const LEAKS: readonly LeakCase[] = [
	{
		name: "AWS key pair in a prompt",
		input: record(`my key ${AWS_ID} and AWS_SECRET_ACCESS_KEY=${AWS_SECRET}`),
		expected: record(
			"my key [REDACTED:aws-access-key-id] and AWS_SECRET_ACCESS_KEY=[REDACTED:aws-secret-access-key]",
		),
		counts: { "aws-access-key-id": 1, "aws-secret-access-key": 1 },
		secrets: [AWS_ID, AWS_SECRET],
	},
	{
		name: "AWS credentials file in a tool result",
		input: toolResult(
			`[default]\naws_access_key_id = ${AWS_ID}\naws_secret_access_key = ${AWS_SECRET}\n`,
		),
		expected: toolResult(
			"[default]\naws_access_key_id = [REDACTED:aws-access-key-id]\naws_secret_access_key = [REDACTED:aws-secret-access-key]\n",
		),
		counts: { "aws-access-key-id": 1, "aws-secret-access-key": 1 },
		secrets: [AWS_ID, AWS_SECRET],
	},
	{
		name: "STS credentials printed as JSON inside a tool result",
		input: toolResult(
			JSON.stringify(
				{
					Credentials: {
						AccessKeyId: AWS_SESSION_ID,
						SecretAccessKey: AWS_SECRET,
						SessionToken: "<session-token>",
					},
				},
				null,
				2,
			),
		),
		expected: toolResult(
			JSON.stringify(
				{
					Credentials: {
						AccessKeyId: "[REDACTED:aws-access-key-id]",
						SecretAccessKey: "[REDACTED:aws-secret-access-key]",
						SessionToken: "<session-token>",
					},
				},
				null,
				2,
			),
		),
		counts: { "aws-access-key-id": 1, "aws-secret-access-key": 1 },
		secrets: [AWS_SESSION_ID, AWS_SECRET],
	},
	{
		name: "AWS key pair in an IAM CSV export",
		input: toolResult(
			`User name,Password,Access key ID,Secret access key\nalice,,${AWS_ID},${AWS_SECRET}\n`,
		),
		expected: toolResult(
			"User name,Password,Access key ID,Secret access key\nalice,,[REDACTED:aws-access-key-id],[REDACTED:aws-secret-access-key-pair]\n",
		),
		counts: { "aws-access-key-id": 1, "aws-secret-access-key-pair": 1 },
		secrets: [AWS_ID, AWS_SECRET],
	},
	{
		name: "AWS secret next to an id an older filter already redacted",
		input: record(`[REDACTED:aws-access-key-id] ${AWS_SECRET}`),
		expected: record(
			"[REDACTED:aws-access-key-id] [REDACTED:aws-secret-access-key-pair]",
		),
		counts: { "aws-secret-access-key-pair": 1 },
		secrets: [AWS_SECRET],
	},
	{
		name: "OpenAI keys exported in a shell command",
		input: toolUse({
			command: `export OPENAI_API_KEY=${OPENAI_PROJECT}\nexport SVC=${OPENAI_SERVICE}; OLD=${OPENAI_LEGACY} node run.js`,
		}),
		expected: toolUse({
			command:
				"export OPENAI_API_KEY=[REDACTED:openai-api-key]\nexport SVC=[REDACTED:openai-api-key]; OLD=[REDACTED:openai-api-key] node run.js",
		}),
		counts: { "openai-api-key": 3 },
		secrets: [OPENAI_PROJECT, OPENAI_SERVICE, OPENAI_LEGACY],
	},
	{
		name: "Claude Code OAuth token on its own line",
		input: toolResult(`token:\n${ANTHROPIC_OAUTH}\n`),
		expected: toolResult("token:\n[REDACTED:anthropic-api-key]\n"),
		counts: { "anthropic-api-key": 1 },
		secrets: [ANTHROPIC_OAUTH],
	},
	{
		name: "JWT as a curl bearer token",
		input: toolUse({
			command: `curl -H "Authorization: Bearer ${JWT}" https://api.example.dev/me`,
		}),
		expected: toolUse({
			command:
				'curl -H "Authorization: Bearer [REDACTED:jwt]" https://api.example.dev/me',
		}),
		counts: { jwt: 1 },
		secrets: [JWT],
	},
	{
		name: "opaque bearer token in a request dump",
		input: toolResult(
			`> GET /v1/me HTTP/1.1\n> Authorization: Bearer ${OPAQUE_TOKEN}\n> Accept: */*`,
		),
		expected: toolResult(
			"> GET /v1/me HTTP/1.1\n> Authorization: Bearer [REDACTED:authorization-header]\n> Accept: */*",
		),
		counts: { "authorization-header": 1 },
		secrets: [OPAQUE_TOKEN],
	},
	{
		name: "connection strings in an .env dump",
		input: toolResult(
			[
				`DATABASE_URL=postgres://admin:${DB_PASSWORD}@db.internal.example.com:5432/app`,
				`MONGO_URL=mongodb+srv://app:${DB_PASSWORD}@cluster0.example.net/app?retryWrites=true`,
				`REDIS_URL=rediss://default:${DB_PASSWORD}@cache.example.com:6380`,
				`AMQP_URL=amqps://worker:p@ss${DB_PASSWORD}@mq.example.com/vhost`,
				"LOCAL_URL=postgres://postgres:postgres@localhost:5432/app",
				"DOCS_URL=postgres://user:password@localhost/app",
			].join("\n"),
		),
		expected: toolResult(
			[
				"DATABASE_URL=postgres://admin:[REDACTED:connection-string-password]@db.internal.example.com:5432/app",
				"MONGO_URL=mongodb+srv://app:[REDACTED:connection-string-password]@cluster0.example.net/app?retryWrites=true",
				"REDIS_URL=rediss://default:[REDACTED:connection-string-password]@cache.example.com:6380",
				"AMQP_URL=amqps://worker:[REDACTED:connection-string-password]@mq.example.com/vhost",
				"LOCAL_URL=postgres://postgres:postgres@localhost:5432/app",
				"DOCS_URL=postgres://user:password@localhost/app",
			].join("\n"),
		),
		counts: { "connection-string-password": 4 },
		secrets: [DB_PASSWORD],
	},
	{
		name: "psql command with a token in a git remote",
		input: toolUse({
			command: `psql "postgresql://app:${DB_PASSWORD}@db.example.dev/app" && git remote add origin https://x-access-token:${GITHUB_TOKEN}@github.com/acme/app.git`,
		}),
		expected: toolUse({
			command:
				'psql "postgresql://app:[REDACTED:connection-string-password]@db.example.dev/app" && git remote add origin https://x-access-token:[REDACTED:github-pat]@github.com/acme/app.git',
		}),
		counts: { "connection-string-password": 1, "github-pat": 1 },
		secrets: [DB_PASSWORD, GITHUB_TOKEN],
	},
	{
		name: "private key split across two JSON fields",
		input: JSON.stringify({
			type: "assistant",
			message: {
				content: [
					{
						type: "tool_use",
						name: "Edit",
						input: {
							old_string: `${BEGIN}\n${PEM_LINES.join("\n")}`,
							new_string: `${PEM_TAIL.join("\n")}\n${END}\n`,
						},
					},
				],
			},
		}),
		expected: JSON.stringify({
			type: "assistant",
			message: {
				content: [
					{
						type: "tool_use",
						name: "Edit",
						input: {
							old_string: "[REDACTED:private-key]",
							new_string: "[REDACTED:private-key-fragment]\n",
						},
					},
				],
			},
		}),
		counts: { "private-key": 1, "private-key-fragment": 1 },
		secrets: [...PEM_LINES, ...PEM_TAIL],
	},
	{
		name: "private key written by a Codex shell call",
		input: codexCall(
			`cat > key.pem <<EOF\n${BEGIN}\n${[...PEM_LINES, ...PEM_TAIL].join("\n")}\n${END}\nEOF`,
		),
		expected: codexCall("cat > key.pem <<EOF\n[REDACTED:private-key]\nEOF"),
		counts: { "private-key": 1 },
		secrets: [...PEM_LINES, ...PEM_TAIL],
	},
	{
		name: "keys at the start of escaped lines and before escaped quotes",
		input: codexCall(
			`printf '%s\\n' "${STRIPE_KEY}"\nexport ANTHROPIC_API_KEY=${ANTHROPIC_KEY}\n${AWS_ID}`,
		),
		expected: codexCall(
			"printf '%s\\n' \"[REDACTED:stripe-access-token]\"\nexport ANTHROPIC_API_KEY=[REDACTED:anthropic-api-key]\n[REDACTED:aws-access-key-id]",
		),
		counts: {
			"anthropic-api-key": 1,
			"aws-access-key-id": 1,
			"stripe-access-token": 1,
		},
		secrets: [STRIPE_KEY, ANTHROPIC_KEY, AWS_ID],
	},
	{
		name: "JSON writers that escape printable characters",
		// \u0041 is "A" (a hand-escaped key id); .NET escapes "+" as \u002B and
		// PHP escapes "/" as \/.
		input: [
			`{"c":"\\u0041${AWS_ID.slice(1)}"}`,
			`{"SecretAccessKey":"${AWS_SECRET.replaceAll("+", "\\u002B").replaceAll("/", "\\/")}"}`,
			`{"url":"postgres:\\/\\/app:${DB_PASSWORD}@db.example.dev\\/app"}`,
		].join("\n"),
		expected: [
			'{"c":"[REDACTED:aws-access-key-id]"}',
			'{"SecretAccessKey":"[REDACTED:aws-secret-access-key]"}',
			'{"url":"postgres:\\/\\/app:[REDACTED:connection-string-password]@db.example.dev\\/app"}',
		].join("\n"),
		counts: {
			"aws-access-key-id": 1,
			"aws-secret-access-key": 1,
			"connection-string-password": 1,
		},
		secrets: [AWS_ID.slice(1), DB_PASSWORD, AWS_SECRET.slice(7, 20)],
	},
];

describe("secrets that reached FILTER_VERSION 6 uploads", () => {
	for (const leak of LEAKS) {
		test(leak.name, () => {
			const content = `${leak.input}\n`;
			const result = filterSessionTextFields({ content, subagents: undefined });

			expect(result.content).toBe(`${leak.expected}\n`);
			expect(result.counts).toEqual(leak.counts);
			for (const secret of leak.secrets) {
				expect(result.content).not.toContain(secret);
			}
			for (const line of result.content.trim().split("\n")) {
				expect(() => JSON.parse(line)).not.toThrow();
			}
			expect(
				filterSessionTextFields({
					content: result.content,
					subagents: undefined,
				}).counts,
			).toEqual({});
		});
	}
});
