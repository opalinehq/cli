# `@opalinehq/cli`

The canonical Opaline CLI package for Claude Code and OpenAI Codex session
analytics.

```bash
npx @opalinehq/cli@latest
npx @opalinehq/cli@latest doctor
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

`opaline upload` groups discovered worktrees by repository, saves the selected
repositories for automatic upload, and sends only sessions the server does not
already have. `opaline enable` remains available to enable the current
repository directly.

The CLI keeps using the existing `~/.rudel` state directory so upgrades do not
require another login. Its production API is `https://opaline.so`.

For commands, configuration, troubleshooting, and the full security/data
handling disclosure, see the
[repository README](https://github.com/opalinehq/cli#readme).

Important: session transcripts are uploaded. Known-pattern secret filtering is
best-effort and cannot guarantee that every sensitive value is removed.
Capable servers use direct multipart object-storage uploads after filtering;
older servers continue to use the legacy ingest endpoint.

Official releases send a small set of usage events to PostHog: first run,
login attempts and results, and automatic-upload setup results. These include
the CLI version and operating system. The first-run event includes the command name.
Setup results include the selected repository count, total local session count,
and an anonymous list of session counts per repository, grouped by agent and
destination workspace. Duplicate discoveries within a repository count once.
These describe the selected local sessions, including previously uploaded ones,
and do not measure successful uploads. `enable` measures the current repository;
the `upload` picker measures the selected repositories. Counts are snapshots,
not values to sum across repeated setup events or agents sharing a repository.
An anonymous local identifier links activity to your Opaline account after login.
Command arguments, connection codes, repository names, local paths, and session
contents are not included in these product analytics events. `doctor` and hook
invocations do not emit first-run events.

Set `DO_NOT_TRACK=1` or `POSTHOG_ENABLED=false` to disable product analytics.
Analytics failures do not prevent CLI commands from running. Source builds are
unconfigured unless explicitly supplied with PostHog configuration.
