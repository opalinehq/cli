export const LOCAL_CONTEXT_BUNDLE_SCHEMA_VERSION = "1.1.0";
export const LOCAL_CONTEXT_COLLECTOR_VERSION = 2;
export const LOCAL_CONTEXT_LIFECYCLE = "sanitized-local-spool";

export type ContextRootOrigin = "repository" | "user" | "admin" | "system";
export type ContextRootScope =
	| "repository"
	| "instructions"
	| "skills"
	| "plans"
	| "agent-config"
	| "custom";

export interface AdditionalContextRoot {
	readonly id: string;
	readonly label: string;
	readonly absolutePath: string;
	readonly origin: Exclude<ContextRootOrigin, "repository">;
	readonly scope: Exclude<ContextRootScope, "repository">;
	/**
	 * Collect only these root-relative paths instead of walking the whole
	 * root (home directories hold far more than agent context). Missing paths
	 * are absent. `instruction` files go to the instruction pool, `metadata`
	 * files are inventoried and hashed only, `tree` directories are walked.
	 */
	readonly include?: readonly ContextRootInclude[];
	/**
	 * Directory symlinks of skill and instruction directories are followed
	 * when their target resolves inside this directory (\$HOME for user roots).
	 * Without it, symlinks are recorded and not followed.
	 */
	readonly followSymlinksWithin?: string;
}

export interface ContextRootInclude {
	readonly path: string;
	readonly role: "instruction" | "metadata" | "tree";
}

export interface LocalContextCollectionLimits {
	readonly maxDepthPerRoot: number;
	readonly maxEntriesPerRoot: number;
	readonly maxTotalEntries: number;
	readonly maxBlobs: number;
	readonly maxContentBytesPerFile: number;
	readonly maxContentBytesPerRoot: number;
	readonly maxTotalContentBytes: number;
	readonly maxHashBytesPerFile: number;
	readonly maxHashBytesPerRoot: number;
	readonly maxTotalHashBytes: number;
	readonly binaryProbeBytes: number;
	readonly maxGitOutputBytesPerCommand: number;
	readonly gitCommandTimeoutMs: number;
	readonly maxCommits: number;
	readonly maxCoverageErrors: number;
	// Session-evidence pools. Instruction files and patches are budgeted
	// separately from other content so they are never crowded out.
	readonly maxInstructionFiles: number;
	readonly maxInstructionContentBytesPerFile: number;
	readonly maxInstructionContentBytes: number;
	readonly maxDiffContentBytes: number;
	// User context (skill definitions, auto-memory, user commands, agents and
	// output styles) and saved tool outputs have pools of their own as well.
	readonly maxUserContextFiles: number;
	readonly maxUserContextContentBytesPerFile: number;
	readonly maxUserContextContentBytes: number;
	readonly maxToolResultFiles: number;
	readonly maxToolResultContentBytesPerFile: number;
	readonly maxToolResultContentBytes: number;
}

export interface LocalContextCollectionOptions {
	readonly limits: LocalContextCollectionLimits;
	readonly additionalRoots: readonly AdditionalContextRoot[];
	readonly excludedPathPrefixes: readonly string[];
	readonly capturePolicy: "delta" | "session-evidence";
	readonly parentCapture: ParentCaptureReference | null;
	readonly observedSkillNames?: readonly string[];
	/**
	 * Repository-relative working directory of the session. Instruction files
	 * that apply to it are captured before other nested instruction files.
	 */
	readonly workingDirectory?: string;
	/** Symlink targets never followed into (the CLI's private config directory). */
	readonly forbiddenSymlinkTargets?: readonly string[];
	/**
	 * Applied to saved tool-output text before the secret filter, so it gets
	 * the same slimming as the transcript that references it.
	 */
	readonly transformToolResultText?: (text: string) => string;
}

export interface ParentCaptureReference {
	readonly id: string;
	readonly blobIds: readonly string[];
}

export interface FileSystemEntry {
	readonly name: string;
	readonly kind: "file" | "directory" | "symlink" | "other";
}

