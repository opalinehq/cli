# Persistent Claude + Codex Skill Extraction

> **Historical monorepo plan.** The paths, branches, and infrastructure below refer to the former combined repository. This is not a current specification or runbook for the public CLI. See [Contributing](../../CONTRIBUTING.md) for current CLI development instructions.

Status: closeout implementation, regeneration, and all locally runnable verification are complete. No migration has been applied anywhere.

## Closeout decisions

- Content-dedup lookups now filter the exact known `(skill_name, content_sha256, user_id)` tuples beneath the organization prefix and carry 10M-row/2-GiB/60-second strict scan caps. Per `schema-pk-filter-on-orderby`, this uses the full `(organization_id, skill_name, content_sha256, user_id)` ordering prefix instead of skipping the hash column.
- `skill_uses` retains the six-column `ORDER BY` required for generation-safe replacement, while its sparse `PRIMARY KEY` stops at `(organization_id, skill_name, agent, user_id, session_id)`. Per `schema-pk-plan-before-creation` and `schema-pk-prioritize-filters`, the unapplied migration is the free point to avoid indexing the high-cardinality sequence without changing row identity.
- Known limitation, accepted: if two replicas ingest different revisions of the same session in the same millisecond, their deterministic sequences tie. Duplicate skip requires both the ownership content hash and an exact skill-receipt source hash/parser match, so a divergent or stale receipt takes the later-millisecond duplicate-reprocessing path and converges skills with ownership. The residual ambiguity is that the raw `ReplacingMergeTree(ingested_at)` equal-version winner can disagree with the ownership/skills winner until the session content next changes. This raw/ownership ambiguity predates skills and requires a shared per-session generation reserved in Postgres before raw insertion; that is a platform-level raw + ownership + skills coherence follow-up, not a skills-feature change.

## Round-four final review decisions

- F1/F2 are one composed commit protocol. `extraction_seq` is deterministic `UInt64`: `(raw_revision_ingested_at_ms << 16) | parser_version`. The `skill_uses` key appends the sequence, preserving every generation; the receipt keeps one session identity and is the commit pointer. Active reads first join preserved uses to the latest receipt on exact sequence/hash/parser and only then collapse identical-sequence retries. This follows `decision-late-arriving-upserts`: raw revision time, not extraction completion time, arbitrates replacement.
- F3 makes bodies erasable by adding `user_id` to `skill_version_contents` and keying `(organization_id, skill_name, content_sha256, user_id)`. Detail collapses same-hash user copies with `any(content)`. Organization/account purge and ownership cleanup use capped, lightweight `DELETE` operations. The account-delete predicate is intentionally not prefix-aligned for this rare privacy operation; `insert-mutation-avoid-delete` favors avoiding routine deletes, but explicit erasure is the justified exception.
- F4 keeps the approximately 1,000-row write target and adds a 32 MiB ceiling per table. A candidate is pre-flushed if adding it would cross the ceiling; an individually oversized content row is flushed immediately by itself. This applies `insert-batch-size` without allowing body-heavy buffers to grow unbounded.
- F5 prefix-aligns repeated backfill reads: receipt reads filter organization, agent, candidate users, and sessions; raw revision checks filter organization, candidate session dates, and sessions. Both carry row/byte/time scan caps. The receipt key is `(organization_id, agent, user_id, session_id)` per `schema-pk-cardinality-order` because agent is low-cardinality and known on every receipt read.
- F6 adds `max_rows_in_set`, `max_bytes_in_set`, and `timeout_before_checking_execution_speed = 0` to every persistent historical-skills read. Per `query-join-filter-before`, both use and receipt inputs are narrowed before the join; per `query-join-use-any`, the already-collapsed receipt side remains an `INNER ANY JOIN`.

## Round-two review fixes (superseded where noted by round three)

- F1 (superseded): round two used extraction completion time; round three added random entropy. Round four replaces both with deterministic raw-revision/parser sequencing.
- F2 (superseded): candidate parsing remains isolated, but round three decouples raw-read batches from table writes and buffers about 1,000 rows per table before flushing.
- F3 (superseded key shape): round four reorders receipts and appends `extraction_seq` to uses so uncommitted generations cannot physically replace committed ones.
- F4: all skills reads receive ClickHouse execution/result guardrails. Detail returns at most 100 newest versions and fetches content only for those hashes. Pagination and lazy version-content endpoints are explicitly deferred product work.

