import { z } from "zod";
import { SourceSchema } from "./source.js";

export const PRODUCT_ANALYTICS_EVENT_VERSION = 1 as const;

export const ProductAnalyticsSurfaceSchema = z.enum(["cli", "hook"]);
export const ProductAnalyticsEnvironmentSchema = z.enum([
	"production",
	"staging",
	"development",
	"local",
]);
export const ProductAnalyticsUploadModeSchema = z.enum([
	"hook",
	"manual",
	"retry",
]);
export const ProductAnalyticsClientSurfaceSchema = z.enum(["cli", "hook"]);
export const ProductAnalyticsPlatformOsSchema = z.enum([
	"macos",
	"windows",
	"linux",
]);
export const ProductAnalyticsAuthFlowSchema = z.literal("device_authorization");
export const ProductAnalyticsCliCommandNameSchema = z.enum([
	"connect",
	"login",
	"logout",
	"whoami",
	"upload",
	"enable",
	"disable",
	"set-org",
	"doctor",
	"hooks",
	"dev",
	"help",
]);
export const ProductAnalyticsLoginFailureStageSchema = z.enum([
	"api_base_rejected",
	"device_code_request",
	"verification_url_rejected",
	"browser_approval_timeout",
	"token_exchange",
	"api_key_create",
	"account_fetch",
]);
export const ProductAnalyticsEnableFailureStageSchema = z.enum([
	"auth_verify",
	"organization_fetch",
	"organization_select",
	"hook_install",
]);

export type ProductAnalyticsUploadMode = z.infer<
	typeof ProductAnalyticsUploadModeSchema
>;
export type ProductAnalyticsClientSurface = z.infer<
	typeof ProductAnalyticsClientSurfaceSchema
>;
export type ProductAnalyticsPlatformOs = z.infer<
	typeof ProductAnalyticsPlatformOsSchema
>;
export type ProductAnalyticsLoginFailureStage = z.infer<
	typeof ProductAnalyticsLoginFailureStageSchema
>;

const RequiredCommonSchema = z.object({
	event_version: z.literal(PRODUCT_ANALYTICS_EVENT_VERSION),
	surface: ProductAnalyticsSurfaceSchema,
	environment: ProductAnalyticsEnvironmentSchema,
});
const idSchema = z.string().min(1);
const nonEmptyStringSchema = z.string().min(1);
const repositoryCountsSchema = z.object({
	repository_count: z.number().int().nonnegative(),
	session_count: z.number().int().nonnegative(),
	repository_session_counts: z.array(z.number().int().nonnegative()),
});
export type ProductAnalyticsRepositoryCounts = z.infer<
	typeof repositoryCountsSchema
>;
const autoUploadSetupProperties = {
	...repositoryCountsSchema.partial().shape,
	setup_command: z.enum(["enable", "upload"]).optional(),
};

export const PRODUCT_ANALYTICS_EVENTS = {
	CLI_FIRST_RUN: "CLI First Run",
	CLI_LOGIN_STARTED: "CLI Login Started",
	CLI_LOGIN_APPROVED: "CLI Login Approved",
	CLI_LOGIN_FAILED: "CLI Login Failed",
	AUTO_UPLOAD_ENABLED: "Auto Upload Enabled",
	AUTO_UPLOAD_ENABLE_FAILED: "Auto Upload Enable Failed",
} as const;

export type ProductAnalyticsEventName =
	(typeof PRODUCT_ANALYTICS_EVENTS)[keyof typeof PRODUCT_ANALYTICS_EVENTS];

const CliFirstRunEventSchema = RequiredCommonSchema.extend({
	surface: z.literal("cli"),
	cli_installation_id: idSchema,
	cli_version: nonEmptyStringSchema,
	platform_os: ProductAnalyticsPlatformOsSchema,
	command_name: ProductAnalyticsCliCommandNameSchema,
	is_authenticated: z.boolean(),
}).strict();

const CliLoginStartedEventSchema = RequiredCommonSchema.extend({
	surface: z.literal("cli"),
	auth_flow: ProductAnalyticsAuthFlowSchema,
	cli_version: nonEmptyStringSchema,
	platform_os: ProductAnalyticsPlatformOsSchema,
	opened_browser: z.boolean(),
	attempt_number: z.number().int().positive(),
}).strict();