export interface FileSystemStat {
	readonly kind: "file" | "directory" | "symlink" | "other";
	readonly size: number;
	readonly mode: number;
	readonly modifiedAtMs: number;
}

export interface BoundedReadResult {
	readonly bytes: Uint8Array;
	readonly complete: boolean;
}

export interface BoundedHashResult {
	readonly algorithm: "sha256";
	readonly value: string;
	readonly bytesHashed: number;
	readonly complete: boolean;
}

export interface LocalContextFileSystem {
	realpath(path: string): Promise<string>;
	lstat(path: string): Promise<FileSystemStat>;
	readDirectory(
		path: string,
		maxEntries: number,
	): Promise<{
		readonly entries: FileSystemEntry[];
		readonly complete: boolean;
	}>;
	readFileBounded(path: string, maxBytes: number): Promise<BoundedReadResult>;
	hashFileBounded(path: string, maxBytes: number): Promise<BoundedHashResult>;
	readLink(path: string): Promise<string>;
}

export interface GitCommandResult {
	readonly exitCode: number;
	readonly stdout: Uint8Array;
	readonly stderr: Uint8Array;
	readonly truncated: boolean;
	readonly timedOut: boolean;
}

export interface LocalContextGitRunner {
	run(
		workingDirectory: string,
		args: readonly string[],
		maxOutputBytes: number,
		timeoutMs: number,
	): Promise<GitCommandResult>;
}

export interface LocalContextSourceEnv {
	readonly fileSystem: LocalContextFileSystem;
	readonly git: LocalContextGitRunner;
	readonly now: () => Date;
	readonly createCaptureId: () => string;
}

export type ContextFileCategory =
	| "markdown"
	| "instruction"
	| "skill-definition"
	| "skill-resource"
	| "plan-candidate"
	| "agent-config"
	| "mcp-config"
	| "hook-config"
	| "package-context"
	| "source"
	| "test"
	| "config"
	| "document"
	| "other";

export type GitFileProvenance =
	| "tracked"
	| "untracked"
	| "ignored"
	| "unclassified"
	| "outside-repository";

export type FileHash =
	| {
			readonly status: "available";
			readonly algorithm: "sha256";
			readonly value: string;
			readonly bytesHashed: number;
			readonly scope: "source" | "stored";
	  }
	| {
			readonly status: "git-object";
			readonly algorithm: "git-sha1" | "git-sha256" | "git-unknown";
			readonly value: string;
			readonly bytesHashed: number;
	  }
	| {
			readonly status: "omitted";
			readonly reason:
				| "high-risk-path"
				| "hash-file-cap"
				| "hash-root-cap"
				| "hash-total-cap"
				| "read-error"
				| "not-file";
	  };

export interface SecretFilterMetadata {
	readonly filterVersion: number;
	readonly counts: Readonly<Record<string, number>>;
	readonly redactedBytes: number;
}

export type FileContent =
	| {
			readonly status: "available";
			readonly blobId: string;
			readonly sourceByteLength: number;
			readonly storedByteLength: number;
			readonly encoding: "utf-8";
			readonly secretFilter: SecretFilterMetadata;
	  }
	| {
			readonly status: "reused";
			readonly blobId: string;
			readonly parentCaptureId: string;
			readonly sourceByteLength: number;
			readonly storedByteLength: number;
			readonly encoding: "utf-8";
			readonly secretFilter: SecretFilterMetadata;
	  }
	| {
			readonly status: "git-object";
			readonly objectId: string;
			readonly objectFormat: "sha1" | "sha256" | "unknown";
			readonly commit: string;
			readonly sourceByteLength: number;
	  }
	| {
			readonly status: "omitted";
			readonly reason:
				| "binary"
				| "high-risk-path"
				| "file-content-cap"
				| "root-content-cap"
				| "total-content-cap"
				| "read-error"
				| "secret-filter-failure"
				| "secret-filter-budget"
				| "blob-count-cap"
				| "metadata-only"
				| "not-file";
			readonly detail: string | null;
	  };

