# CLI guide

[← Back to the README](../README.md)

## Run without installing

Requires Node.js 20 or newer.

```bash
npx opaline@latest
```

Run from any directory, including your home folder. The CLI finds saved Claude Code and Codex sessions across repositories, lets you choose what to upload, and sets up automatic uploads for those selections. `pnpx opaline@latest` works too.

Browser login opens after you review and confirm your selection, when authentication is needed. Choose a destination if you belong to multiple workspaces. Existing repository destinations are retained.

Automatic uploads retain the bundled CLI under `~/.rudel/runtime` and use your Node executable, so hooks keep working after the temporary runner cache is gone. You do not need a global install for automatic uploads.

## Start from the browser

If you start setup in Opaline, copy and run the command supplied by that page:

```bash
npx opaline@latest --code <one-time-code>
```

The code pairs the terminal with your browser for live selection and upload status. It expires after ten minutes if unused. Approve login in the same browser where you copied the command; uploads go to the workspace approved there.

After upload, new users continue setup at `/welcome`. Returning users open their destination workspace's Sessions page at `/{workspace}/sessions`, using its actual slug. A paired setup link keeps the connection so the browser can resume the flow.

## Choose and manage repositories

The picker fills during scanning, then shows local and already-uploaded session counts alongside ON/OFF toggles. Worktrees are grouped by repository.

| Control | Action |
| --- | --- |
| ↑ / ↓ | Move through the list. |
| Space | Toggle the selected repository. |
| Type | Filter repositories by name. |
| Ctrl+U | Clear the filter. |
| Enter | Review your selection, then confirm it. |
| Esc | Return from review, or leave the picker without saving. |

The review groups repositories into newly added, already active, and deactivated. Upload progress stays in the same table. Sessions already uploaded to the destination are skipped.

Run `npx opaline@latest` again to change your selections. Turning a repository OFF stops future automatic uploads and keeps sessions already in Opaline. Hooks already uploading may finish.

### Agent hooks

Opaline installs the required Claude Code and/or Codex hooks. Claude Code's hook is installed in your user settings, so setup does not depend on your current directory. Hooks run headlessly, check the repository allowlist, filter known secret patterns, and upload sessions. Existing unrelated hooks and settings are preserved.

Codex notification tools can coexist with automatic uploads. Opaline retains the existing command and arguments, forwards the notification JSON, and uploads independently. Codex Computer Use stays at the front of its notification chain. Turning uploads OFF keeps notifications working.

Custom scripts are preserved; Opaline does not rewrite scripts that invoke older Rudel installations themselves. Setup failures show the complete error and a retry/back action, including the settings file to fix when a Codex configuration is invalid.

## Optional global install

```bash
npm install --global opaline
opaline
```

After installation, you can replace `npx opaline@latest` with `opaline` in the examples below. To update a global installation, run the install command again.

If you already installed `@opalinehq/cli` globally, run `npm uninstall --global @opalinehq/cli` before installing `opaline`: both packages provide the same executable. Your existing credentials and settings are retained.

## Command reference

| Command | Description |
| --- | --- |
| `npx opaline@latest` | Open the repository picker. |
| `npx opaline@latest upload` | Manage automatic uploads and upload selected repositories. |
| `npx opaline@latest --code <code>` | Pair with the browser that supplied the command. |
| `npx opaline@latest login` | Sign in through the browser. |
| `npx opaline@latest logout` | Revoke the current credential and log out locally. |
| `npx opaline@latest whoami` | Show the authenticated user and local upload failures. |
| `npx opaline@latest doctor` | Run read-only authentication, API, configuration, version, and hook diagnostics. |
| `npx opaline@latest --help` | Show command help. |
| `npx opaline@latest --version` | Print the CLI version. |

### Historical imports and existing scripts

```bash
npx opaline@latest import ./path/to/session.jsonl
npx opaline@latest upload --retry
```

Use `npx opaline@latest import --help` for historical import options. The legacy `upload <session>` form remains supported. File/retry flags require a session argument or `--retry`; normal repository selection uses the picker.

`enable` and `disable` are aliases for the repository picker. Open it and confirm your selections to change automatic uploads. `set-org` remains available to change the workspace associated with a project.

## Configuration

The production API defaults to `https://opaline.so`.

| Variable | Purpose |
| --- | --- |
| `OPALINE_LOG_LEVEL=debug` | Print verbose, token-safe diagnostics to stderr. |
| `OPALINE_API_BASE` | Override the API base; `RUDEL_API_BASE` is also accepted. |
| `OPALINE_CONFIG_DIR` | Override local state; `RUDEL_CONFIG_DIR` is also accepted. |
| `OPALINE_ALLOW_INSECURE_API_BASE=1` | Permit plaintext non-loopback login/authentication traffic. |
| `OPALINE_ALLOW_INSECURE_ENDPOINT=1` | Permit plaintext non-loopback transcript uploads. |
| `DO_NOT_TRACK=1` or `POSTHOG_ENABLED=false` | Disable CLI usage analytics. |

The insecure overrides transmit credentials or transcripts without transport encryption. Use them only for a trusted self-hosted network. Login and transcript-upload overrides are separate.

See [data handling](data-handling.md#usage-analytics) for analytics details, including how to keep the opt-out active for future commands and hooks.

## Troubleshooting

Start with:

```bash
OPALINE_LOG_LEVEL=debug npx opaline@latest doctor
```

| Problem | What to try |
| --- | --- |
| Not authenticated | Run `npx opaline@latest login`. Existing credentials should be found automatically under `~/.rudel/credentials.json`. |
| API unreachable | Check that `https://opaline.so/health` is reachable and inspect any `OPALINE_API_BASE` or `RUDEL_API_BASE` override. |
| Hooks disabled | Run `npx opaline@latest` and enable the repositories you want to sync. |
| Queued upload failures | Run `npx opaline@latest upload --retry`. Permanent failures remain visible in `whoami`. |
| Invalid Codex configuration | Follow the file path and error shown by the CLI, fix the setting, then retry. |
| Rudel rename notice in a script | The alias keeps stdout unchanged and writes its notice only to stderr. |

Still stuck? [Open an issue](https://github.com/opalinehq/cli/issues). Do not include credentials or private session contents.

## Moving from Rudel

Existing Rudel users do not need to log in again. Credentials, retry queues, logs, and project mappings remain in `~/.rudel` for compatibility. Set `OPALINE_CONFIG_DIR` to use another directory.

Existing Rudel hooks are recognized as enabled. Saving repository selections migrates owned hooks to Opaline, removes duplicate local hooks, and preserves unrelated agent settings.

`opaline` is the recommended package name. It runs the `@opalinehq/cli` implementation pinned to the matching release. Both `@opalinehq/cli` and the `rudel` compatibility package remain supported.

The `rudel` executable delegates to the same implementation with unchanged arguments, stdin, stdout, and exit status. It adds one rename notice to stderr per invocation.
