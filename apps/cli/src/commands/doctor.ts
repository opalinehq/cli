import { existsSync } from "node:fs";
import { join } from "node:path";
import { buildCommand } from "@stricli/core";
import pkg from "../../package.json" with { type: "json" };
import { getAllAdapters } from "../internal/agent-adapters/index.js";
import { createApiClient } from "../lib/api-client.js";
import { getDefaultApiBase } from "../lib/api-target.js";
import { type Credentials, loadCredentials } from "../lib/credentials.js";
import { debugLog } from "../lib/debug.js";
import { getConfigPathInfo } from "../lib/local-state.js";
import { readRepositoryEvidencePauseUntil } from "../lib/repository-evidence-pause.js";

const CHECK_TIMEOUT_MS = 5_000;
const NPM_REGISTRY_BASE = "https://registry.npmjs.org";
const CURRENT_PACKAGE_NAME = "@opalinehq/cli";
const LEGACY_PACKAGE_NAME = "rudel";
const SEMVER_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/u;

type CheckStatus = "ok" | "warn" | "error";

interface DoctorCheck {
	detail: string;
	label: string;
	status: CheckStatus;
}

interface ConfigDiagnosis {
	check: DoctorCheck;
	credentials: Credentials | null;
	credentialsBroken: boolean;
}

export async function runDoctor(): Promise<void> {
	debugLog("running diagnostics");
	const config = diagnoseConfig();
	const apiBaseUrl = config.credentials?.apiBaseUrl ?? getDefaultApiBase();
	const [auth, api, version, hooks] = await Promise.all([
		diagnoseAuth(config),
		diagnoseApi(apiBaseUrl),
		diagnoseVersion(),
		diagnoseHooks(),
	]);
	const checks = [auth, api, config.check, version, hooks];

	process.stdout.write("Opaline doctor\n");
	const pauseUntil = readRepositoryEvidencePauseUntil();
	if (pauseUntil !== undefined)
		process.stdout.write(
			`[warn] Repository evidence: server-paused until ${new Date(pauseUntil).toISOString()}; transcript uploads continue.\n`,
		);
	for (const check of checks) {
		process.stdout.write(`[${check.status}] ${check.label}: ${check.detail}\n`);
	}

	const errorCount = checks.filter((check) => check.status === "error").length;
	if (errorCount > 0) {
		process.stdout.write(
			`Doctor found ${errorCount} broken diagnostic${errorCount === 1 ? "" : "s"}.\n`,
		);
		process.exitCode = 1;
		return;
	}

	process.stdout.write("Doctor found no broken diagnostics.\n");
}

export function compareVersions(left: string, right: string): number | null {
	const leftParts = parseVersion(left);
	const rightParts = parseVersion(right);
	if (!leftParts || !rightParts) return null;

	for (let index = 0; index < leftParts.length; index++) {
		const leftPart = leftParts[index];
		const rightPart = rightParts[index];
		if (leftPart === undefined || rightPart === undefined) return null;
		if (leftPart > rightPart) return 1;
		if (leftPart < rightPart) return -1;
	}
	return 0;
}

function diagnoseConfig(): ConfigDiagnosis {
	const info = getConfigPathInfo();
	const credentialsPath = join(info.directory, "credentials.json");
	try {
		const credentials = loadCredentials("read-only");
		return {
			check: {
				label: "Config",
				status: "ok",
				detail: `${credentialsPath} (${info.migrationStatus}; .config/gazed/config.json is intentionally ignored)`,
			},
			credentials,
			credentialsBroken: false,
		};
	} catch (error) {
		return {
			check: {
				label: "Config",
				status: "error",
				detail: `${credentialsPath} could not be read: ${errorMessage(error)}`,
			},
			credentials: null,
			credentialsBroken: existsSync(credentialsPath),
		};
	}
}

async function diagnoseAuth(config: ConfigDiagnosis): Promise<DoctorCheck> {
	if (config.credentialsBroken) {
		return {
			label: "Auth",
			status: "error",
			detail: "saved credentials are unreadable",
		};
	}
	if (!config.credentials) {
		return {
			label: "Auth",
			status: "warn",
			detail: "signed out (run `opaline login` when authentication is needed)",
		};
	}

	try {
		const client = createApiClient(config.credentials);
		const user = await withTimeout<{ readonly email: string }>(
			config.credentials.authType === "api-key"
				? client.cli.authStatus()
				: client.me(),
			CHECK_TIMEOUT_MS,
			"authentication check timed out",
		);
		return {
			label: "Auth",
			status: "ok",
			detail: `authenticated as ${user.email}`,
		};
	} catch (error) {
		return {
			label: "Auth",
			status: "error",
			detail: `saved credentials failed verification: ${errorMessage(error)}`,
		};
	}
}