## Outcome and invariants

Extract exact skill usage and recoverable `SKILL.md` bodies once, while the API already has the filtered transcript in memory, then answer `analytics.skills.list` and `analytics.skills.detail` from compact derived ClickHouse tables. The steady-state read path does not select `content` from `rudel.claude_sessions` or `rudel.codex_sessions`.

The implementation preserves these invariants:

- Skill identity is the case-sensitive transcript name. Claude plugin names such as `atlas:humanizer` remain distinct from `humanizer`.
- An active use is logically unique by `(organization_id, skill_name, agent, user_id, session_id)`; physical use generations add `extraction_seq`. A receipt is unique by `(organization_id, agent, user_id, session_id)`.
- Re-uploads replace the logical session/skill set without diff tombstones: only rows whose sequence exactly matches the winning receipt can activate. Older committed and newer uncommitted generations remain physically distinct.
- Every extraction run has one deterministic `UInt64 extraction_seq = (raw_revision_ingested_at_ms << 16) | (parser_version & 0xffff)`, shared by its receipt/use/content rows. Same revision and parser always retry with the same sequence. Active reads join on the winning receipt's exact sequence, source hash, and parser version before collapsing same-sequence retries; they do not reduce all use generations and then reject the winner.
- Cross-replica raw revisions that share the same millisecond remain ambiguous as documented in the closeout limitation above. Exact ownership-hash and receipt-hash/parser checks force stale skill state through duplicate reprocessing, while the raw equal-version winner may still disagree with ownership/skills until the content next changes; eliminating that residual requires the platform-level shared-generation follow-up.
- Claude content is the complete injected body after the base-directory line, normalized only for BOM/CRLF handling and frontmatter stripping. Codex content remains byte-exact after removing the tool envelope and is accepted only when completeness is provable.
- Content hashes are SHA-256 over the exact product-visible body. An empty body hash represents an observed use whose complete body is unavailable.
- Full content is stored in the content-version table, not repeated on every use row.
- Derived skill data has no TTL: it must outlive the raw transcript's 365-day TTL for historical UI and future user/time-window digests.

## Workload and schema decisions

Workload: product analytics with low-volume point/list reads, append-friendly ingest-time derivation, replay/backfill, and latest-state semantics on session re-upload. The hot filters are workspace, then optional user/source/name; detail reads are workspace + exact skill name. Raw transcripts are large and cold; derived rows are small except for one deduplicated body per version.

### `rudel.skill_receipts`

```sql
CREATE TABLE rudel.skill_receipts
(
    organization_id String,
    agent LowCardinality(String),
    user_id String,
    session_id String,
    source_content_sha256 FixedString(64),
    parser_version UInt16,
    extraction_seq UInt64,
    extracted_at DateTime64(3, 'UTC')
)
ENGINE = SharedReplacingMergeTree(extraction_seq)
ORDER BY (organization_id, agent, user_id, session_id)
SETTINGS index_granularity = 8192, storage_policy = 's3';
```

One row per source session records `source_content_sha256` and `parser_version`, including sessions with zero skills. Receipt rows are written last, so partial content/use writes are never exposed as a completed extraction.

### `rudel.skill_uses`

```sql
CREATE TABLE rudel.skill_uses
(
    organization_id String,
    skill_name String,
    agent LowCardinality(String),
    user_id String,
    session_id String,
    content_sha256 String,
    source_content_sha256 FixedString(64),
    used_at DateTime64(3, 'UTC'),
    parser_version UInt16,
    extraction_seq UInt64,
    extracted_at DateTime64(3, 'UTC')
)
ENGINE = SharedReplacingMergeTree(extraction_seq)
PRIMARY KEY (organization_id, skill_name, agent, user_id, session_id)
ORDER BY (organization_id, skill_name, agent, user_id, session_id, extraction_seq)
SETTINGS index_granularity = 8192, storage_policy = 's3';
```

There is no extraction-diff tombstone or record-kind discriminator. Uses and receipts have distinct tables and workload-aligned keys; a complete receipt activates only use rows from that exact sequence. Purge and ownership cleanup continue to use lightweight `DELETE` mutations and therefore do not require `is_deleted`.

Schema rationale and rule citations:

