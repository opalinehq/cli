# Production Athena indexer fixture

Replicated from Athena `origin/main` at `5f9a6f8c3231ceadcb4232b0a3313373b3eb44d0`:
`apps/api/src/services/repository-evidence-index.service.ts`.

All manifest validation and row-building logic is unchanged. Only the external
type imports, ClickHouse persistence function and generated row return type are
removed so CLI tests can execute the production logic without Athena dependencies.
The init input type comes from the CLI's mirrored contract.

The production indexer does not accept `metadata-only` or `blob-count-cap` access
details. Hash-only files use `truncated / file-content-cap` (a zero content allowance
under the session policy), and exhausted blob counts use `truncated / total-content-cap`.
The precise omission reasons and truncation marker remain in opaque local manifest
content and coverage. `reference-only / git-object` remains reserved for real Git
object references. No Athena deployment is needed.
