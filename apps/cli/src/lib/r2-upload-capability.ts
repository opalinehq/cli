import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { getConfigDir, writePrivateFile } from "./local-state.js";
import { R2_INGEST_PROTOCOL } from "./r2-ingest-contract.js";

const advertisedEndpoints = new Set<string>();

export function hasAdvertisedR2UploadCapability(
	endpoint: URL,
	authType: "api-key" | "bearer",
	token: string,
): boolean {
	const key = getCapabilityKey(endpoint, authType, token);
	if (advertisedEndpoints.has(key)) return true;
	try {
		const path = getCapabilityPath(key);
		if (!existsSync(path)) return false;
		if (readFileSync(path, "utf8").trim() !== R2_INGEST_PROTOCOL) return false;
		advertisedEndpoints.add(key);
		return true;
	} catch {
		return false;
	}
}

export async function rememberR2UploadCapability(
	endpoint: URL,
	authType: "api-key" | "bearer",
	token: string,
): Promise<void> {
	const key = getCapabilityKey(endpoint, authType, token);
	advertisedEndpoints.add(key);
	try {
		await writePrivateFile(
			getCapabilityPath(key),
			`${R2_INGEST_PROTOCOL}\n`,
			getConfigDir(),
		);
	} catch {
		// Capability persistence is an optimization; in-memory use still works.
	}
}

export async function forgetR2UploadCapability(
	endpoint: URL,
	authType: "api-key" | "bearer",
	token: string,
): Promise<void> {
	const key = getCapabilityKey(endpoint, authType, token);
	advertisedEndpoints.delete(key);
	try {
		await rm(getCapabilityPath(key), { force: true });
	} catch {
		// A stale cache entry only causes another safe init/fallback attempt.
	}
}

const ANALYSIS_CAPABILITY = "analysisLinkedUploads";

/**
 * Whether this endpoint and key confirmed analysis-linked uploads before. Only
 * positive answers are stored: a server that lacks the capability is asked
 * again next time, so an upgrade takes effect immediately.
 */
export function hasCachedAnalysisUploadCapability(
	endpoint: URL,
	authType: "api-key" | "bearer",
	token: string,
): boolean {
	try {
		const path = getAnalysisCapabilityPath(
			getCapabilityKey(endpoint, authType, token),
		);
		return (
			existsSync(path) &&
			readFileSync(path, "utf8").trim() === ANALYSIS_CAPABILITY
		);
	} catch {
		return false;
	}
}

export async function rememberAnalysisUploadCapability(
	endpoint: URL,
	authType: "api-key" | "bearer",
	token: string,
): Promise<void> {
	try {
		await writePrivateFile(
			getAnalysisCapabilityPath(getCapabilityKey(endpoint, authType, token)),
			`${ANALYSIS_CAPABILITY}\n`,
			getConfigDir(),
		);
	} catch {
		// The preflight simply runs again next time.
	}
}

export async function forgetAnalysisUploadCapability(
	endpoint: URL,
	authType: "api-key" | "bearer",
	token: string,
): Promise<void> {
	try {
		await rm(
			getAnalysisCapabilityPath(getCapabilityKey(endpoint, authType, token)),
			{ force: true },
		);
	} catch {
		// A stale entry is caught by the per-upload analysisId echo check.
	}
}

const SLIMMING_CAPABILITY = "transcriptSlimming";

/** Positive answers only, like the analysis capability. */
export function hasCachedTranscriptSlimmingCapability(
	endpoint: URL,
	authType: "api-key" | "bearer",
	token: string,
): boolean {
	try {
		const path = getSlimmingCapabilityPath(
			getCapabilityKey(endpoint, authType, token),
		);
		return (
			existsSync(path) &&
			readFileSync(path, "utf8").trim() === SLIMMING_CAPABILITY
		);
	} catch {
		return false;
	}
}

export async function rememberTranscriptSlimmingCapability(
	endpoint: URL,
	authType: "api-key" | "bearer",
	token: string,
): Promise<void> {
	try {
		await writePrivateFile(
			getSlimmingCapabilityPath(getCapabilityKey(endpoint, authType, token)),
			`${SLIMMING_CAPABILITY}\n`,
			getConfigDir(),
		);
	} catch {
		// The preflight simply runs again next time.
	}
}

function getSlimmingCapabilityPath(key: string): string {
	return join(getConfigDir(), "upload-capabilities", `${key}.slimming`);
}

function getAnalysisCapabilityPath(key: string): string {
	return join(getConfigDir(), "upload-capabilities", `${key}.analysis`);
}

function getCapabilityKey(
	endpoint: URL,
	authType: "api-key" | "bearer",
	token: string,
): string {
	return createHash("sha256")
		.update(`${endpoint.href}\u0000${authType}\u0000${token}`, "utf8")
		.digest("hex");
}

function getCapabilityPath(key: string): string {
	return join(getConfigDir(), "upload-capabilities", `${key}.txt`);
}
