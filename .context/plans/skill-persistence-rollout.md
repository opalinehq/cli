# Skill persistence rollout runbook

> **Historical monorepo runbook.** The paths, branches, and deployment commands below refer to the former combined repository. Do not use this document to operate the public CLI or its releases. See [Releasing](../../RELEASING.md) for the current CLI release process.

Owner: Evren. Execute in order from branch `feat/skill-persistence-backend`. Stop on any failed verification. Production reads use `prd_readonly`; `prd` is reserved for the migration and backfill writes. This PR is backend-only; the skills web UI intentionally ships later from `opaline/main`.

## 1. CI integration gate

From the repository root, push the current branch and wait for CI:

```bash
git push -u origin HEAD
gh run list --branch "$(git branch --show-current)" --limit 5
gh run watch
```

Open the integration job and confirm `bun run turbo run test:integration --concurrency=1` is green. It must execute `apps/api/src/__tests__/skill-persistence.integration.ts`; do not merge, migrate, or deploy until that suite has run successfully against CI's real Postgres and ClickHouse services.

Never run integration tests with `prd` or `prd_readonly`. The local integration guard intentionally requires loopback Postgres and ClickHouse. If local infrastructure later becomes available, the only local command is:

```bash
cd apps/api
bun run test:integration
```

## 2. Apply the production migration before merge

The Doppler `rudel/prd` config has the required `CLICKHOUSE_URL`, `CLICKHOUSE_USERNAME`, `CLICKHOUSE_PASSWORD`, and `CLICKHOUSE_DB` names. From `packages/ch-schema`, apply the migration with the write identity:

```bash
cd packages/ch-schema
doppler run -p rudel -c prd -- bun run ch:migrate
```

Expect exactly the four safe operations in `20260820170352_auto.sql`: `CREATE DATABASE IF NOT EXISTS rudel` and creation of `rudel.skill_receipts`, `rudel.skill_uses`, and `rudel.skill_version_contents`. The package script deliberately overrides the connection database to `CLICKHOUSE_DB=default` so chkit can create/check `rudel`.

Verify only through the read-only identity:

```bash
doppler run -p rudel -c prd_readonly -- bun run chcli -- -q "SHOW TABLES FROM rudel LIKE 'skill%'" -F json
```

Expected: exactly three tables named `skill_receipts`, `skill_uses`, and `skill_version_contents`. Stop if the migration reports anything other than four safe operations or the table list differs.

## 3. Merge and verify ingest-time extraction

Merge only after steps 1 and 2 pass. Main auto-deploys the API. With no environment override, `SKILL_EXTRACTION_ENABLED` defaults to `true`, while `SKILL_ANALYTICS_CUTOVER_MODE` defaults to `off`; new uploads write the three derived tables but the product continues reading the legacy implementation.

Upload one known Claude or Codex transcript containing a known skill:

```bash
rudel upload /absolute/path/to/session.jsonl
```

Record its organization, user, session, agent (`claude` or `codex`), and exact case-sensitive skill name:

```bash
export SKILL_ORG_ID='replace-with-organization-id'
export SKILL_USER_ID='replace-with-user-id'
export SKILL_SESSION_ID='replace-with-session-id'
export SKILL_AGENT='claude'
export SKILL_NAME='replace-with-exact-skill-name'
```

From `packages/ch-schema`, verify the completed receipt. The settings make an accidental broad scan fail closed:

```bash
doppler run -p rudel -c prd_readonly -- bun run chcli -- -q "SELECT organization_id, agent, user_id, session_id, source_content_sha256, parser_version, extraction_seq, extracted_at FROM rudel.skill_receipts WHERE organization_id = '${SKILL_ORG_ID}' AND agent = '${SKILL_AGENT}' AND user_id = '${SKILL_USER_ID}' AND session_id = '${SKILL_SESSION_ID}' ORDER BY extraction_seq DESC LIMIT 10 SETTINGS max_rows_to_read=10000000, max_bytes_to_read=2147483648, max_execution_time=30, max_result_rows=10, result_overflow_mode='throw'" -F json
```

Then verify that the known skill use is bound to the winning receipt's exact sequence, source hash, and parser version:

```bash
doppler run -p rudel -c prd_readonly -- bun run chcli -- -q "WITH latest_receipt AS (SELECT argMax(tuple(source_content_sha256, parser_version, extraction_seq), extraction_seq) AS state FROM rudel.skill_receipts WHERE organization_id = '${SKILL_ORG_ID}' AND agent = '${SKILL_AGENT}' AND user_id = '${SKILL_USER_ID}' AND session_id = '${SKILL_SESSION_ID}') SELECT uses.skill_name, uses.content_sha256, uses.used_at, uses.parser_version, uses.extraction_seq FROM rudel.skill_uses AS uses CROSS JOIN latest_receipt AS receipt WHERE uses.organization_id = '${SKILL_ORG_ID}' AND uses.skill_name = '${SKILL_NAME}' AND uses.agent = '${SKILL_AGENT}' AND uses.user_id = '${SKILL_USER_ID}' AND uses.session_id = '${SKILL_SESSION_ID}' AND uses.source_content_sha256 = tupleElement(receipt.state, 1) AND uses.parser_version = tupleElement(receipt.state, 2) AND uses.extraction_seq = tupleElement(receipt.state, 3) ORDER BY uses.extracted_at DESC LIMIT 10 SETTINGS max_rows_to_read=10000000, max_bytes_to_read=2147483648, max_execution_time=30, max_result_rows=10, result_overflow_mode='throw'" -F json
```

Expected: at least one receipt and the expected skill-use row. If the transcript contains an invocation whose body cannot be recovered, an empty `content_sha256` is expected; otherwise it should contain a SHA-256 value.

## 4. Preview and execute the backfill

Backfill one organization at a time first. From `apps/api`, set explicit conservative bounds. The CLI flags override the documented environment defaults (`10,000` sessions, `512 MiB` per session, `64` rows per raw-read batch, `128 MiB` per raw-read batch):

```bash
cd apps/api
export SKILL_ORG_ID='replace-with-organization-id'
export SKILL_MAX_SESSIONS='10000'
export SKILL_MAX_SESSION_BYTES='536870912'
export SKILL_BATCH_MAX_ROWS='64'
export SKILL_BATCH_MAX_BYTES='134217728'
doppler run -p rudel -c prd -- bun src/scripts/backfill-skills.ts --organization-id "$SKILL_ORG_ID" --max-sessions "$SKILL_MAX_SESSIONS" --max-session-bytes "$SKILL_MAX_SESSION_BYTES" --batch-max-rows "$SKILL_BATCH_MAX_ROWS" --batch-max-bytes "$SKILL_BATCH_MAX_BYTES" | tee /tmp/rudel-skill-backfill-preview.json
export SKILL_CUTOFF="$(jq -er '.cutoff' /tmp/rudel-skill-backfill-preview.json)"
```

Preview performs the bounded census and parse/read checks but does not insert. Review `rawSessionCount`, `candidateCount`, `skippedNoSkillMarkerCount`, `alreadyCompleteCount`, `wouldWriteCount`, `failedCount`, `oversizedCount`, `supersededCount`, and the bounded `issues` sample. A zero exit means no failures/superseded candidates; exit 2 means reconcile those reported candidates before proceeding. The census fails instead of truncating if either candidate or raw-session count exceeds `--max-sessions`.

Execute with the exact preview cutoff; the script refuses `--execute` without it:

```bash
doppler run -p rudel -c prd -- bun src/scripts/backfill-skills.ts --execute --cutoff "$SKILL_CUTOFF" --organization-id "$SKILL_ORG_ID" --max-sessions "$SKILL_MAX_SESSIONS" --max-session-bytes "$SKILL_MAX_SESSION_BYTES" --batch-max-rows "$SKILL_BATCH_MAX_ROWS" --batch-max-bytes "$SKILL_BATCH_MAX_BYTES" | tee /tmp/rudel-skill-backfill-execute.json
```

Expected: `status=completed`, `failedCount=0`, and `supersededCount=0`. Sessions without source-specific skill markers are intentionally counted in `skippedNoSkillMarkerCount` and receive no receipt. Matching source-hash/parser receipts are counted as `alreadyCompleteCount`. Writes are generation-bound and receipt-last, so rerunning the exact command is safe; a rerun should move completed candidates to `alreadyCompleteCount` without changing logical results.

From `packages/ch-schema`, compare the latest raw census, marker candidates, and persisted receipts per agent using the same organization and cutoff. Derived receipts outlive raw-table TTL, so receipt counts may eventually exceed the live raw window; immediately after a clean first backfill, each marker candidate should have a receipt unless the execution reported an issue.

