import { randomUUID } from "node:crypto";
import {
	existsSync,
	linkSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { ORPCError } from "@orpc/client";
import { PostHog } from "posthog-node";
import { z } from "zod";
import pkg from "../../package.json" with { type: "json" };
import type {
	ProductAnalyticsEventName,
	ProductAnalyticsEventPayload,
	ProductAnalyticsPlatformOs,
} from "../contracts/index.js";
import {
	PRODUCT_ANALYTICS_EVENT_VERSION,
	PRODUCT_ANALYTICS_EVENTS,
	parseProductAnalyticsEvent,
} from "../contracts/index.js";
import { debugLog } from "./debug.js";
import { getConfigDir } from "./local-state.js";
import {
	getProductAnalyticsConfig,
	getProductAnalyticsEnvironment,
} from "./product-analytics-config.js";

type CliSurface = "cli" | "hook";
type CliAutoProps = "event_version" | "surface" | "environment";
type CliCapturePayload<Name extends ProductAnalyticsEventName> = Omit<
	ProductAnalyticsEventPayload<Name>,
	CliAutoProps
>;

const ANALYTICS_STATE_FILE = "product-analytics.json";
// The installation's id outside the analytics state, so it is kept whether or
// not analytics is enabled. Never sent to the analytics service unless
// analytics is enabled.
const INSTALLATION_ID_FILE = "installation-id.json";
const InstallationIdFileSchema = z.object({
	version: z.literal(1),
	installationId: z.string().uuid(),
});

let client: PostHog | null | undefined;
const ephemeralInstallationId = randomUUID();
const AnalyticsStateSchema = z.object({
	cli_installation_id: z.string().min(1).optional(),
	cli_anonymous_id: z.string().min(1).optional(),
	cli_identified_user_id: z.string().min(1).optional(),
	cli_first_run_event_id: z.string().uuid().optional(),
	cli_first_run_delivered: z.boolean().optional(),
	cli_login_attempt_count: z.number().int().nonnegative().optional(),
});
type AnalyticsState = z.infer<typeof AnalyticsStateSchema>;
const FlushedEventsSchema = z.array(z.object({ uuid: z.string().optional() }));

function getClient() {
	if (client !== undefined) {
		return client;
	}

	const config = getProductAnalyticsConfig();
	if (!config) {
		client = null;
		return client;
	}
	try {
		client = new PostHog(config.key, {
			host: config.host,
			flushAt: 1,
			flushInterval: 0,
			requestTimeout: 1_500,
			fetchRetryCount: 1,
			fetchRetryDelay: 100,
			disableGeoip: true,
		});
		client.on("flush", recordDeliveredFirstRun);
		client.on("error", () => debugLog("analytics delivery failed"));
	} catch {
		debugLog("analytics initialization failed");
		client = null;
	}
	return client;
}

function getAnalyticsStatePath() {
	return join(getConfigDir(), ANALYTICS_STATE_FILE);
}

function readAnalyticsState(): AnalyticsState {
	try {
		const statePath = getAnalyticsStatePath();
		if (!existsSync(statePath)) return {};
		const parsed = AnalyticsStateSchema.safeParse(
			JSON.parse(readFileSync(statePath, "utf8")),
		);
		return parsed.success ? parsed.data : {};
	} catch {
		return {};
	}
}

function writeAnalyticsState(state: AnalyticsState) {
	try {
		const statePath = getAnalyticsStatePath();
		mkdirSync(getConfigDir(), { recursive: true, mode: 0o700 });
		writeFileSync(statePath, JSON.stringify(state, null, 2), { mode: 0o600 });
	} catch {
		debugLog("analytics state could not be saved");
	}
}

function recordDeliveredFirstRun(messages: unknown) {
	const parsed = FlushedEventsSchema.safeParse(messages);
	if (!parsed.success) return;
	debugLog("analytics delivered", { eventCount: parsed.data.length });
	const state = readAnalyticsState();
	if (
		state.cli_first_run_event_id &&
		parsed.data.some(({ uuid }) => uuid === state.cli_first_run_event_id)
	) {
		writeAnalyticsState({ ...state, cli_first_run_delivered: true });
	}
}

function buildPayload<Name extends ProductAnalyticsEventName>(
	surface: CliSurface,
	event: Name,
	payload: CliCapturePayload<Name>,
) {
	return parseProductAnalyticsEvent(event, {
		...payload,
		event_version: PRODUCT_ANALYTICS_EVENT_VERSION,
		surface,
		environment: getProductAnalyticsEnvironment(),
	});
}

export function getCliVersion() {
	return pkg.version;
}

export function getPlatformOs(): ProductAnalyticsPlatformOs {
	switch (process.platform) {
		case "darwin":
			return "macos";
		case "win32":
			return "windows";
		default:
			return "linux";
	}
}

/**
 * This installation's stable id. Repository evidence scopes repository,
 * worktree and transcript identities by it, so it must not change between
 * processes: with a new id per process every capture would resend the whole
 * transcript and start a new repository spool. Kept in its own file whether
 * or not analytics is enabled; the id an earlier release kept in the
 * analytics state is reused. Only when analytics is enabled is it written to
 * the analytics state (and sent with analytics events), as before. If the
 * configuration directory is not writable, the id lasts for this process.
 */
export function getOrCreateCliInstallationId() {
	const state = readAnalyticsState();
	const cliInstallationId =
		typeof state.cli_installation_id === "string"
			? state.cli_installation_id
			: getOrCreateStoredInstallationId();
	if (
		getProductAnalyticsConfig() &&
		state.cli_installation_id !== cliInstallationId
	)
		writeAnalyticsState({
			...state,
			cli_installation_id: cliInstallationId,
		});
	return cliInstallationId;
}

function getOrCreateStoredInstallationId(): string {
	const path = join(getConfigDir(), INSTALLATION_ID_FILE);
	const stored = readStoredInstallationId(path);
	if (stored !== undefined) return stored;
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		mkdirSync(getConfigDir(), { recursive: true, mode: 0o700 });
		writeFileSync(
			temporary,
			JSON.stringify({ version: 1, installationId: ephemeralInstallationId }),
			{ flag: "wx", mode: 0o600 },
		);
		try {
			// Publishes the complete file only if no other process did first.
			linkSync(temporary, path);
		} catch (error) {
			if (!isErrorCode(error, "EEXIST")) throw error;
			const winner = readStoredInstallationId(path);
			if (winner !== undefined) return winner;
			// An unreadable file is replaced.
			renameSync(temporary, path);
		}
		return ephemeralInstallationId;
	} catch {
		debugLog("installation id could not be saved");
		return ephemeralInstallationId;
	} finally {
		try {
			rmSync(temporary, { force: true });
		} catch {
			// The directory itself may be unusable; nothing was written then.
		}
	}
}

