import { describe, expect, test } from "bun:test";
import { normalizeFailureReason } from "../lib/product-analytics.js";
import {
	getBuildProductAnalyticsConfig,
	getProductAnalyticsConfig,
	getProductAnalyticsEnvironment,
} from "../lib/product-analytics-config.js";

const bundled = {
	key: "phc_test_public_token",
	host: "https://us.i.posthog.com",
};

describe("published CLI analytics configuration", () => {
	test("works without consumer environment variables", () => {
		expect(getProductAnalyticsConfig({}, bundled)).toEqual(bundled);
	});

	test("source checkouts stay disabled without explicit configuration", () => {
		expect(getProductAnalyticsConfig({}, null)).toBeNull();
	});

	test("either opt-out overrides bundled and explicit configuration", () => {
		for (const optOut of [
			{ POSTHOG_ENABLED: "false" },
			{ POSTHOG_ENABLED: " FALSE " },
			{ DO_NOT_TRACK: "1", POSTHOG_ENABLED: "true" },
		]) {
			expect(getProductAnalyticsConfig(optOut, bundled)).toBeNull();
		}
	});

	test("test processes do not send to the bundled production project", () => {
		expect(getProductAnalyticsConfig({ NODE_ENV: "test" }, bundled)).toBeNull();
	});

	test("explicit configuration works in source and test processes", () => {
		expect(
			getProductAnalyticsConfig(
				{
					NODE_ENV: "test",
					POSTHOG_ENABLED: "true",
					POSTHOG_KEY: bundled.key,
					POSTHOG_HOST: bundled.host,
				},
				null,
			),
		).toEqual(bundled);
	});

	test("builds require both values and reject administrative keys", () => {
		expect(getBuildProductAnalyticsConfig({})).toBeNull();
		for (const environment of [
			{ OPALINE_BUILD_POSTHOG_KEY: bundled.key },
			{ OPALINE_BUILD_POSTHOG_HOST: bundled.host },
			{
				OPALINE_BUILD_POSTHOG_KEY: "phx_administrative_key",
				OPALINE_BUILD_POSTHOG_HOST: bundled.host,
			},
			{
				OPALINE_BUILD_POSTHOG_KEY: bundled.key,
				OPALINE_BUILD_POSTHOG_HOST: "http://us.i.posthog.com",
			},
		]) {
			expect(() => getBuildProductAnalyticsConfig(environment)).toThrow();
		}
	});

	test("valid release inputs produce bundled public configuration", () => {
		expect(
			getBuildProductAnalyticsConfig({
				OPALINE_BUILD_POSTHOG_KEY: bundled.key,
				OPALINE_BUILD_POSTHOG_HOST: `${bundled.host}/`,
			}),
		).toEqual(bundled);
	});
});

test("normal installations are labelled production without NODE_ENV", () => {
	expect(getProductAnalyticsEnvironment({})).toBe("production");
	expect(
		getProductAnalyticsEnvironment({
			OPALINE_API_BASE: "http://localhost:4010",
		}),
	).toBe("local");
	expect(
		getProductAnalyticsEnvironment({
			RUDEL_API_BASE: "https://staging.opaline.so",
		}),
	).toBe("staging");
	expect(getProductAnalyticsEnvironment({ OPALINE_API_BASE: "invalid" })).toBe(
		"development",
	);
});

test("failure reasons never expose arbitrary error messages", () => {
	expect(
		normalizeFailureReason(
			new Error("secret repo /Users/alice/private token=123"),
		),
	).toBe("unknown");
	expect(normalizeFailureReason(new Error("timed out"))).toBe("timeout");
	expect(normalizeFailureReason(new TypeError("fetch failed"))).toBe(
		"network_error",
	);
});
