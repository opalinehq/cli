# Data handling

[← Back to the README](../README.md)

## Session uploads

Opaline uploads **full coding-agent session transcripts and related metadata** to the destination workspace. Transcripts may contain prompts, model responses, source code, tool output, file contents, command output, URLs, repository metadata, and sub-agent transcripts.

Enable uploads only for projects and environments where that data may be sent to the hosted service. Keep secrets out of agent sessions and review your organization's data policies before enabling uploads.

Choose repositories in the CLI, review your selection, and confirm. Automatic uploads are enabled for the selected repositories. Turning a repository OFF stops future uploads; it does not delete sessions already uploaded, and hooks already uploading may finish.

## Known-secret filtering

Before upload, the CLI applies deterministic filtering for known secret patterns to both the main transcript and sub-agent transcripts.

**Filtering is best-effort and cannot guarantee that every sensitive value is removed.** Custom credentials, split or encoded secrets, unusual formats, screenshots, and other sensitive values may not match.

Safety limits stop an upload when filtering cannot preserve transcript integrity, cannot converge, or redacts an unexpectedly large portion of the payload. They cannot prove that the remaining transcript is free of secrets. Treat filtering as an additional safeguard, not a substitute for keeping sensitive data out of sessions.

## Upload transport

When the authenticated server advertises direct R2 ingest support, the CLI stages filtered transcript objects in private temporary files and sends them as bounded multipart uploads.

Servers without that capability continue to receive the filtered legacy ingest request. Large file-backed requests fail locally rather than being materialized without a safe bound.

The CLI defaults to `https://opaline.so`. Insecure login and upload overrides are documented in the [configuration reference](usage.md#configuration); they transmit credentials or transcripts without transport encryption.

## Repository context evidence

Automatic-upload hooks also capture repository context: Git state and safe patches, instruction and skill files, package configuration, and a filtered transcript revision. Credential-like paths (including `.env.example`, `.env.sample`, and `.env.template`) and the CLI's configuration directory are excluded from both filesystem content and Git patches.

Evidence objects are limited to 64 MiB, with at most 128 MiB per delivery and reserved manifest headroom. Large transcript tails are retained privately in the CLI configuration directory and continue through `opaline upload --retry`, including after a terminal hook or a CLI restart. Pending captures and continuation sources have bounded disk quotas; accepted or abandoned repository-spool captures can be retired under quota pressure, but unsent captures are preserved.

Hook evidence capture uses a shared 20-second capture-and-delivery budget. Transcript filtering is streamed, with a 32 MiB aggregate input and filtered-materialization limit and at most 256 streams; exceeding these limits or the aggregate secret-redaction safety budget skips the sidecar without disabling the independent transcript uploader. Directory enumeration is incremental and bounded by the remaining entry budget. Content is limited to repository `CLAUDE.md`/`AGENTS.md` instructions (including nested and local variants), `SKILL.md` definitions, and agent/MCP configuration files. Skill resources and other documents carry path, size, source SHA-256 and Git provenance, not content; credential-path exclusions and hashing limits still apply. Each context capture materializes at most 256 blobs and 2 MiB, prioritizing repository instructions, transcript-observed skill definitions, other definitions, then configuration. Sanitized Git patches use remaining capacity after those files. The local manifest retains at most 2,000 entries and 256 KiB, rebuilding its document/skill indexes from retained entries; metadata is deterministically interleaved across roots after content priorities. Capture limits are reported as partial coverage with omitted blob/entry counts. Automatic retries recheck the queued capture's repository and source against current OFF settings; older captures without a repository-selection identity are not automatically retried when repository settings are managed.

Pending evidence created with a different known-secret filter version is quarantined with a warning rather than uploaded. Recollect the session with the current CLI to apply the current filter. Repository-context delivery is separate from the full session upload; an evidence-storage outage does not prevent that session upload.

## Usage analytics

Usage analytics are separate from session uploads. Official releases include PostHog capture configuration for a limited set of events:

| Event | Included information |
| --- | --- |
| First run | CLI version, operating system, and command name. |
| Login attempt and result | CLI version, operating system, and authentication outcome. |
| Automatic-upload setup result | CLI version, operating system, setup outcome, selected repository count, total local session count, and an anonymous list of session counts per repository, grouped by agent and destination workspace. |

An anonymous local identifier links activity to your Opaline account after login. These usage events **exclude command arguments, connection codes, repository names, local paths, and session contents**.

Setup counts describe the selected local sessions, including previously uploaded ones; they do not measure successful uploads. Duplicate discoveries within a repository count once. Counts are snapshots, not values to sum across repeated setup events or agents sharing a repository. The upload picker measures selected repositories even when opened through the legacy `enable` or `disable` names.

`doctor` and hook invocations do not emit first-run events. Analytics failures do not prevent CLI commands from running. Source builds are unconfigured by default unless explicitly supplied with PostHog configuration.

### Opt out

Set either `DO_NOT_TRACK=1` or `POSTHOG_ENABLED=false` in the CLI's environment. For a single invocation in a POSIX shell:

```bash
DO_NOT_TRACK=1 npx opaline@latest
```

For future commands, export the variable in your shell configuration:

```bash
export DO_NOT_TRACK=1
```

Restart your terminal or reload that configuration. To apply the opt-out to automatic hooks too, ensure Claude Code and Codex inherit the variable when they start; a prefix on one setup command does not set it for future agent processes. In PowerShell, use `$env:DO_NOT_TRACK = "1"` for the current session and configure a persistent environment variable for future sessions.

This disables CLI usage analytics. It does not disable the transcript uploads you enable through repository selection.

## Report a security issue

Use the private reporting process in [SECURITY.md](../SECURITY.md). Do not post credentials, private transcripts, or security vulnerabilities in a public issue.
