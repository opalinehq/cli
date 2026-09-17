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
