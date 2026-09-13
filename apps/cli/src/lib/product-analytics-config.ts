import { getDefaultApiBase } from "./api-target.js";

export interface ProductAnalyticsConfig {
	readonly key: string;
	readonly host: string;
}

// Replaced by the release build. Source checkouts stay unconfigured by default.
declare const OPALINE_BUNDLED_ANALYTICS: ProductAnalyticsConfig | null;

export function getProductAnalyticsConfig(
	environment: NodeJS.ProcessEnv = process.env,
	bundled: ProductAnalyticsConfig | null = typeof OPALINE_BUNDLED_ANALYTICS ===
	"undefined"
		? null
		: OPALINE_BUNDLED_ANALYTICS,
): ProductAnalyticsConfig | null {
	if (
		environment.DO_NOT_TRACK === "1" ||
		environment.POSTHOG_ENABLED?.trim().toLowerCase() === "false"
	) {
		return null;
	}
	const explicitlyEnabled = environment.POSTHOG_ENABLED === "true";
	if (!explicitlyEnabled && (!bundled || environment.NODE_ENV === "test")) {
		return null;
	}
	const key = (environment.POSTHOG_KEY ?? bundled?.key ?? "").trim();
	const host = (environment.POSTHOG_HOST ?? bundled?.host ?? "").trim();
	if (!key || !host) return null;
	return { key, host };
}

export function getProductAnalyticsEnvironment(
	environment: NodeJS.ProcessEnv = process.env,
): "production" | "staging" | "development" | "local" {
	try {
		const hostname = new URL(getDefaultApiBase(environment)).hostname;
		if (["localhost", "127.0.0.1", "[::1]"].includes(hostname)) return "local";
		if (hostname === "opaline.so" || hostname === "app.rudel.ai") {
			return "production";
		}
		if (hostname.split(/[.-]/).includes("staging")) return "staging";
	} catch {
		// An invalid API override must not make analytics fail the command.
	}
	return "development";
}

export function getBuildProductAnalyticsConfig(
	environment: NodeJS.ProcessEnv,
): ProductAnalyticsConfig | null {
	const key = environment.OPALINE_BUILD_POSTHOG_KEY?.trim() ?? "";
	const host = environment.OPALINE_BUILD_POSTHOG_HOST?.trim() ?? "";
	if (!key && !host) return null;
	if (!key.startsWith("phc_") || !host) {
		throw new Error(
			"CLI analytics builds require a public phc_ project token and an HTTPS ingestion host.",
		);
	}
	const url = new URL(host);
	if (url.protocol !== "https:" || url.username || url.password) {
		throw new Error("CLI analytics builds require an HTTPS ingestion host.");
	}
	return { key, host: url.href.replace(/\/$/, "") };
}