```bash
cd ../../packages/ch-schema
doppler run -p rudel -c prd_readonly -- bun run chcli -- -q "WITH raw AS (SELECT 'claude' AS agent, count() AS raw_session_count, countIf(has_skill_marker = 1) AS marker_candidate_count FROM (SELECT session_id, argMax(toUInt8(position(content, '\"name\":\"Skill\"') > 0), ingested_at) AS has_skill_marker FROM rudel.claude_sessions WHERE organization_id = '${SKILL_ORG_ID}' AND ingested_at <= parseDateTime64BestEffort('${SKILL_CUTOFF}', 3, 'UTC') GROUP BY organization_id, session_id) UNION ALL SELECT 'codex' AS agent, count() AS raw_session_count, countIf(has_skill_marker = 1) AS marker_candidate_count FROM (SELECT session_id, argMax(toUInt8(position(content, 'skills/') > 0 AND position(content, 'SKILL') > 0), ingested_at) AS has_skill_marker FROM rudel.codex_sessions WHERE organization_id = '${SKILL_ORG_ID}' AND ingested_at <= parseDateTime64BestEffort('${SKILL_CUTOFF}', 3, 'UTC') GROUP BY organization_id, session_id)), receipts AS (SELECT agent, count() AS receipt_session_count FROM (SELECT agent, user_id, session_id FROM rudel.skill_receipts WHERE organization_id = '${SKILL_ORG_ID}' GROUP BY organization_id, agent, user_id, session_id) GROUP BY agent) SELECT raw.agent, raw.raw_session_count, raw.marker_candidate_count, ifNull(receipts.receipt_session_count, 0) AS receipt_session_count FROM raw LEFT JOIN receipts USING (agent) ORDER BY agent SETTINGS max_rows_to_read=10000000, max_bytes_to_read=2147483648, max_execution_time=30, max_result_rows=10, result_overflow_mode='throw'" -F json
```

Repeat preview/execute per organization, increasing `--max-sessions` only after reviewing the census and operational budget. Do not run this script with `prd_readonly`, and never run the integration suite under either production config.

## 5. Canary persistent reads

Set the production deployment environment and redeploy:

```text
SKILL_ANALYTICS_CUTOVER_MODE=canary
SKILL_ANALYTICS_CANARY_ORG_IDS=<evren-org-id>
```

Open the canary organization's Historical skills page and verify:

- Claude and Codex skills both appear when present, with plausible per-agent and total session counts.
- Exact skill names remain case-sensitive and plugin-qualified names remain distinct.
- Opening a detail is fast; readable versions show the expected full content and agent label.
- Unavailable-session counts are plausible for invocations whose complete body could not be recovered.
- Search, loading, empty, and error states remain usable.

Keep all database spot checks on `prd_readonly`, using the bounded queries from steps 3 and 4. Return the cutover to `off` immediately if counts/content disagree or latency regresses.

## 6. Flip all reads and create follow-ups

After the canary is stable, set and redeploy:

```text
SKILL_ANALYTICS_CUTOVER_MODE=all
SKILL_ANALYTICS_CANARY_ORG_IDS=
```

Repeat the step-5 page checks in at least one Claude-heavy and one Codex-heavy organization. In the follow-up ledger, create explicit work for:

1. Remove the legacy historical-skills reader and cutover flag after one stable release.
2. Add list-endpoint pagination before raising the 10,000-result bound.
3. Add detail-version pagination and lazy content retrieval before raising the newest-100-version cap.
4. Design and measure bounded garbage collection for obsolete append-only skill-use generations.
5. Add a platform-wide shared session generation spanning Postgres ownership, raw ClickHouse rows, and derived skills to remove the accepted same-millisecond divergent-revision ambiguity.

## 7. Rollback

Read rollback is immediate and does not discard derived data:

```text
SKILL_ANALYTICS_CUTOVER_MODE=off
SKILL_ANALYTICS_CANARY_ORG_IDS=
```

If new writes themselves cause trouble, additionally set and redeploy:

```text
SKILL_EXTRACTION_ENABLED=false
```

After restoring service, diagnose before retrying migration/backfill or reenabling extraction. The three tables are additive and independent of legacy reads; if the feature is permanently abandoned, they can be dropped independently in a separately reviewed migration. Do not drop them as an incident-response shortcut, because doing so is destructive and loses backfill work.