function readStoredInstallationId(path: string): string | undefined {
	try {
		const parsed = InstallationIdFileSchema.safeParse(
			JSON.parse(readFileSync(path, "utf8")),
		);
		return parsed.success ? parsed.data.installationId : undefined;
	} catch {
		return undefined;
	}
}

function isErrorCode(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}

export function trackCliFirstRun(options: {
	commandName: ProductAnalyticsEventPayload<"CLI First Run">["command_name"];
	isAuthenticated: boolean;
	userId?: string;
}) {
	if (!getClient()) return;
	const cliInstallationId = getOrCreateCliInstallationId();
	const state = readAnalyticsState();
	if (state.cli_first_run_delivered) return;
	// Older releases marked this event before checking whether capture was enabled.
	// Only the delivery marker is authoritative; retain the UUID when retrying.
	const eventId = state.cli_first_run_event_id ?? randomUUID();
	writeAnalyticsState({
		...state,
		cli_installation_id: cliInstallationId,
		cli_first_run_event_id: eventId,
	});
	captureCliProductAnalyticsEvent({
		distinctId: getCliDistinctId(options.userId),
		event: PRODUCT_ANALYTICS_EVENTS.CLI_FIRST_RUN,
		surface: "cli",
		disablePersonProfile: shouldDisableCliPersonProfile(options.userId),
		eventId,
		payload: {
			cli_installation_id: cliInstallationId,
			command_name: options.commandName,
			is_authenticated: options.isAuthenticated,
			...getBaseCliEventPayload(),
		},
	});
}