- Per `schema-pk-plan-before-creation`, `schema-pk-prioritize-filters`, and `schema-pk-filter-on-orderby`, the uses key begins with the exact analytics filter `(organization_id, skill_name)`, while the receipt key begins with its repeated reconciliation filters.
- Per `schema-pk-cardinality-order`, low-cardinality `agent` precedes higher-cardinality user/session identity after the required organization/name prefix.
- Per `schema-types-native-types` and `schema-types-minimize-bitwidth`, timestamps use `DateTime64`, parser versions use `UInt16`, and the epoch-millisecond value shifted by only 16 bits fits in `UInt64`. `content_sha256` is `String`, rather than `FixedString(64)`, because the unavailable sentinel is `''`; the always-present source hash uses `FixedString(64)`.
- Per `schema-types-lowcardinality`, `agent` uses `LowCardinality(String)`. It intentionally does not use `Enum8`: adding another supported agent should not require a table recreation.
- Per `schema-types-avoid-nullable`, unavailable content uses `''`; no column needs `Nullable` semantics.
- Per `schema-partition-start-without` and `schema-partition-lifecycle`, the table starts without partitioning because no derived-data retention lifecycle is approved. Per `schema-partition-low-cardinality` and `schema-partition-query-tradeoffs`, it avoids user/session partitions and part explosion. This is an `official` recommendation with high confidence, sourced from the named rules and ClickHouse partitioning documentation.
- Per `insert-mutation-avoid-update` and architecture rule `decision-late-arriving-upserts`, replacement and parser-upgrade writes are inserts into `ReplacingMergeTree`, not mutations. This is an `official` recommendation with high confidence; validation is repeated-ingest/backfill tests using `argMax` reads.
- Per `insert-optimize-avoid-final`, no production workflow runs `OPTIMIZE FINAL`. One integration regression deliberately runs it once to prove the physical replacement key preserves committed generations.

### `rudel.skill_version_contents`

```sql
CREATE TABLE rudel.skill_version_contents
(
    organization_id String,
    skill_name String,
    content_sha256 FixedString(64),
    user_id String,
    content String,
    parser_version UInt16,
    extraction_seq UInt64,
    extracted_at DateTime64(3, 'UTC')
)
ENGINE = SharedReplacingMergeTree(extraction_seq)
ORDER BY (organization_id, skill_name, content_sha256, user_id)
SETTINGS index_granularity = 8192, storage_policy = 's3';
```

The detail filter remains aligned with the `(organization_id, skill_name, content_sha256)` prefix. Bodies deduplicate per uploader, making account erasure expressible even when organization and user IDs differ. A detail read groups by hash and selects `any(content)`; SHA-256 identity means user copies for the same hash have the same bytes. Source agent remains on uses, where aggregation groups by `(agent, content_sha256)`.

- Per `schema-pk-plan-before-creation`, `schema-pk-prioritize-filters`, and `schema-pk-filter-on-orderby`, this key matches the exact workspace + skill + hash read prefix and leaves uploader last for per-user replacement/deletion.
- Per `schema-types-native-types`, the guaranteed body hash is `FixedString(64)` and the body remains `String`.
- Per `schema-types-avoid-nullable`, only recovered bodies enter this table, so no nullable content/hash is needed.
- Per `schema-partition-start-without` and `schema-partition-lifecycle`, no partition or TTL is added without a lifecycle requirement.

### Ingestion strategy

The API writes recovered content rows first, then use rows, then the separate receipt row. Retries are safe because every physical row in an attempt shares one extraction sequence and active reads require the receipt's exact sequence. A failed receipt leaves preceding rows inert. The writer queries existing version hashes to avoid retransmitting known full bodies; it performs no active-use diff scan. The duplicate-upload fast path additionally requires a current skill receipt whenever skill extraction is enabled; a missing/stale receipt reprocesses the upload instead of silently bypassing persistence.

Per `decision-ingestion-strategy`, normal uploads are small independent writes, so acknowledged async inserts are the `official` fit when application batches cannot reach 10K rows. Per `insert-batch-size` and `insert-async-small-batches`, each upload keeps the repository's existing `async_insert=1, wait_for_async_insert=1` path. Backfill keeps raw reads at no more than 64 byte-bounded transcripts, but accumulates table-specific write buffers and flushes before either about 1,000 rows or 32 MiB per table. An individually oversized content row flushes immediately alone. Content/use buffers succeed before a candidate's receipt is queued; a table flush failure marks only affected candidates and the job continues. No Kafka/MV is justified for this producer shape.

