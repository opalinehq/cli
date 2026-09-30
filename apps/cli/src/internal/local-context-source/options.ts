import { isAbsolute } from "node:path";
import type {
	LocalContextCollectionLimits,
	LocalContextCollectionOptions,
} from "./types.js";

const ADDITIONAL_ROOT_ORIGINS: ReadonlySet<string> = new Set([
	"user",
	"admin",
	"system",
]);
const ADDITIONAL_ROOT_SCOPES: ReadonlySet<string> = new Set([
	"instructions",
	"skills",
	"plans",
	"agent-config",
	"custom",
]);

export const DEFAULT_LOCAL_CONTEXT_COLLECTION_LIMITS: LocalContextCollectionLimits =
	{
		maxDepthPerRoot: 64,
		maxEntriesPerRoot: 50_000,
		maxTotalEntries: 100_000,
		maxBlobs: 100_000,
		maxContentBytesPerFile: 2 * 1024 * 1024,
		maxContentBytesPerRoot: 64 * 1024 * 1024,
		maxTotalContentBytes: 128 * 1024 * 1024,
		maxHashBytesPerFile: 256 * 1024 * 1024,
		maxHashBytesPerRoot: 512 * 1024 * 1024,
		maxTotalHashBytes: 1024 * 1024 * 1024,
		binaryProbeBytes: 8192,
		maxGitOutputBytesPerCommand: 16 * 1024 * 1024,
		gitCommandTimeoutMs: 15_000,
		maxCommits: 100,
		maxCoverageErrors: 1000,
	};

export function getDefaultLocalContextCollectionOptions(): LocalContextCollectionOptions {
	return {
		limits: { ...DEFAULT_LOCAL_CONTEXT_COLLECTION_LIMITS },
		additionalRoots: [],
		excludedPathPrefixes: [],
		capturePolicy: "delta",
		parentCapture: null,
	};
}

export function validateLocalContextCollectionOptions(
	options: LocalContextCollectionOptions,
): void {
	validateLimits(options.limits);
	validateAdditionalRootIds(options);
	for (const prefix of options.excludedPathPrefixes) {
		if (
			prefix.length === 0 ||
			prefix.startsWith("/") ||
			prefix === ".." ||
			prefix.startsWith("../") ||
			prefix.includes("/../")
		) {
			throw new Error(
				`Invalid excluded path prefix: ${JSON.stringify(prefix)}`,
			);
		}
	}
}

function validateLimits(limits: LocalContextCollectionLimits): void {
	for (const [name, value] of Object.entries(limits)) {
		if (!Number.isSafeInteger(value) || value <= 0) {
			throw new Error(`${name} must be a positive safe integer.`);
		}
	}
}

function validateAdditionalRootIds(
	options: LocalContextCollectionOptions,
): void {
	const ids = new Set<string>(["repository"]);
	for (const root of options.additionalRoots) {
		if (!/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(root.id)) {
			throw new Error(`Invalid context root id: ${JSON.stringify(root.id)}`);
		}
		if (ids.has(root.id)) {
			throw new Error(`Duplicate context root id: ${JSON.stringify(root.id)}`);
		}
		if (root.label.trim().length === 0) {
			throw new Error(
				`Context root ${JSON.stringify(root.id)} has an empty label.`,
			);
		}
		if (!isAbsolute(root.absolutePath)) {
			throw new Error(
				`Context root ${JSON.stringify(root.id)} must use an absolute path.`,
			);
		}
		if (!ADDITIONAL_ROOT_ORIGINS.has(root.origin)) {
			throw new Error(
				`Invalid context root origin: ${JSON.stringify(root.origin)}`,
			);
		}
		if (!ADDITIONAL_ROOT_SCOPES.has(root.scope)) {
			throw new Error(
				`Invalid context root scope: ${JSON.stringify(root.scope)}`,
			);
		}
		ids.add(root.id);
	}
}