export interface ContextEntryBase {
	readonly rootId: string;
	readonly path: string;
	readonly name: string;
	readonly parentPath: string | null;
	readonly mode: number;
	readonly modifiedAtMs: number;
	readonly categories: readonly ContextFileCategory[];
	readonly gitProvenance: GitFileProvenance;
	readonly evidenceReason: string | null;
}

export interface ContextDirectoryEntry extends ContextEntryBase {
	readonly kind: "directory";
}

export interface ContextSubmoduleEntry extends ContextEntryBase {
	readonly kind: "submodule";
	readonly objectId: string;
	readonly objectFormat: "sha1" | "sha256" | "unknown";
	readonly indexStatus: string;
	readonly worktreeStatus: string;
	readonly followed: false;
}

export interface ContextRegularFileEntry extends ContextEntryBase {
	readonly kind: "file";
	readonly size: number;
	readonly hash: FileHash;
	readonly content: FileContent;
}

export interface ContextSymlinkEntry extends ContextEntryBase {
	readonly kind: "symlink";
	readonly target: string;
	readonly targetScope: "internal" | "external" | "broken" | "unknown";
	/** A followed directory symlink's contents are listed under its path. */
	readonly followed: boolean;
}

export interface ContextOtherEntry extends ContextEntryBase {
	readonly kind: "other";
	readonly size: number;
}

export type ContextEntry =
	| ContextDirectoryEntry
	| ContextSubmoduleEntry
	| ContextRegularFileEntry
	| ContextSymlinkEntry
	| ContextOtherEntry;

export interface ContextBlob {
	readonly id: string;
	readonly algorithm: "sha256";
	readonly byteLength: number;
	readonly encoding: "utf-8";
	readonly content: string;
}

export interface CoverageError {
	readonly rootId: string;
	readonly path: string;
	readonly operation:
		| "root"
		| "lstat"
		| "readdir"
		| "read"
		| "hash"
		| "readlink";
	readonly code: string;
	readonly message: string;
}

export interface ExcludedPath {
	readonly rootId: string;
	readonly path: string;
	readonly reason:
		| "vcs"
		| "dependency"
		| "generated"
		| "cache"
		| "explicit"
		// A Git-ignored directory the entry budget did not reach.
		| "ignored";
}

export interface RootCoverage {
	readonly rootId: string;
	readonly discoveredEntries: number;
	readonly fileCount: number;
	readonly directoryCount: number;
	readonly submoduleCount: number;
	readonly symlinkCount: number;
	readonly otherCount: number;
	readonly contentFiles: number;
	readonly contentBytes: number;
	readonly hashedFiles: number;
	readonly hashedBytes: number;
	readonly omittedContentFiles: number;
	readonly excludedPaths: number;
	readonly limitsReached: readonly string[];
}

export interface ContextRootManifest {
	readonly id: string;
	readonly label: string;
	readonly absolutePath: string;
	readonly origin: ContextRootOrigin;
	readonly scope: ContextRootScope;
	readonly status: "collected" | "missing" | "inaccessible" | "limit-reached";
	readonly coverage: RootCoverage;
}

export interface ContextDocumentIndex {
	readonly markdown: readonly ContextPathReference[];
	readonly instructions: readonly ContextPathReference[];
	readonly skillDefinitions: readonly ContextPathReference[];
	readonly skillResources: readonly ContextPathReference[];
	readonly planCandidates: readonly ContextPathReference[];
	readonly agentConfigs: readonly ContextPathReference[];
	readonly mcpConfigs: readonly ContextPathReference[];
	readonly hookConfigs: readonly ContextPathReference[];
	readonly packageContexts: readonly ContextPathReference[];
}

export interface ContextPathReference {
	readonly rootId: string;
	readonly path: string;
}

export type ContextIndexFacetKind =
	| "agents-instructions"
	| "claude-instructions"
	| "plans"
	| "hooks"
	| "mcp"
	| "package-context";

export type ContextIndexCoverageStatus =
	| "complete"
	| "denied"
	| "excluded"
	| "truncated"
	| "unavailable";