Per `decision-real-time-preaggregation`, direct derived tables are preferable to an MV: shell tokenization and Claude invocation/body pairing require TypeScript, and list/detail aggregations over the compact use table are inexpensive. This is a `derived` recommendation with high confidence; validate with `EXPLAIN indexes = 1` and bounded API latency after backfill.

## Extraction implementation

1. Add a pure `historical-claude-skill-parser.ts` and refactor the Codex parser to expose session-wide uses while preserving the existing strict body-recovery function.
2. Claude parser behavior:
   - Parse only real top-level assistant entries containing `tool_use` blocks with `name === 'Skill'` and a non-empty `input.skill`.
   - Track pending invocations and match a later `isMeta: true` user text beginning with `Base directory for this skill:` only when its last path segment equals the last colon-delimited skill-name segment.
   - Allow unrelated tool entries between invocation and body, handle multiple/repeated skills, CRLF/BOM, bundled hashed paths, huge bodies, and string/array text content.
   - Ignore pasted/spoofed invocation JSON because nested strings are never interpreted as transcript entries.
3. Codex parser v1 behavior:
   - Preserve current accepted `cat`, `sed -n '1,Np'`, and `head -n N` forms and current envelope/exit/truncation checks.
   - Surface a use even when body recovery fails; choose the latest provably complete body for the session/name and keep the first valid invocation timestamp as `used_at` (fall back to session date).
   - Do not widen command/envelope/path acceptance in this change. Parser v2 will use corpus evidence to add forms independently.
4. Run skill parsing in the existing bounded transcript extraction worker so large JSONL does not block the API event loop. Extend the worker result with skill uses; keep usage-event behavior and queue limits unchanged. Gate persistence with `SKILL_EXTRACTION_ENABLED` (default true). The existing usage-extraction kill switch also bypasses the shared worker, so the operational runbook must use the skill backfill after any period where usage extraction was disabled.
5. Add `writeSkillExtraction` with receipt matching, content existence checks, raw-revision sequence ordering, exact receipt binding, and generated typed ClickHouse ingest functions.

Parser version starts at `1`. A version bump changes the constant and reruns the same backfill; the receipt mismatch forces re-extraction while `ReplacingMergeTree` and tuple `argMax(..., extraction_seq)` prevent count inflation or mixed revisions.

## Backfill and operational controls

Add `backfill:skills` with preview-first execution and an exact cutoff fence. It scans latest raw Claude and Codex snapshots as of the cutoff, candidate-filters on source-specific skill markers, reads raw content in month-aligned byte/row-bounded batches, parses in TypeScript, and writes through the same persistence service. It skips matching `(source_content_sha256, parser_version)` receipts and rechecks the latest raw revision before writing.

The backfill supersession pre-check is only a work-skipping optimization. Correctness belongs to deterministic sequence ordering: if a live extraction lands after the pre-check, a backfill write for the superseded raw revision carries a lower sequence and loses receipt `argMax` to the live extraction. A newer revision whose `session_date` also changed can therefore cause wasted backfill work, but not a wrong active answer.

Repeated receipt reconciliation filters the full known prefix `(organization_id, agent, user_id)` before candidate sessions and carries 10M-row/2-GiB/60-second caps. Revision fencing filters the raw-table `(organization_id, session_date)` prefix before session IDs and carries the existing 5M-row/16-GiB/300-second source caps. These predicates follow `schema-pk-filter-on-orderby`; bounded failure is preferable to an accidental broad scan.

Defaults and environment variables:

- `SKILL_BACKFILL_MAX_SESSIONS=10000`: hard census bound; execution fails rather than silently truncating.
- `SKILL_BACKFILL_MAX_SESSION_BYTES=536870912`: per-session safety bound.
- `SKILL_BACKFILL_BATCH_MAX_ROWS=64`: maximum raw snapshots per ClickHouse response.
- `SKILL_BACKFILL_BATCH_MAX_BYTES=134217728`: target response bytes per batch.

Document all variables in `.env.example` and the `CLAUDE.md` table, pass them through `apps/api/turbo.json`, and provide safe explicit values in CI where the integration backfill runs. CLI flags override defaults for one-off runs. Oversized/missing/superseded snapshots become bounded reported issues, never silent omissions.

