# `@opalinehq/cli`

The shared Opaline CLI implementation for Claude Code and OpenAI Codex session
analytics. The recommended install name is `opaline`:

```bash
npm install --global opaline
opaline login
opaline upload
opaline doctor
```

`npm install --global @opalinehq/cli` remains supported and provides the same
`opaline` command. Choose one of these global installations. When switching
to `opaline`, uninstall `@opalinehq/cli` first. Credentials and existing hooks
continue to work.

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

## License

Copyright (c) 2025 Opaline Labs, Inc. Licensed under [MIT](LICENSE).
