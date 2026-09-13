# Opaline CLI

Capture Claude Code and OpenAI Codex sessions and upload them to Opaline for
team analytics. The production API is at
[`https://opaline.so`](https://opaline.so).

## Quick start

Requires Node.js 20 or newer.

```bash
npx @opalinehq/cli@latest
```

Run this from any directory. The CLI scans local Claude Code and Codex sessions,
shows repository and session counts, and lets you choose which repos to upload
and keep syncing. Login opens only after selection. `pnpx @opalinehq/cli@latest`
works too. A global install remains optional.

Copying the command from the Opaline demo adds a hidden `--code` value. That
one-time code pairs the terminal with your browser for live selection and upload
status. It expires after ten minutes if unused. Approve login in the same browser
where you copied the command; finishing setup opens your own Sessions page.

Automatic uploads retain the bundled CLI under `~/.rudel/runtime` and use your
Node executable, so hooks keep working after the temporary runner cache is gone.

`opaline login` opens a browser-based device flow. `opaline upload` groups local
worktrees by repository, lets you choose which repositories stay synchronized,
installs the required Claude Code and/or Codex hooks, and uploads new sessions.
`opaline enable` remains a shortcut for enabling the current repository.

Existing `rudel` users do not need to log in again. Opaline intentionally reads
the existing `~/.rudel` credential and state directory, and the `rudel` package
continues as a compatibility alias.

Run `opaline upload` from any directory, including your home folder. The picker
finds saved sessions across repositories and uploads the repositories you select.
It also enables automatic uploads for those selections. Claude Code's hook is
installed in your user settings, so setup does not depend on your current
directory. Existing hooks and settings are preserved.

## Typical workflow

```bash
# Check the installation and service connection
opaline doctor

# See the authenticated account
opaline whoami

# Upload existing sessions interactively
opaline upload

# Retry transient hook/upload failures
opaline upload --retry

# Stop automatic uploads
opaline disable
```

## Key concepts

- **Sessions:** Claude Code and Codex JSONL transcripts discovered on the local
  machine.
- **Hooks:** Agent lifecycle commands installed by `opaline upload` or
  `opaline enable`. Hooks run headlessly, consult the repository allowlist,
  filter known secret patterns, and upload the completed session.
- **Organizations:** The Opaline workspace receiving uploads. Use
  `opaline set-org` to change the organization associated with a project.
- **Local state:** Credentials, retry queues, logs, and project mappings remain
  in `~/.rudel` for compatibility. Set `OPALINE_CONFIG_DIR` to opt into another
  directory; `RUDEL_CONFIG_DIR` remains supported.
- **Compatibility alias:** The `rudel` executable delegates to the same Opaline
  implementation with unchanged arguments, standard input/output, and exit
  status. Its only addition is one rename notice on stderr per invocation.

## Commands

| Command | Description |
| --- | --- |
| `opaline` / `opaline connect` | Scan, select repositories, then log in and upload. |
| `opaline --code <code>` | Connect to the demo that supplied the copied command. |
| `opaline login` | Authenticate through the browser device flow. |
| `opaline logout` | Revoke the current credential and log out locally. |
| `opaline whoami` | Show the authenticated user and local upload failures. |
| `opaline doctor` | Run read-only auth, API latency, config, version, and hook diagnostics. |
| `opaline enable` | Enable automatic upload for the current repository. |
| `opaline disable` | Disable automatic upload and remove Opaline upload hooks. |
| `opaline upload [session]` | Manage synchronized repositories or upload one session. |
| `opaline upload --retry` | Retry locally queued transient upload failures. |
| `opaline set-org` | Set the Opaline organization for the current project. |
| `opaline --help` | Show complete command and flag help. |
| `opaline --version` | Print the installed CLI version. |

## Configuration

The CLI defaults to the current production API at `https://opaline.so`.

| Variable | Purpose |
| --- | --- |
| `OPALINE_LOG_LEVEL=debug` | Print verbose, token-safe diagnostics to stderr for any command. |
| `OPALINE_API_BASE` | Override the API base; legacy `RUDEL_API_BASE` is also accepted. |
| `OPALINE_CONFIG_DIR` | Override local state; legacy `RUDEL_CONFIG_DIR` is also accepted. |
| `OPALINE_ALLOW_INSECURE_API_BASE=1` | Permit plaintext non-loopback login/auth traffic. |
| `OPALINE_ALLOW_INSECURE_ENDPOINT=1` | Permit plaintext non-loopback transcript uploads. |
| `DO_NOT_TRACK=1` or `POSTHOG_ENABLED=false` | Disable CLI product analytics. |

The insecure overrides transmit credentials or transcripts without transport
encryption. Use them only for a trusted self-hosted network.

## Troubleshooting

Start with:

```bash
OPALINE_LOG_LEVEL=debug opaline doctor
```

- **Not authenticated:** run `opaline login`. Existing credentials should be
  found automatically under `~/.rudel/credentials.json`.
- **API unreachable:** confirm that `https://opaline.so/health` is reachable
  and check `OPALINE_API_BASE`/`RUDEL_API_BASE` overrides.
- **Hooks disabled:** run `opaline upload` and select the repositories to enable.
  Existing `rudel` hook commands are recognized and upgraded when the
  hook is installed again.
- **Queued upload failures:** run `opaline upload --retry`. Permanent failures
  remain visible in `opaline whoami`.
- **Machine-readable scripts changed after installing `rudel`:** the alias
  keeps command stdout unchanged; its rename notice is written only to stderr.

## Security and data handling

Opaline uploads full coding-agent session transcripts and related metadata.
Transcripts may contain prompts, model responses, source code, tool output,
file contents, command output, URLs, repository metadata, and sub-agent
transcripts. Enable uploads only for projects and environments where that data
may be sent to the hosted service.

Before upload, the CLI applies deterministic filtering for known secret
patterns to the main transcript and sub-agent transcripts. Secret filtering is
best-effort, not a guarantee: custom credentials, split or encoded secrets,
unusual formats, screenshots, and other sensitive values may not match. Safety
limits stop an upload when filtering cannot preserve transcript integrity,
cannot converge, or redacts an unexpectedly large portion of the payload, but
they cannot prove that the remaining transcript is free of secrets.

When the authenticated server advertises direct R2 ingest support, the CLI
stages filtered transcript objects in private temporary files and sends them as
bounded multipart uploads. Servers without that capability continue to receive
the filtered legacy ingest request; large file-backed requests fail locally
rather than being materialized without a safe bound.

Keep secrets out of agent sessions, review your organization's data policies,
and treat filtering as defense in depth. Report security issues through the
private process in [SECURITY.md](SECURITY.md).

Official CLI releases include PostHog capture configuration for a small set of
usage events: first run, login attempts and results, and automatic-upload setup
results. Events include CLI version and operating system; first run also includes
the command name. Anonymous activity is linked to your account after login.
These events exclude command arguments, connection codes, repository names,
local paths, and session contents. Set `DO_NOT_TRACK=1` or
`POSTHOG_ENABLED=false` to opt out. Source builds are unconfigured by default.

## Development

```bash
bun install
bun run verify
bun run --cwd apps/cli dev --help
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the contribution workflow.

## License

[MIT](LICENSE)