export type ContextIndexResourceAccess =
	| { readonly status: "readable" }
	| { readonly status: "reference-only"; readonly reason: "git-object" }
	| { readonly status: "denied"; readonly reason: "read-error" }
	| {
			readonly status: "truncated";
			readonly reason:
				| "file-content-cap"
				| "root-content-cap"
				| "total-content-cap";
			/**
			 * Present when the content was left out by capture policy (the file
			 * is hash-only), not cut by a capacity limit. The server accepts no
			 * access value for this yet, so the wire status and reason stay
			 * `truncated` / `file-content-cap` for compatibility.
			 */
			readonly policy?: "hash-only";
	  }
	| {
			readonly status: "unavailable";
			readonly reason:
				| "binary"
				| "high-risk-path"
				| "secret-filter-failure"
				| "secret-filter-budget"
				| "not-file";
	  };

export interface ContextIndexResource extends ContextPathReference {
	readonly access: ContextIndexResourceAccess;
}

export interface ContextIndexFacet {
	readonly kind: ContextIndexFacetKind;
	readonly rootId: string;
	readonly presence: "present" | "absent" | "unknown";
	readonly coverage: ContextIndexCoverageStatus;
	readonly resources: readonly ContextIndexResource[];
}

export interface ContextSkillIndexEntry {
	readonly name: string;
	readonly nameSource: "definition-directory";
	readonly discovery: "present";
	readonly definitions: readonly ContextIndexResource[];
}

export interface ContextIndex {
	readonly facets: readonly ContextIndexFacet[];
	readonly skills: readonly ContextSkillIndexEntry[];
}

export interface ContextSkillEvidenceScope {
	readonly kind: "session" | "run" | "agent";
	readonly id: string;
}

export interface ContextSkillUsageEvidence {
	readonly scope: ContextSkillEvidenceScope;
	readonly coverage: "complete" | "partial";
	readonly observedSkillNames: readonly string[];
}

export type ContextSkillUse =
	| {
			readonly status: "observed-used";
			readonly evidenceScope: ContextSkillEvidenceScope;
	  }
	| {
			readonly status: "no-observed-use";
			readonly evidenceScope: ContextSkillEvidenceScope;
	  }
	| {
			readonly status: "unknown";
			readonly evidenceScope: ContextSkillEvidenceScope | null;
			readonly reason: "no-evidence" | "partial-evidence";
	  };

export interface ContextSkillAssessment extends ContextSkillIndexEntry {
	readonly use: ContextSkillUse;
}

export interface GitHead {
	readonly commit: string | null;
	readonly branch: string | null;
	readonly detached: boolean;
}

export interface GitRemote {
	readonly name: string;
	readonly direction: "fetch" | "push";
	readonly url: string;
}

export interface GitWorktree {
	readonly path: string;
	readonly head: string | null;
	readonly branch: string | null;
	readonly bare: boolean;
	readonly detached: boolean;
	readonly locked: string | null;
	readonly prunable: string | null;
}

export interface GitStatusEntry {
	readonly path: string;
	readonly originalPath: string | null;
	readonly indexStatus: string;
	readonly worktreeStatus: string;
	readonly kind: "ordinary" | "renamed" | "unmerged" | "untracked" | "ignored";
}

export interface GitCommit {
	readonly hash: string;
	readonly parentHashes: readonly string[];
	readonly authorName: string;
	readonly authorEmail: string;
	readonly authoredAt: string;
	readonly committedAt: string;
	readonly decorations: string;
	readonly subject: string;
}

export interface GitDiff {
	readonly kind: "working-tree" | "staged";
	readonly blobId: string | null;
	readonly sourceByteLength: number;
	readonly storedByteLength: number;
	readonly truncated: boolean;
	readonly reconstructable: boolean;
	readonly containsBinaryChanges: boolean;
	readonly highRiskPathsExcluded: true;
	readonly secretFilter: SecretFilterMetadata | null;
	readonly omissionReason:
		| "empty"
		| "truncated"
		| "secret-filter-failure"
		| "secret-filter-budget"
		| "blob-count-cap"
		| "total-content-cap"
		| null;
}