## Read cutover and rollout

Decision: use the existing `off | canary | all` cutover pattern for one release. Add `SKILL_ANALYTICS_CUTOVER_MODE` and `SKILL_ANALYTICS_CANARY_ORG_IDS`. The new persistent service itself contains no raw-table references; a separately named legacy adapter remains only as the temporary `off`/non-canary fallback. A source guardrail test enforces the `skill_receipts` + `skill_uses` + `skill_version_contents` layout and rejects raw transcript reads.

Required production order (Evren-owned; this task does not perform production mutations):

1. Evren applies the generated migration to production ClickHouse manually.
2. Merge the PR; main auto-deploys ingest-time extraction with persistent reads still `off`.
3. Preview, then execute `backfill:skills` against the live 365-day transcript window; reconcile failures and recovery rates.
4. Enable selected internal canary workspace IDs and compare legacy/new results.
5. Set cutover mode to `all`; list/detail now read only the derived tables.
6. Remove the legacy adapter and cutover flags in the following release after stability is confirmed.

Local migration workflow: define schema, run `bun run ch:generate:dryrun`, generate with `bun run ch:generate` from `packages/ch-schema`, manually inspect/reorder generated DDL if chkit misorders it, run codegen, start local Docker with `bun run infra:up`, then apply only to local ClickHouse. Never run a migration against production from this worktree.

## API and web contract

- `HistoricalSkillAgent = 'claude' | 'codex'`.
- Summary adds `claudeSessionCount` and `codexSessionCount`; `sessionCount` remains total distinct `(user, agent, session)` uses.
- Version adds `sourceAgent`; grouping key is `(sourceAgent, contentSha256)` even when content bytes match.
- Detail adds sorted `sourceAgents` plus per-agent session counts so unavailable-only skills still carry a source label.
- Detail treats a missing content-table row as unavailable and never silently returns a version without readable content.
- Web copy becomes agent-neutral. Rows show Claude/Codex count badges; detail version labels and metadata show the source agent.

## Test matrix

### Pure corpus/parser tests

- Claude modern corpus: plain, plugin-colon, bundled hashed path, multiple skills, repeat invocation, interleaved unrelated tools, CRLF, leading BOM, huge body, string and array text forms. Assert 100% body recovery and byte-identical product content.
- Codex corpus: current complete `cat`/short `sed`/short `head` plus known incomplete/unsupported shapes. Parser-v1 measured recovery is exactly 3/5 (60%); all 5/5 invocations remain visible, with the other two represented as unavailable.
- Adversarial: malformed/truncated JSON envelopes, failed/non-zero calls, chained/piped/multi-file commands, reads reaching the requested line limit, unknown envelopes, duplicate/ambiguous `call_id`, missing output, mismatched Claude base directory, meta body without a prior invocation, and pasted invocation JSON.

### Persistence/service tests

- Typed row construction, content hash stability, per-user content deduplication, receipt matching, repeated invocation deduplication, no-body unavailable rows, raw-revision ordering, parser-version replacement, deterministic same-revision/parser sequences, join-before-collapse active-row SQL, and absence of extraction-diff tombstones.
- Read service: workspace filter is mandatory; both agents aggregate; exact names remain case-sensitive; missing version content increases `unavailableSessionCount`; no raw table or raw `content` reference exists in the persistent service.

### Real infrastructure/API integration

- Start the real API test server and authenticated user, upload a Claude transcript through `/rpc/ingestSession`, then call real `analytics.skills.list` and `detail`; assert ClickHouse use/content rows exist and detail body is byte-identical.
- Upload a Codex transcript and assert merged summary/per-agent counts and source-labeled readable detail.
- Force-reupload changed content/removed skills; active counts remain correct because prior-run uses no longer match the winning receipt.
- Preview and execute backfill, rerun it, and assert physical row counts do not change for matching receipts.
- Override parser version in the integration harness, rerun backfill, and assert logical counts stay fixed while latest parser version advances.
- Fully commit S1, append S2 content/uses without its receipt, and assert S1 remains active both before and after a one-time `OPTIMIZE TABLE rudel.skill_uses FINAL`.
- Retry a failed attempt through a fresh `createSkillExtractionRun`, assert the sequence matches the failed attempt, commit it, and assert it becomes active.
- In a shared organization whose ID differs from both user IDs, delete one account's receipt/use/content rows and assert the other user's same-hash content survives. Ownership cleanup similarly removes bodies owned only by non-canonical users while retaining canonically referenced bodies.
- Add the suite to `apps/api` `test:integration`; use real Postgres/ClickHouse only, with no mocks or hidden skips.