const CliLoginApprovedEventSchema = RequiredCommonSchema.extend({
	surface: z.literal("cli"),
	user_id: idSchema,
	auth_flow: ProductAnalyticsAuthFlowSchema,
	cli_version: nonEmptyStringSchema,
	platform_os: ProductAnalyticsPlatformOsSchema,
	opened_browser: z.boolean().optional(),
}).strict();

const CliLoginFailedEventSchema = RequiredCommonSchema.extend({
	surface: z.literal("cli"),
	auth_flow: ProductAnalyticsAuthFlowSchema,
	failure_stage: ProductAnalyticsLoginFailureStageSchema,
	failure_reason: nonEmptyStringSchema,
	cli_version: nonEmptyStringSchema,
	platform_os: ProductAnalyticsPlatformOsSchema,
	opened_browser: z.boolean().optional(),
	attempt_number: z.number().int().positive(),
}).strict();

const AutoUploadEnabledEventSchema = RequiredCommonSchema.extend({
	...autoUploadSetupProperties,
	surface: z.literal("cli"),
	organization_id: idSchema.optional(),
	user_id: idSchema.optional(),
	agent_source: SourceSchema,
	cli_version: nonEmptyStringSchema,
	platform_os: ProductAnalyticsPlatformOsSchema,
	is_already_enabled: z.boolean().optional(),
}).strict();

const AutoUploadEnableFailedEventSchema = RequiredCommonSchema.extend({
	...autoUploadSetupProperties,
	surface: z.literal("cli"),
	agent_source: z.union([SourceSchema, z.literal("unknown")]),
	failure_stage: ProductAnalyticsEnableFailureStageSchema,
	failure_reason: nonEmptyStringSchema,
	cli_version: nonEmptyStringSchema,
	platform_os: ProductAnalyticsPlatformOsSchema,
	organization_id: idSchema.optional(),
	user_id: idSchema.optional(),
}).strict();

const ProductAnalyticsEventSchemas = {
	[PRODUCT_ANALYTICS_EVENTS.CLI_FIRST_RUN]: CliFirstRunEventSchema,
	[PRODUCT_ANALYTICS_EVENTS.CLI_LOGIN_STARTED]: CliLoginStartedEventSchema,
	[PRODUCT_ANALYTICS_EVENTS.CLI_LOGIN_APPROVED]: CliLoginApprovedEventSchema,
	[PRODUCT_ANALYTICS_EVENTS.CLI_LOGIN_FAILED]: CliLoginFailedEventSchema,
	[PRODUCT_ANALYTICS_EVENTS.AUTO_UPLOAD_ENABLED]: AutoUploadEnabledEventSchema,
	[PRODUCT_ANALYTICS_EVENTS.AUTO_UPLOAD_ENABLE_FAILED]:
		AutoUploadEnableFailedEventSchema,
} satisfies Record<ProductAnalyticsEventName, z.ZodType>;

export interface ProductAnalyticsEventPayloadMap {
	[PRODUCT_ANALYTICS_EVENTS.CLI_FIRST_RUN]: z.infer<
		typeof CliFirstRunEventSchema
	>;
	[PRODUCT_ANALYTICS_EVENTS.CLI_LOGIN_STARTED]: z.infer<
		typeof CliLoginStartedEventSchema
	>;
	[PRODUCT_ANALYTICS_EVENTS.CLI_LOGIN_APPROVED]: z.infer<
		typeof CliLoginApprovedEventSchema
	>;
	[PRODUCT_ANALYTICS_EVENTS.CLI_LOGIN_FAILED]: z.infer<
		typeof CliLoginFailedEventSchema
	>;
	[PRODUCT_ANALYTICS_EVENTS.AUTO_UPLOAD_ENABLED]: z.infer<
		typeof AutoUploadEnabledEventSchema
	>;
	[PRODUCT_ANALYTICS_EVENTS.AUTO_UPLOAD_ENABLE_FAILED]: z.infer<
		typeof AutoUploadEnableFailedEventSchema
	>;
}

export type ProductAnalyticsEventPayload<
	Name extends ProductAnalyticsEventName,
> = ProductAnalyticsEventPayloadMap[Name];

type AnyProductAnalyticsEventPayload =
	ProductAnalyticsEventPayloadMap[ProductAnalyticsEventName];

export function parseProductAnalyticsEvent(
	event: ProductAnalyticsEventName,
	payload: unknown,
): AnyProductAnalyticsEventPayload {
	return ProductAnalyticsEventSchemas[event].parse(payload);
}
