# Opaline CLI

Capture Claude Code and OpenAI Codex sessions and upload them to Opaline for
team analytics. Requires Node.js 20 or newer.

```bash
npm install --global opaline
opaline login
opaline upload
opaline doctor
```

`opaline` is the recommended install name. It runs the same CLI implementation
as `@opalinehq/cli`, pinned to the matching release. Both `@opalinehq/cli` and
the `rudel` compatibility package remain supported.

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

Copyright (c) 2025 Opaline Labs, Inc. Licensed under [MIT](LICENSE).
