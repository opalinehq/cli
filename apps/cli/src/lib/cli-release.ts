import { z } from "zod";

// Accept SemVer, including prereleases, without converting large identifiers to
// imprecise JavaScript numbers. Build metadata does not affect precedence.
const VERSION =
	/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const ReleaseSchema = z.object({
	name: z.literal("opaline"),
	version: z.string().regex(VERSION),
	dependencies: z.object({ "@opalinehq/cli": z.string() }),
});

export async function getLatestCliRelease(): Promise<string> {
	const response = await fetch("https://registry.npmjs.org/opaline/latest", {
		signal: AbortSignal.timeout(3_000),
		redirect: "error",
	});
	if (!response.ok)
		throw new Error("Could not check the latest Opaline release.");
	const release = ReleaseSchema.parse(await response.json());
	if (release.dependencies["@opalinehq/cli"] !== release.version)
		throw new Error(
			"The published Opaline packages do not agree on a version.",
		);
	return release.version;
}

export function getCliReleaseUrl(version: string): string {
	parseVersion(version);
	return `https://github.com/opalinehq/cli/releases/tag/${encodeURIComponent(`opaline-cli@${version}`)}`;
}

export function compareCliVersions(left: string, right: string): number {
	const a = parseVersion(left);
	const b = parseVersion(right);
	for (let i = 0; i < 3; i++) {
		const result = compareIdentifier(a.core[i] ?? "0", b.core[i] ?? "0");
		if (result) return result;
	}
	if (a.pre === undefined) return b.pre === undefined ? 0 : 1;
	if (b.pre === undefined) return -1;
	const ap = a.pre.split(".");
	const bp = b.pre.split(".");
	for (let i = 0; i < Math.max(ap.length, bp.length); i++) {
		const ai = ap[i];
		const bi = bp[i];
		if (ai === undefined) return -1;
		if (bi === undefined) return 1;
		const result = compareIdentifier(ai, bi);
		if (result) return result;
	}
	return 0;
}

export function readCliBundleVersion(content: string): string | undefined {
	// Published Bun bundles embed the implementation's package manifest. Read
	// data, rather than executing an old CLI during the update preflight.
	const version = /\bname:\s*"@opalinehq\/cli",\s*version:\s*"([^"]+)"/u.exec(
		content,
	)?.[1];
	return version && VERSION.test(version) ? version : undefined;
}

function parseVersion(version: string) {
	const match = VERSION.exec(version);
	if (!match) throw new Error(`Invalid CLI version: ${version}`);
	return { core: match.slice(1, 4), pre: match[4] };
}

function compareIdentifier(a: string, b: string): number {
	if (a === b) return 0;
	const an = /^\d+$/u.test(a);
	const bn = /^\d+$/u.test(b);
	if (an && bn) return BigInt(a) < BigInt(b) ? -1 : 1;
	if (an !== bn) return an ? -1 : 1;
	return a < b ? -1 : 1;
}