### Web and verification

- Update list/detail component tests for neutral copy, per-agent badges, agent-labeled version selector, unavailable-only content, loading/error/empty/search states.
- Run focused parser/service/web tests, schema migration tests, local integration suite, `bun run verify`, and inspect `git diff origin/main...` plus `git status` to confirm unrelated dashboard/e2e changes were untouched.
- Wrapped layout files are out of scope, so `bun run lint:wrapped:hig` is not required unless an unexpected wrapped file changes.

## Phase checklist

- [x] Phase 1: schema definitions, chkit migration, generated types, ClickHouse allowlist.
- [x] Phase 2: Claude/Codex corpus parsers and recovery-rate assertions.
- [x] Phase 3: worker result + ingest-time persistence, exact-run receipts, kill switch.
- [x] Phase 4: preview/execute backfill, env/docs/scripts, idempotency/re-extraction integration.
- [x] Phase 5: persistent read service, temporary cutover adapter, contract.
- [x] Phase 6: neutral/source-labeled web UI and tests.
- [x] Phase 7: verification attempted and plan reconciled; see the environment-owned exceptions below.
- [x] Round 2: extraction sequence, receipt/use split, batch backfill writes, bounded/capped detail reads, regenerated schema artifacts.
- [x] Round 3: raw-revision ordering, exact receipt binding, tombstone removal, buffered writes, read scan caps, millisecond-precise version cap, and available local verification.
- [x] Round 4: deterministic `UInt64` sequences, append-only use generations, join-first commit selection, user-erasable content, byte-capped buffers, prefix-aligned reconciliation, complete read guardrails, regenerated artifacts, and final local verification.
- [x] Closeout: full-key content-dedup lookups with strict caps, compact `skill_uses` sparse primary index, and the accepted limitation/fence/follow-up notes.

## Verification results

- The single closeout `bun run ch:generate` / `bun run ch:codegen` pass created `20260820154645_auto.sql`. Its four operations are all classified safe; `skill_uses` has a five-column sparse `PRIMARY KEY` and a six-column `ORDER BY` ending in `extraction_seq`. Receipts use `(organization_id, agent, user_id, session_id)`, and contents include/key `user_id`. The subsequent dry run reports zero operations. Nothing was applied to production.
- Focused API skill suites pass: 28 tests, 0 failures. The ClickHouse persistence schema suite passes: 2 tests, 0 failures, and the schema package type-check passes. The target skills UI suite passes: 7 tests, 0 failures. Related org/session unit suites pass: 11 tests, 0 failures. Scoped Biome and `git diff --check` pass.
- The real integration suite includes the exact S1/orphan-S2 check before and after `OPTIMIZE FINAL`, a fresh-run deterministic retry, newer-revision/parser ordering, concurrent backfill/live ingestion, buffered failure isolation, and shared-organization content purge/retention and ownership cleanup. Local execution cannot cross the infrastructure gate: `CLICKHOUSE_URL` and `PG_CONNECTION_STRING` are absent and localhost ClickHouse refuses connections. CI/review must supply that hard gate.
- The API package type-check has no skill-persistence errors. It remains red only on three pre-existing session-analytics errors: missing `mapSessionAnalyticsRow` export and conflicting `total_interactions` types.

## Deferred follow-up

- List-endpoint pagination remains deliberately out of scope. More than 10,000 distinct skill names currently raises through `max_result_rows`; that bounded failure is acceptable near-term.
- Detail-version pagination and lazy per-version content remain deferred from round two. The current detail contract returns the newest 100 versions and fetches bodies only for those hashes; a future contract change should add explicit pagination before increasing that cap.
- Append-only use generations are intentionally retained for correctness. Add a periodic, bounded GC that removes `skill_uses` rows with sequences older than the committed receipt only after measuring generation growth and designing safe mutation batching. Do not put this GC on the ingest or read path.

## Open decisions

All requested design decisions are resolved above. Production migration, backfill execution, canary IDs, and the final `all` flip remain explicit Evren-owned operational actions and are not performed by this task.