export interface GitRepositorySnapshot {
	readonly status: "available";
	readonly root: string;
	readonly gitDirectory: string;
	readonly commonDirectory: string;
	readonly bare: boolean;
	readonly head: GitHead;
	readonly remotes: readonly GitRemote[];
	readonly worktrees: readonly GitWorktree[];
	readonly statusEntries: readonly GitStatusEntry[];
	readonly commits: readonly GitCommit[];
	readonly diffs: readonly GitDiff[];
	readonly truncatedSections: readonly string[];
	readonly errors: readonly string[];
}

export interface GitUnavailableSnapshot {
	readonly status: "unavailable";
	readonly reason: "not-a-repository" | "command-failed" | "command-timeout";
	readonly detail: string;
}

export type GitSnapshot = GitRepositorySnapshot | GitUnavailableSnapshot;

export interface AggregateCoverage {
	readonly truncated?: {
		readonly omittedBlobs: number;
		readonly omittedEntries: number;
		readonly omittedMetadata?: number;
		readonly omittedSkillDefinitions?: number;
		readonly reason: "capture-limit";
	};
	readonly discoveredEntries: number;
	readonly inventoryBytes: number;
	readonly contentFiles: number;
	readonly contentBytes: number;
	readonly blobCount: number;
	readonly materializedBytes: number;
	readonly uploadCandidateBytes: number;
	readonly reusedBytes: number;
	readonly gitObjectBytes: number;
	readonly omittedBytes: number;
	readonly hashedFiles: number;
	readonly hashedBytes: number;
	readonly redactedBytes: number;
	readonly redactionCounts: Readonly<Record<string, number>>;
	readonly omittedContentFiles: number;
	readonly excludedPaths: readonly ExcludedPath[];
	readonly errors: readonly CoverageError[];
	readonly limitsReached: readonly string[];
	readonly partial: boolean;
	readonly partialReasons: readonly string[];
}

export interface CaptureConsistency {
	readonly atomic: false;
	readonly status: "stable" | "concurrent-change" | "unavailable";
	readonly initialHead: string | null;
	readonly finalHead: string | null;
	readonly initialStatusFingerprint: string | null;
	readonly finalStatusFingerprint: string | null;
}

export interface LocalContextManifest {
	readonly schemaVersion: typeof LOCAL_CONTEXT_BUNDLE_SCHEMA_VERSION;
	readonly collectorVersion: typeof LOCAL_CONTEXT_COLLECTOR_VERSION;
	readonly lifecycle: typeof LOCAL_CONTEXT_LIFECYCLE;
	readonly captureId: string;
	readonly parentCaptureId: string | null;
	readonly baseGitCommit: string | null;
	readonly capturePolicy: LocalContextCollectionOptions["capturePolicy"];
	readonly collectedAt: string;
	readonly startedAt: string;
	readonly completedAt: string;
	readonly consistency: CaptureConsistency;
	readonly repositoryRootId: "repository";
	readonly roots: readonly ContextRootManifest[];
	readonly entries: readonly ContextEntry[];
	readonly documents: ContextDocumentIndex;
	readonly contextIndex: ContextIndex;
	readonly git: GitSnapshot;
	readonly coverage: AggregateCoverage;
	/** Secret-filtered user-level agent configuration (hooks, MCP, plugins). */
	readonly userConfiguration?: UserAgentConfiguration;
	/**
	 * Records of the session transcript that reference a saved tool output in
	 * the `claude-tool-results` root, so each output stays linked to the
	 * record (stream and 1-based JSONL line) and tool call that produced it.
	 */
	readonly toolResultReferences?: ToolResultReferences;
	/** Tool and agent versions on the capturing machine. */
	readonly runtime?: CaptureRuntime;
	readonly transport: {
		readonly secretFilterApplied: true;
		readonly secretFilterVersion: number;
		readonly requiresAdditionalReview: true;
		readonly rawContentIncluded: false;
	};
}

export interface UserAgentHook {
	readonly event: string;
	readonly matcher: string | null;
	readonly type: string | null;
	readonly command: string | null;
	readonly timeoutSeconds: number | null;
	readonly async: boolean | null;
}