export function getNextCliLoginAttemptNumber() {
	if (!getClient()) return 1;
	const state = readAnalyticsState();
	const nextAttemptNumber = (state.cli_login_attempt_count ?? 0) + 1;
	writeAnalyticsState({
		...state,
		cli_installation_id:
			state.cli_installation_id ?? getOrCreateCliInstallationId(),
		cli_login_attempt_count: nextAttemptNumber,
	});
	return nextAttemptNumber;
}

export function captureCliProductAnalyticsEvent<
	Name extends ProductAnalyticsEventName,
>(options: {
	distinctId: string;
	event: Name;
	payload: CliCapturePayload<Name>;
	surface: CliSurface;
	disablePersonProfile?: boolean;
	eventId?: string;
}) {
	const instance = getClient();
	if (!instance) {
		return;
	}

	try {
		const payload = buildPayload(
			options.surface,
			options.event,
			options.payload,
		);
		instance.capture({
			distinctId: options.distinctId,
			event: options.event,
			uuid: options.eventId,
			properties: options.disablePersonProfile
				? { ...payload, $process_person_profile: false }
				: payload,
		});
	} catch {
		debugLog("analytics event rejected", { event: options.event });
	}
}

export function identifyCliProductAnalyticsUser(userId: string) {
	const instance = getClient();
	if (!instance) return;
	try {
		let state = readAnalyticsState();
		if (
			state.cli_identified_user_id &&
			state.cli_identified_user_id !== userId
		) {
			resetCliProductAnalyticsIdentity();
			state = readAnalyticsState();
		}
		const anonymousId =
			state.cli_anonymous_id ?? getOrCreateCliInstallationId();
		instance.identify({
			distinctId: userId,
			properties: { $anon_distinct_id: anonymousId },
		});
		writeAnalyticsState({
			...readAnalyticsState(),
			cli_anonymous_id: anonymousId,
			cli_identified_user_id: userId,
		});
	} catch {
		debugLog("analytics identity could not be linked");
	}
}

export function resetCliProductAnalyticsIdentity() {
	if (!getProductAnalyticsConfig()) return;
	writeAnalyticsState({
		...readAnalyticsState(),
		cli_anonymous_id: randomUUID(),
		cli_identified_user_id: undefined,
	});
}

export async function shutdownCliProductAnalytics(timeoutMs = 3_500) {
	const instance = client;
	if (!instance) {
		client = undefined;
		return;
	}

	try {
		await instance.shutdown(timeoutMs);
	} catch {
		debugLog("analytics shutdown failed");
	} finally {
		client = undefined;
	}
}

export function normalizeFailureReason(error: unknown) {
	if (error instanceof ORPCError) {
		if (error.status === 429) {
			return "rate_limit";
		}
		if (error.status >= 500) {
			return "server_error";
		}
		if (error.status === 401 || error.status === 403) {
			return "auth_error";
		}
		if (error.status === 400) {
			return "validation_error";
		}
	}

	if (error instanceof TypeError) {
		return "network_error";
	}

	const message =
		error instanceof Error
			? error.message.toLowerCase()
			: String(error).toLowerCase();
	if (message.includes("access denied") || message.includes("access_denied")) {
		return "access_denied";
	}
	if (message.includes("timed out") || message.includes("timeout")) {
		return "timeout";
	}
	if (message.includes("network")) {
		return "network_error";
	}
	if (message.includes("validation")) {
		return "validation_error";
	}
	if (message.includes("forbidden") || message.includes("unauthorized")) {
		return "auth_error";
	}
	// Arbitrary errors can contain paths, repository names, URLs, or credentials.
	return "unknown";
}

export function getCliDistinctId(userId?: string | null) {
	if (userId) return userId;
	if (!getProductAnalyticsConfig()) return ephemeralInstallationId;
	return (
		readAnalyticsState().cli_anonymous_id ?? getOrCreateCliInstallationId()
	);
}

export function shouldDisableCliPersonProfile(userId?: string | null) {
	return !userId;
}

export function getBaseCliEventPayload() {
	return {
		cli_version: getCliVersion(),
		platform_os: getPlatformOs(),
	} as const;
}

export const CliProductAnalyticsEvents = PRODUCT_ANALYTICS_EVENTS;
