import { basename, dirname } from "node:path/posix";
import { classifyContextPath } from "./path-policy.js";
import type {
	ContextEntry,
	ContextIndex,
	ContextIndexCoverageStatus,
	ContextIndexFacet,
	ContextIndexFacetKind,
	ContextIndexResource,
	ContextIndexResourceAccess,
	ContextRootManifest,
	ContextSkillAssessment,
	ContextSkillIndexEntry,
	ContextSkillUsageEvidence,
	CoverageError,
	ExcludedPath,
} from "./types.js";

const FACET_KINDS: readonly ContextIndexFacetKind[] = [
	"agents-instructions",
	"claude-instructions",
	"plans",
	"hooks",
	"mcp",
	"package-context",
];

export function buildContextIndex(
	roots: readonly ContextRootManifest[],
	entries: readonly ContextEntry[],
	excludedPaths: readonly ExcludedPath[],
	errors: readonly CoverageError[],
): ContextIndex {
	return {
		facets: roots.flatMap((root) =>
			FACET_KINDS.map((kind) =>
				buildFacet(root, kind, entries, excludedPaths, errors),
			),
		),
		skills: buildSkillIndex(entries),
	};
}

export function assessContextSkillUse(
	skills: readonly ContextSkillIndexEntry[],
	evidence: ContextSkillUsageEvidence | null,
): readonly ContextSkillAssessment[] {
	const observed = new Set(evidence?.observedSkillNames ?? []);
	return skills.map((skill) => ({
		...skill,
		use: buildSkillUse(skill.name, observed, evidence),
	}));
}

function buildFacet(
	root: ContextRootManifest,
	kind: ContextIndexFacetKind,
	entries: readonly ContextEntry[],
	excludedPaths: readonly ExcludedPath[],
	errors: readonly CoverageError[],
): ContextIndexFacet {
	const resources = entries
		.filter(
			(entry) =>
				entry.rootId === root.id &&
				getFacetKinds(entry.path, entry).includes(kind),
		)
		.map(buildResource)
		.sort(compareResources);
	const coverage = getFacetCoverage(root, kind, excludedPaths, errors);
	return {
		kind,
		rootId: root.id,
		presence:
			resources.length > 0
				? "present"
				: coverage === "complete"
					? "absent"
					: "unknown",
		coverage,
		resources,
	};
}

function buildResource(entry: ContextEntry): ContextIndexResource {
	return {
		rootId: entry.rootId,
		path: entry.path,
		access: getEntryAccess(entry),
	};
}

function buildSkillIndex(
	entries: readonly ContextEntry[],
): readonly ContextSkillIndexEntry[] {
	const definitionsByName = new Map<string, ContextIndexResource[]>();
	for (const entry of entries) {
		if (!entry.categories.includes("skill-definition")) continue;
		const name = basename(dirname(entry.path));
		const definitions = definitionsByName.get(name) ?? [];
		definitions.push(buildResource(entry));
		definitionsByName.set(name, definitions);
	}
	return [...definitionsByName.entries()]
		.map(
			([name, definitions]): ContextSkillIndexEntry => ({
				name,
				nameSource: "definition-directory",
				discovery: "present",
				definitions: definitions.sort(compareResources),
			}),
		)
		.sort(compareSkills);
}

function buildSkillUse(
	name: string,
	observed: ReadonlySet<string>,
	evidence: ContextSkillUsageEvidence | null,
): ContextSkillAssessment["use"] {
	if (evidence === null) {
		return {
			status: "unknown",
			evidenceScope: null,
			reason: "no-evidence",
		};
	}
	if (observed.has(name)) {
		return { status: "observed-used", evidenceScope: evidence.scope };
	}
	if (evidence.coverage === "complete") {
		return { status: "no-observed-use", evidenceScope: evidence.scope };
	}
	return {
		status: "unknown",
		evidenceScope: evidence.scope,
		reason: "partial-evidence",
	};
}

function getFacetCoverage(
	root: ContextRootManifest,
	kind: ContextIndexFacetKind,
	excludedPaths: readonly ExcludedPath[],
	errors: readonly CoverageError[],
): ContextIndexCoverageStatus {
	if (root.status === "missing") return "unavailable";
	if (root.status === "inaccessible") return "denied";
	if (root.status === "limit-reached") return "truncated";
	if (
		errors.some(
			(error) =>
				error.rootId === root.id &&
				(error.path === "" || getFacetKinds(error.path).includes(kind)),
		)
	) {
		return "denied";
	}
	if (
		excludedPaths.some(
			(excluded) =>
				excluded.rootId === root.id &&
				getFacetKinds(excluded.path).includes(kind),
		)
	) {
		return "excluded";
	}
	return "complete";
}

function getFacetKinds(
	path: string,
	entry: ContextEntry | undefined = undefined,
): readonly ContextIndexFacetKind[] {
	const normalized = path.toLowerCase();
	const name = basename(normalized);
	const segments = normalized.split("/");
	const categories = entry?.categories ?? classifyContextPath(path, []);
	const kinds = new Set<ContextIndexFacetKind>();
	if (name === "agents.md") kinds.add("agents-instructions");
	if (name === "claude.md") kinds.add("claude-instructions");
	if (categories.includes("plan-candidate") || segments.includes("plans")) {
		kinds.add("plans");
	}
	if (categories.includes("hook-config") || segments.includes("hooks")) {
		kinds.add("hooks");
	}
	if (categories.includes("mcp-config") || segments.includes("mcp")) {
		kinds.add("mcp");
	}
	if (categories.includes("package-context")) kinds.add("package-context");
	return [...kinds];
}

function getEntryAccess(entry: ContextEntry): ContextIndexResourceAccess {
	if (entry.kind !== "file") {
		return { status: "unavailable", reason: "not-file" };
	}
	switch (entry.content.status) {
		case "available":
		case "reused":
			return { status: "readable" };
		case "git-object":
			return { status: "reference-only", reason: "git-object" };
		case "omitted":
			if (entry.content.reason === "metadata-only") {
				return { status: "truncated", reason: "file-content-cap" };
			}
			if (entry.content.reason === "blob-count-cap") {
				return { status: "truncated", reason: "total-content-cap" };
			}
			if (entry.content.reason === "read-error") {
				return { status: "denied", reason: "read-error" };
			}
			if (
				entry.content.reason === "file-content-cap" ||
				entry.content.reason === "root-content-cap" ||
				entry.content.reason === "total-content-cap"
			) {
				return { status: "truncated", reason: entry.content.reason };
			}
			return { status: "unavailable", reason: entry.content.reason };
	}
}

function compareResources(
	left: ContextIndexResource,
	right: ContextIndexResource,
): number {
	return compareStrings(left.path, right.path);
}

function compareSkills(
	left: ContextSkillIndexEntry,
	right: ContextSkillIndexEntry,
): number {
	return compareStrings(left.name, right.name);
}

function compareStrings(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}
