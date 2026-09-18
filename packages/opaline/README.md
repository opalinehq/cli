# Opaline CLI

Capture Claude Code and OpenAI Codex sessions and upload them to Opaline for
team analytics. Requires Node.js 20 or newer.

```bash
npx opaline@latest
```

Run from any directory, choose repositories, and review the upload before browser login. Opaline uploads the selected Claude Code and Codex sessions and sets up automatic uploads for those repositories.

`opaline` is the recommended install name. It runs the same CLI implementation
as `@opalinehq/cli`, pinned to the matching release. Both `@opalinehq/cli` and
the `rudel` compatibility package remain supported.

Interactive calls offer one **Update / Skip** prompt with a link to the exact
open-source GitHub release. Accepting updates supported existing global installs
and automatic-upload runtimes without changing repository selections. Run
`npx opaline@latest update` to check explicitly. Updates pin the reviewed version
and respect your package-manager safeguards; unsupported or blocked installations
receive instructions. A global installation is never added for npx-only users.

When switching from a global `@opalinehq/cli` install, run
`npm uninstall --global @opalinehq/cli` first: both packages provide the
`opaline` command. Existing credentials, settings, and upload state remain in
`~/.rudel`; no new login is required. Run `opaline upload` to set up hooks
using the `opaline` command when migrating from `rudel`.

For commands, configuration, troubleshooting, and the full security/data
handling disclosure, see the
[repository README](https://github.com/opalinehq/cli#readme).

Session transcripts are uploaded. Known-pattern secret filtering is best-effort
and cannot guarantee that every sensitive value is removed.

## License

Copyright (c) 2026 Opaline Labs, Inc. Licensed under [MIT](LICENSE).
