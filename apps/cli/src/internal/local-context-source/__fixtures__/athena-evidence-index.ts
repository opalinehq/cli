import type { RepositoryEvidenceInitInput } from "../../../contracts/repository-evidence.js";

const SKILL_USE = new Set(["observed-used", "no-observed-use", "unknown"]);
const SKILL_SCOPE = new Set(["session", "run", "agent"]);
const SKILL_DISCOVERY = new Set(["present"]);
const SKILL_NAME_SOURCE = new Set(["definition-directory"]);
const RESOURCE_ACCESS = new Set([
	"readable",
	"reference-only",
	"denied",
	"truncated",
	"unavailable",
]);
const TRUNCATED_RESOURCE_REASONS = new Set([
	"file-content-cap",
	"root-content-cap",
	"total-content-cap",
]);
const UNAVAILABLE_RESOURCE_REASONS = new Set([
	"binary",
	"high-risk-path",
	"secret-filter-failure",
	"secret-filter-budget",
	"not-file",
]);
const FACET_KINDS = new Set([
	"agents-instructions",
	"claude-instructions",
	"plans",
	"hooks",
	"mcp",
	"package-context",
]);
const PRESENCE = new Set(["present", "absent", "unknown"]);
const FACET_COVERAGE = new Set([
	"complete",
	"denied",
	"excluded",
	"truncated",
	"unavailable",
]);

export function buildRepositoryEvidenceIndexRow(
	evidence: RepositoryEvidenceInitInput,
	manifest: unknown,
	indexedAt: Date,
	userId: string,
) {
	const contextIndex = readContextIndex(manifest);
	const provider = evidence.repository.provider;
	const coverageStatus = evidence.coverage.some(
		(item) => item.status === "unavailable",
	)
		? "unavailable"
		: evidence.coverage.some((item) => item.status === "partial")
			? "partial"
			: "complete";
	return {
		agent_id: evidence.session.agentId ?? "",
		available_skills: contextIndex.skills.map((skill) => skill.name),
		capture_completed_at: formatClickHouseDateTime64(
			evidence.capture.timing.captureCompletedAt,
		),
		capture_id: evidence.capture.contextId,
		capture_lifecycle: evidence.capture.timing.lifecycle,
		capture_started_at: formatClickHouseDateTime64(
			evidence.capture.timing.captureStartedAt,
		),
		capture_status: "complete",
		context_facets: contextIndex.facets.map((facet) => [
			facet.kind,
			facet.rootId,
			facet.presence,
			facet.coverage,
			worstAccess(facet.resources.map((resource) => resource.access)),
			facet.resources.length,
		]),
		context_id: evidence.capture.contextId,
		coverage_areas: evidence.coverage.map((item) => [
			item.area,
			item.status,
			item.reason ?? "",
		]),
		coverage_status: coverageStatus,
		first_action_at: formatClickHouseDateTime64(
			evidence.capture.timing.firstActionAt,
		),
		first_action_basis: evidence.capture.timing.firstActionBasis,
		first_action_relationship: evidence.capture.timing.firstActionRelationship,
		index_version: String(indexedAt.getTime()),
		indexed_at: formatClickHouseDateTime64(indexedAt.toISOString()),
		manifest_object_id: evidence.manifestObjectId,
		organization_id: evidence.organizationId,
		user_id: userId,
		parent_agent_id: evidence.session.parentAgentId ?? "",
		parent_context_id: evidence.capture.parentContextId,
		repository_host: provider?.host ?? "",
		repository_id:
			provider?.repositoryId ?? evidence.repository.local.repositoryId,
		repository_name: provider?.name ?? "",
		repository_owner: provider?.owner ?? "",
		repository_provider: provider?.provider ?? "",
		run_id: evidence.session.runId,
		segment_id: evidence.session.segmentId,
		session_id: evidence.session.sessionId,
		session_source: evidence.session.source,
		skill_assessments: contextIndex.skills.map((skill) => {
			const use = readSkillUse(skill.use);
			return [
				skill.name,
				use.status,
				use.scopeKind,
				use.scopeId,
				use.coverage,
				worstAccess(skill.definitions.map((definition) => definition.access)),
			];
		}),
		worktree_id: evidence.repository.local.worktreeId,
	};
}

function formatClickHouseDateTime64(value: string): string;
function formatClickHouseDateTime64(value: null): null;
function formatClickHouseDateTime64(value: string | null): string | null;
function formatClickHouseDateTime64(value: string | null): string | null {
	if (value === null) return null;
	const instant = new Date(value);
	if (!Number.isFinite(instant.getTime())) {
		throw new Error("Repository evidence timestamp is invalid");
	}
	return instant.toISOString().replace("T", " ").replace("Z", "");
}

interface IndexedResource {
	readonly access: string;
}

interface IndexedFacet {
	readonly coverage: string;
	readonly kind: string;
	readonly presence: string;
	readonly resources: readonly IndexedResource[];
	readonly rootId: string;
}

interface IndexedSkill {
	readonly definitions: readonly IndexedResource[];
	readonly name: string;
	readonly use: unknown;
}

