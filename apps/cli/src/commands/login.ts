import * as p from "@clack/prompts";
import { buildCommand } from "@stricli/core";
import {
	type CliApiKeyCreateResponse,
	CliApiKeyCreateResponseSchema,
	type DeviceCodeResponse,
	DeviceCodeResponseSchema,
	DeviceFlowErrorResponseSchema,
	DeviceTokenResponseSchema,
	type ProductAnalyticsLoginFailureStage,
	parseSafeBrowserUrl,
	sanitizeForTerminalDisplay,
} from "../contracts/index.js";
import {
	allowsPlaintext,
	describeApiBaseRejection,
	resolveApiBase,
} from "../lib/api-base.js";
import { createApiClient } from "../lib/api-client.js";
import { getDefaultApiBase } from "../lib/api-target.js";
import { openUrl } from "../lib/browser-opener.js";
import { loadCredentials, saveCredentials } from "../lib/credentials.js";
import {
	CliProductAnalyticsEvents,
	captureCliProductAnalyticsEvent,
	getBaseCliEventPayload,
	getCliDistinctId,
	getNextCliLoginAttemptNumber,
	identifyCliProductAnalyticsUser,
	normalizeFailureReason,
	shouldDisableCliPersonProfile,
} from "../lib/product-analytics.js";

const DEVICE_CLIENT_ID = "rudel-cli";
const POLL_SAFETY_TIMEOUT_MS = 10 * 60_000;

/**
 * Human-readable failure drawn from an untrusted error payload.
 *
 * Server-supplied strings are sanitized because this message is printed to the
 * terminal, exactly like `user_code` is.
 */
function describeDeviceFlowFailure(body: unknown, fallback: string): string {
	const parsed = DeviceFlowErrorResponseSchema.safeParse(body);
	if (!parsed.success) {
		return fallback;
	}

	const supplied = parsed.data.error_description || parsed.data.message;
	return supplied ? sanitizeForTerminalDisplay(supplied) : fallback;
}

async function sleep(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Build the URL the user must visit to approve the device authorization.
 *
 * Uses `searchParams.set` rather than `?`-concatenation because the server's
 * `verification_uri` may already carry a query string (it is configurable via
 * `CLI_DEVICE_VERIFICATION_URL`), which naive concatenation would corrupt into a
 * malformed URL with two `?` separators.
 *
 * The result is untrusted — it comes from whatever server `--api-base` points at
 * — and must be passed through `parseSafeBrowserUrl` before being printed or
 * opened.
 */
export function buildVerificationUrl(
	device: Pick<
		DeviceCodeResponse,
		"verification_uri" | "verification_uri_complete" | "user_code"
	>,
): string {
	if (device.verification_uri_complete) {
		return device.verification_uri_complete;
	}

	try {
		const url = new URL(device.verification_uri);
		url.searchParams.set("user_code", device.user_code);
		return url.toString();
	} catch {
		// Return it unchanged and let the validator produce the user-facing
		// rejection, so there is a single place that reports a bad URL.
		return device.verification_uri;
	}
}

async function requestDeviceCode(apiBase: string): Promise<DeviceCodeResponse> {
	const response = await fetch(`${apiBase}/api/auth/device/code`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			client_id: DEVICE_CLIENT_ID,
			scope: "ingest:write",
		}),
	});

	const body = await response.json().catch(() => null);
	const parsed = DeviceCodeResponseSchema.safeParse(body);
	if (!response.ok || !parsed.success) {
		throw new Error(
			describeDeviceFlowFailure(
				body,
				`Failed to start device authorization (${response.status})`,
			),
		);
	}

	return parsed.data;
}

async function pollForAccessToken(
	apiBase: string,
	device: DeviceCodeResponse,
): Promise<string> {
	const hardDeadline = Date.now() + POLL_SAFETY_TIMEOUT_MS;
	const deviceDeadline = Date.now() + device.expires_in * 1000;
	const deadline = Math.min(hardDeadline, deviceDeadline);
	let intervalMs = Math.max(1_000, device.interval * 1000);

	while (Date.now() < deadline) {
		const response = await fetch(`${apiBase}/api/auth/device/token`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				grant_type: "urn:ietf:params:oauth:grant-type:device_code",
				device_code: device.device_code,
				client_id: DEVICE_CLIENT_ID,
			}),
		});

		const body = await response.json().catch(() => null);
		const parsed = DeviceTokenResponseSchema.safeParse(body);
		if (response.ok && parsed.success) {
			return parsed.data.access_token;
		}

		const errorPayload = DeviceFlowErrorResponseSchema.safeParse(body);
		const errorCode = errorPayload.success
			? (errorPayload.data.error ?? "")
			: "";

		if (errorCode === "authorization_pending") {
			await sleep(intervalMs);
			continue;
		}

		if (errorCode === "slow_down") {
			intervalMs += 1_000;
			await sleep(intervalMs);
			continue;
		}

		throw new Error(
			describeDeviceFlowFailure(body, "Device authorization failed"),
		);
	}

	throw new Error("Device authorization timed out");
}

