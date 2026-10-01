import { createHash } from "node:crypto";
import { filterKnownSecrets } from "../secret-filter/index.js";

export function filterContextMetadata<Value>(value: Value): Value {
	const filteredStrings = new Map<string, string>();
	const redactSecret = (ruleId: string, original: string): string =>
		`[REDACTED:${ruleId}:${createHash("sha256").update(original).digest("hex").slice(0, 12)}]`;
	const filterValue = (current: unknown): unknown => {
		if (typeof current === "string") {
			const cached = filteredStrings.get(current);
			if (cached !== undefined) return cached;
			// Text rules need token boundaries, which names and paths lack
			// (`<token>.md`, `.claude/skills/<token>.guide/`, `host:<token>.git`).
			// Filter the whole string, then each path segment (keeps dotted
			// secrets such as JWTs whole), then each piece of a segment.
			const filterPieces = (text: string, separators: RegExp): string =>
				text
					.split(separators)
					.map((piece) => filterKnownSecrets(piece, redactSecret).text)
					.join("");
			const filtered = filterPieces(
				filterPieces(
					filterKnownSecrets(current, redactSecret).text,
					/([/\\])/u,
				),
				/([.:@\s])/u,
			);
			filteredStrings.set(current, filtered);
			return filtered;
		}
		if (Array.isArray(current)) return current.map(filterValue);
		if (current !== null && typeof current === "object") {
			return Object.fromEntries(
				Object.entries(current).map(([key, child]) => [
					key,
					filterValue(child),
				]),
			);
		}
		return current;
	};
	return filterValue(value) as Value;
}