function readContextIndex(value: unknown): {
	readonly facets: readonly IndexedFacet[];
	readonly skills: readonly IndexedSkill[];
} {
	const root = asRecord(value, "evidence manifest");
	const contextIndex = asRecord(root.contextIndex, "context index");
	if (
		!Array.isArray(contextIndex.facets) ||
		!Array.isArray(contextIndex.skills)
	) {
		throw new Error("Repository evidence context index is incomplete");
	}
	return {
		facets: contextIndex.facets.map((value) => {
			const facet = asRecord(value, "context facet");
			const kind = enumString(facet.kind, FACET_KINDS, "facet kind");
			const presence = enumString(facet.presence, PRESENCE, "facet presence");
			const coverage = enumString(
				facet.coverage,
				FACET_COVERAGE,
				"facet coverage",
			);
			if (typeof facet.rootId !== "string" || !Array.isArray(facet.resources)) {
				throw new Error("Repository evidence context facet is invalid");
			}
			return {
				coverage,
				kind,
				presence,
				resources: facet.resources.map(readResource),
				rootId: facet.rootId,
			};
		}),
		skills: contextIndex.skills.map((value) => {
			const skill = asRecord(value, "skill assessment");
			if (
				typeof skill.name !== "string" ||
				skill.name.trim().length === 0 ||
				!Array.isArray(skill.definitions)
			) {
				throw new Error("Repository evidence skill assessment is invalid");
			}
			enumString(skill.discovery, SKILL_DISCOVERY, "skill discovery");
			enumString(skill.nameSource, SKILL_NAME_SOURCE, "skill name source");
			return {
				definitions: skill.definitions.map(readResource),
				name: skill.name,
				use: skill.use,
			};
		}),
	};
}

function readResource(value: unknown): IndexedResource {
	const resource = asRecord(value, "context resource");
	const access = asRecord(resource.access, "context resource access");
	const status = enumString(access.status, RESOURCE_ACCESS, "resource access");
	if (!isValidResourceAccessDetail(status, access.reason)) {
		throw new Error("Repository evidence resource access detail is invalid");
	}
	return {
		access: status,
	};
}

function readSkillUse(value: unknown): {
	readonly coverage: string;
	readonly scopeId: string;
	readonly scopeKind: string;
	readonly status: string;
} {
	const use = asRecord(value, "skill use");
	const status = enumString(use.status, SKILL_USE, "skill use status");
	if (status === "observed-used" || status === "no-observed-use") {
		const scope = asRecord(use.evidenceScope, "skill evidence scope");
		if (typeof scope.id !== "string" || scope.id.trim().length === 0) {
			throw new Error("Repository evidence skill scope id is invalid");
		}
		return {
			coverage: "complete",
			scopeId: scope.id,
			scopeKind: enumString(scope.kind, SKILL_SCOPE, "skill scope"),
			status,
		};
	}
	const reason = use.reason;
	if (reason !== "no-evidence" && reason !== "partial-evidence") {
		throw new Error("Repository evidence skill use reason is invalid");
	}
	if (
		(reason === "no-evidence" && use.evidenceScope !== null) ||
		(reason === "partial-evidence" && use.evidenceScope === null)
	) {
		throw new Error("Repository evidence skill evidence scope is invalid");
	}
	const scope =
		use.evidenceScope === null
			? null
			: asRecord(use.evidenceScope, "skill evidence scope");
	if (
		scope !== null &&
		(typeof scope.id !== "string" || scope.id.trim().length === 0)
	) {
		throw new Error("Repository evidence skill scope id is invalid");
	}
	return {
		coverage: reason === "partial-evidence" ? "partial" : "unavailable",
		scopeId: typeof scope?.id === "string" ? scope.id : "",
		scopeKind:
			scope === null
				? "none"
				: enumString(scope.kind, SKILL_SCOPE, "skill scope"),
		status,
	};
}

function isValidResourceAccessDetail(status: string, reason: unknown): boolean {
	switch (status) {
		case "readable":
			return reason === undefined;
		case "reference-only":
			return reason === "git-object";
		case "denied":
			return reason === "read-error";
		case "truncated":
			return (
				typeof reason === "string" && TRUNCATED_RESOURCE_REASONS.has(reason)
			);
		case "unavailable":
			return (
				typeof reason === "string" && UNAVAILABLE_RESOURCE_REASONS.has(reason)
			);
		default:
			return false;
	}
}

function worstAccess(values: readonly string[]): string {
	const order = [
		"unknown",
		"readable",
		"reference-only",
		"truncated",
		"unavailable",
		"denied",
	];
	if (values.length === 0) return "unknown";
	return values.reduce((worst, current) =>
		order.indexOf(current) > order.indexOf(worst) ? current : worst,
	);
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`Repository ${label} is invalid`);
	}
	return value as Record<string, unknown>;
}

function enumString(
	value: unknown,
	accepted: ReadonlySet<string>,
	label: string,
): string {
	if (typeof value !== "string" || !accepted.has(value)) {
		throw new Error(`Repository evidence ${label} is invalid`);
	}
	return value;
}