async function diagnoseApi(apiBaseUrl: string): Promise<DoctorCheck> {
	const start = performance.now();
	try {
		const healthUrl = new URL("/health", `${apiBaseUrl}/`).toString();
		const response = await fetch(healthUrl, {
			signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
		});
		const latencyMs = Math.round(performance.now() - start);
		if (!response.ok) {
			return {
				label: "API",
				status: "error",
				detail: `${apiBaseUrl} returned HTTP ${response.status} in ${latencyMs} ms`,
			};
		}
		const body: unknown = await response.json();
		if (!isHealthyResponse(body)) {
			return {
				label: "API",
				status: "error",
				detail: `${apiBaseUrl} returned an invalid health response in ${latencyMs} ms`,
			};
		}
		return {
			label: "API",
			status: "ok",
			detail: `${apiBaseUrl} reachable in ${latencyMs} ms`,
		};
	} catch (error) {
		return {
			label: "API",
			status: "error",
			detail: `${apiBaseUrl} is unreachable: ${errorMessage(error)}`,
		};
	}
}

async function diagnoseVersion(): Promise<DoctorCheck> {
	try {
		let packageName = CURRENT_PACKAGE_NAME;
		let latestVersion = await fetchLatestVersion(packageName);
		if (latestVersion === null) {
			packageName = LEGACY_PACKAGE_NAME;
			latestVersion = await fetchLatestVersion(packageName);
		}
		if (latestVersion === null) {
			return {
				label: "Version",
				status: "error",
				detail: "neither @opalinehq/cli nor rudel has registry metadata",
			};
		}

		const comparison = compareVersions(pkg.version, latestVersion);
		if (comparison === null) {
			return {
				label: "Version",
				status: "error",
				detail: `could not compare ${pkg.version} with ${packageName}@${latestVersion}`,
			};
		}
		if (comparison < 0) {
			return {
				label: "Version",
				status: "error",
				detail: `${pkg.version} is outdated; latest is ${packageName}@${latestVersion}`,
			};
		}
		if (comparison > 0) {
			return {
				label: "Version",
				status: "ok",
				detail: `${pkg.version} is newer than ${packageName}@${latestVersion}`,
			};
		}
		return {
			label: "Version",
			status: "ok",
			detail: `${pkg.version} is current on ${packageName}`,
		};
	} catch (error) {
		return {
			label: "Version",
			status: "error",
			detail: `registry check failed: ${errorMessage(error)}`,
		};
	}
}

async function diagnoseHooks(): Promise<DoctorCheck> {
	try {
		const adapters = getAllAdapters();
		const statuses = adapters.map((adapter) => ({
			name: adapter.name,
			installed: adapter.isHookInstalled(),
		}));
		const installedCount = statuses.filter((status) => status.installed).length;
		const detail = statuses
			.map(
				(status) =>
					`${status.name} ${status.installed ? "enabled" : "disabled"}`,
			)
			.join(", ");
		return {
			label: "Hooks",
			status: installedCount > 0 ? "ok" : "warn",
			detail,
		};
	} catch (error) {
		return {
			label: "Hooks",
			status: "error",
			detail: `hook configuration could not be inspected: ${errorMessage(error)}`,
		};
	}
}

async function fetchLatestVersion(packageName: string): Promise<string | null> {
	const response = await fetch(
		`${NPM_REGISTRY_BASE}/${encodeURIComponent(packageName)}/latest`,
		{ signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) },
	);
	if (response.status === 404) return null;
	if (!response.ok) {
		throw new Error(`${packageName} returned HTTP ${response.status}`);
	}
	const body: unknown = await response.json();
	if (!isRecord(body) || typeof body.version !== "string") {
		throw new Error(`${packageName} returned invalid registry metadata`);
	}
	return body.version;
}

function parseVersion(
	version: string,
): readonly [number, number, number] | null {
	const match = SEMVER_PATTERN.exec(version);
	if (!match) return null;
	const major = Number(match[1]);
	const minor = Number(match[2]);
	const patch = Number(match[3]);
	if (![major, minor, patch].every(Number.isSafeInteger)) return null;
	return [major, minor, patch];
}

function withTimeout<TValue>(
	promise: Promise<TValue>,
	timeoutMs: number,
	message: string,
): Promise<TValue> {
	return new Promise<TValue>((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
		promise.then(
			(value) => {
				clearTimeout(timeout);
				resolve(value);
			},
			(error: unknown) => {
				clearTimeout(timeout);
				reject(error);
			},
		);
	});
}

function isHealthyResponse(value: unknown): boolean {
	return isRecord(value) && value.status === "ok";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export const doctorCommand = buildCommand({
	loader: async () => runDoctor,
	parameters: {},
	docs: {
		brief: "Run read-only CLI, auth, API, version, and hook diagnostics",
	},
});