export interface UserAgentMcpServer {
	readonly name: string;
	readonly transport: "stdio" | "http" | "unknown";
	readonly command: string | null;
	readonly args: readonly string[];
	readonly url: string | null;
	readonly enabled: boolean | null;
	readonly envKeys: readonly string[];
	readonly headerKeys: readonly string[];
	readonly bearerTokenEnvVar: string | null;
}

export interface UserAgentConfigurationSource {
	readonly path: string;
	readonly status: "parsed" | "absent" | "unreadable";
}

/** An MCP server and where it is configured. */
export interface UserAgentScopedMcpServer extends UserAgentMcpServer {
	readonly scope: "user" | "project" | "managed";
}

/**
 * One layer of Claude Code's effective settings, sanitized: `env` keeps only
 * variable names, values under credential-like keys are replaced, every string
 * passes the inline-credential and known-secret filters, and lists and depth
 * are bounded.
 */
export interface UserAgentSettingsLayer extends UserAgentConfigurationSource {
	readonly scope:
		| "user"
		| "user-local"
		| "project"
		| "project-local"
		| "managed";
	readonly settings: unknown;
}

export interface UserAgentConfiguration {
	readonly claude: {
		readonly settings: UserAgentConfigurationSource;
		readonly hooks: readonly UserAgentHook[];
		readonly enabledPlugins: Readonly<Record<string, boolean>>;
		readonly permissions: {
			readonly defaultMode: string | null;
			readonly allow: readonly string[];
			readonly deny: readonly string[];
			readonly ask: readonly string[];
			readonly additionalDirectories: readonly string[];
		};
		readonly installedPlugins: readonly string[];
		/** Every settings layer that applies to the session, lowest first. */
		readonly settingsLayers: readonly UserAgentSettingsLayer[];
		/**
		 * MCP servers from ~/.claude.json (only its `mcpServers` sections: the
		 * global one and the session project's) and managed-mcp.json.
		 */
		readonly mcpServers: readonly UserAgentScopedMcpServer[];
		readonly stateFile: UserAgentConfigurationSource;
	};
	readonly codex: {
		readonly config: UserAgentConfigurationSource;
		readonly hooksFile: UserAgentConfigurationSource;
		readonly mcpServers: readonly UserAgentMcpServer[];
		readonly notify: readonly string[];
		readonly hooks: readonly UserAgentHook[];
		readonly plugins: Readonly<Record<string, boolean>>;
		/** Enablement flags of features, apps, connectors and tools. */
		readonly features: Readonly<Record<string, boolean>>;
		readonly apps: Readonly<Record<string, boolean>>;
		readonly connectors: Readonly<Record<string, boolean>>;
		readonly tools: Readonly<Record<string, boolean>>;
		readonly approvalPolicy: string | null;
		readonly sandboxMode: string | null;
	};
	readonly truncated: boolean;
}

export interface ToolResultReference {
	/** Path relative to the `claude-tool-results` root. */
	readonly path: string;
	/** Subagent stream, or null for the main transcript. */
	readonly agentId: string | null;
	/** 1-based JSONL line of the referencing record in its stream. */
	readonly recordIndex: number;
	readonly toolUseId: string | null;
}

export interface ToolResultReferences {
	readonly references: readonly ToolResultReference[];
	/** References beyond the manifest's bound that were not listed. */
	readonly omitted: number;
}

export interface CaptureRuntime {
	readonly os: {
		readonly platform: string;
		readonly release: string;
		readonly arch: string;
	};
	/** The JavaScript runtime executing the CLI. */
	readonly cli: { readonly runtime: "node" | "bun"; readonly version: string };
	/** Versions of tools on PATH; null when absent or slower than the timeout. */
	readonly tools: {
		readonly node: string | null;
		readonly bun: string | null;
		readonly git: string | null;
		readonly python: string | null;
	};
	/** The agent that wrote the transcript, from the transcript itself. */
	readonly agentHost: {
		readonly name: "claude-code" | "codex";
		readonly version: string | null;
		readonly originator: string | null;
	} | null;
}

export interface LocalContextBundle {
	readonly manifest: LocalContextManifest;
	readonly blobs: readonly ContextBlob[];
}
