export type RedactionCounts = Readonly<Record<string, number>>;

export interface SecretRule {
	readonly id: string;
	readonly sourceId: string;
	readonly regexSource: string;
	readonly caseInsensitive: boolean;
	readonly secretGroup: number;
	readonly allowlistRegexSources: readonly string[];
	/**
	 * Lowercase literals of which at least one occurs, ignoring case, in every
	 * match. Text containing none of them skips the rule.
	 */
	readonly keywords?: readonly string[];
}

export interface SecretFilterResult {
	readonly text: string;
	readonly counts: RedactionCounts;
	readonly redactedBytes: number;
}

export interface FilterableSubagent {
	readonly content: string;
}

export interface SessionTextFilterResult<TSubagent extends FilterableSubagent> {
	readonly content: string;
	readonly subagents:
		| ReadonlyArray<TSubagent & { content: string }>
		| undefined;
	readonly counts: RedactionCounts;
	readonly redactedBytes: number;
}

export interface RedactionBudgetAnomaly {
	readonly inputBytes: number;
	readonly redactedBytes: number;
	readonly ruleIds: readonly string[];
}