async function createIngestApiKey(
	apiBase: string,
	accessToken: string,
): Promise<CliApiKeyCreateResponse> {
	const response = await fetch(`${apiBase}/api/auth/api-key/create`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${accessToken}`,
		},
		body: JSON.stringify({
			name: "rudel-cli-ingest",
			expiresIn: null,
		}),
	});

	const body = await response.json().catch(() => null);
	const parsed = CliApiKeyCreateResponseSchema.safeParse(body);
	if (!response.ok || !parsed.success) {
		throw new Error(
			describeDeviceFlowFailure(
				body,
				`Failed to create CLI API key (${response.status})`,
			),
		);
	}

	return parsed.data;
}

export async function runLogin(
	flags: {
		apiBase: string;
		allowInsecureApiBase: boolean;
		noBrowser: boolean;
	},
	connection?: {
		readonly id: string;
		readonly browserOrigin: string;
		readonly registerDevice: (deviceCode: string) => Promise<unknown>;
		readonly readUploadHistory?: (hasPreviousUploads: boolean) => void;
	},
): Promise<undefined | Error> {
	let openedBrowser = false;
	let attemptNumber = 1;
	const captureLoginFailure = (
		failureStage: ProductAnalyticsLoginFailureStage,
		error: unknown,
	) => {
		captureCliProductAnalyticsEvent({
			distinctId: getCliDistinctId(),
			event: CliProductAnalyticsEvents.CLI_LOGIN_FAILED,
			surface: "cli",
			disablePersonProfile: shouldDisableCliPersonProfile(),
			payload: {
				auth_flow: "device_authorization",
				failure_stage: failureStage,
				failure_reason: normalizeFailureReason(error),
				opened_browser: openedBrowser,
				attempt_number: attemptNumber,
				...getBaseCliEventPayload(),
			},
		});
	};

	p.intro("opaline login");

	const existing = loadCredentials();
	if (existing && !connection) {
		p.log.warn("Already logged in.");
		p.outro("Run `opaline logout` first to switch accounts.");
		return;
	}
	attemptNumber = getNextCliLoginAttemptNumber();
	captureCliProductAnalyticsEvent({
		distinctId: getCliDistinctId(),
		event: CliProductAnalyticsEvents.CLI_LOGIN_STARTED,
		surface: "cli",
		disablePersonProfile: true,
		payload: {
			auth_flow: "device_authorization",
			opened_browser: false,
			attempt_number: attemptNumber,
			...getBaseCliEventPayload(),
		},
	});

	// Resolved once and threaded through both URL checks below, so a plaintext
	// self-hosted deployment cannot pass one gate and fail the other.
	const allowPlaintext = allowsPlaintext(flags.allowInsecureApiBase);

	// Validate before any network call: this base receives the device code, the
	// access token and the minted ingest API key (RUD-237).
	const apiBaseResult = resolveApiBase(flags.apiBase, allowPlaintext);
	if (!apiBaseResult.ok) {
		const error = new Error(
			`Refusing to use --api-base ${sanitizeForTerminalDisplay(flags.apiBase)}: ${describeApiBaseRejection(apiBaseResult)}`,
		);
		captureLoginFailure("api_base_rejected", error);
		return error;
	}
	const apiBase = apiBaseResult.url;

	let deviceCode: DeviceCodeResponse;
	try {
		deviceCode = await requestDeviceCode(apiBase);
	} catch (error) {
		captureLoginFailure("device_code_request", error);
		return error instanceof Error ? error : new Error(String(error));
	}
	// The verification URL is server-controlled. Validate it before it reaches the
	// terminal or a platform opener, and use the reserialized form so control
	// characters stay percent-encoded (RUD-203).
	const rawVerifyUrl = connection
		? new URL(
				`/welcome?user_code=${encodeURIComponent(deviceCode.user_code)}`,
				connection.browserOrigin,
			).toString()
		: buildVerificationUrl(deviceCode);
	const verifyUrlResult = parseSafeBrowserUrl(rawVerifyUrl, { allowPlaintext });
	if (!verifyUrlResult.ok) {
		const error = new Error(
			`Refusing the verification URL returned by ${sanitizeForTerminalDisplay(apiBase)}: ${verifyUrlResult.detail}. Received: ${sanitizeForTerminalDisplay(rawVerifyUrl)}`,
		);
		captureLoginFailure("verification_url_rejected", error);
		return error;
	}
	let verifyUrl = verifyUrlResult.url;
	if (connection) {
		await connection.registerDevice(deviceCode.device_code);
		const connectedUrl = new URL(verifyUrl);
		connectedUrl.searchParams.set("connect", connection.id);
		verifyUrl = connectedUrl.toString();
	}

	p.log.info(`If the browser doesn't open, visit:\n${verifyUrl}`);
	// `user_code` is server-controlled and printed raw to the terminal, so it is
	// an ANSI/OSC injection vector even though the URL beside it is safe.
	p.log.info(`User code: ${sanitizeForTerminalDisplay(deviceCode.user_code)}`);

	if (!flags.noBrowser) {
		openUrl(verifyUrl);
		openedBrowser = true;
	}

	const spin = p.spinner();
	spin.start("Waiting for browser authentication...");

	let accessToken: string;
	try {
		accessToken = await pollForAccessToken(apiBase, deviceCode);
	} catch (error) {
		const failureReason = normalizeFailureReason(error);
		captureLoginFailure(
			failureReason === "timeout"
				? "browser_approval_timeout"
				: "token_exchange",
			error,
		);
		spin.stop("Authentication failed");
		return error instanceof Error ? error : new Error(String(error));
	}

	spin.message("Creating ingest token...");
	let ingestKey: CliApiKeyCreateResponse;
	try {
		ingestKey = await createIngestApiKey(apiBase, accessToken);
	} catch (error) {
		captureLoginFailure("api_key_create", error);
		spin.stop("Authentication failed");
		return error instanceof Error ? error : new Error(String(error));
	}

	const client = createApiClient({
		apiBaseUrl: apiBase,
		token: accessToken,
		authType: "bearer",
	});

	let user: { id: string; email: string; name: string };
	let organizations: Array<{ id: string; name: string; slug: string }>;
	try {
		const [me, orgs] = await Promise.all([
			client.me(),
			client.listMyOrganizations(),
		]);
		user = { id: me.id, email: me.email, name: me.name };
		organizations = orgs.map((org) => ({
			id: org.id,
			name: org.name,
			slug: org.slug,
		}));
		if (connection?.readUploadHistory) {
			const setup = await client.cli.setupStatus();
			connection.readUploadHistory(setup.hasUploadedSessions === true);
		}
	} catch (error) {
		captureLoginFailure("account_fetch", error);
		spin.stop("Authentication failed");
		return new Error("Login failed: unable to fetch account details");
	}

	try {
		saveCredentials({
			token: ingestKey.key,
			apiBaseUrl: apiBase,
			authType: "api-key",
			apiKeyId: ingestKey.id,
			user,
			organizations,
		});
	} catch (error) {
		captureLoginFailure("account_fetch", error);
		spin.stop("Authentication failed");
		return new Error("Login failed: unable to persist credentials");
	}

	identifyCliProductAnalyticsUser(user.id);
	captureCliProductAnalyticsEvent({
		distinctId: user.id,
		event: CliProductAnalyticsEvents.CLI_LOGIN_APPROVED,
		surface: "cli",
		payload: {
			user_id: user.id,
			auth_flow: "device_authorization",
			opened_browser: openedBrowser,
			...getBaseCliEventPayload(),
		},
	});
	spin.stop("Authenticated");
	p.log.success(`Logged in as ${user.name} (${user.email})`);
	p.outro("Done!");
}

export const loginCommand = buildCommand({
	loader: async () => ({ default: runLogin }),
	parameters: {
		flags: {
			apiBase: {
				kind: "parsed",
				parse: String,
				brief: "API server base URL",
				default: getDefaultApiBase(),
			},
			allowInsecureApiBase: {
				kind: "boolean",
				brief:
					"Allow a plaintext http:// API base on a non-loopback host (sends credentials unencrypted)",
				default: false,
			},
			noBrowser: {
				kind: "boolean",
				brief: "Skip opening the browser automatically",
				default: false,
			},
		},
	},
	docs: {
		brief: "Authenticate with the Opaline API via browser login",
	},
});
