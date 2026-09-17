# Opaline CLI

**Your Claude Code and Codex sessions, in one place.**

Connect your coding sessions to [Opaline](https://opaline.so) for team analytics. Choose your repositories, upload existing sessions, and keep future sessions syncing automatically.

## Get started

Requires Node.js 20 or newer. Run from any directory; no global installation needed.

```bash
npx opaline@latest
```

1. Choose repositories with ↑↓ and Space.
2. Press Enter to review, then Enter to confirm. Sign in through your browser when prompted.
3. Continue in Opaline after upload. New users finish setup; returning users open their workspace's Sessions page.

Run the command again to change which repositories sync. If you start setup in your browser, use the command it supplies, including the `--code` value.

## Data and privacy

Opaline uploads full session transcripts, which can include prompts, responses, source code, tool output, and metadata. Known-secret filtering is best-effort and cannot guarantee every sensitive value is removed.

Official releases also send limited usage analytics, including repository/session counts, linked to your account after sign-in. Those events exclude transcript content, repository names, and local paths. Set `DO_NOT_TRACK=1` or `POSTHOG_ENABLED=false` in the CLI's environment to opt out of usage analytics.

## Learn more

- [CLI guide](https://github.com/opalinehq/cli/blob/main/docs/usage.md) — commands, global installation, configuration, troubleshooting, and migration from Rudel.
- [Data handling](https://github.com/opalinehq/cli/blob/main/docs/data-handling.md) — full disclosure and persistent analytics opt-out.
- [GitHub](https://github.com/opalinehq/cli) — source code and contributions.

`opaline` is the recommended installation name. It uses the `@opalinehq/cli` implementation at the same version. Existing credentials and settings remain in `~/.rudel`.

## License

Copyright (c) 2026 Opaline Labs, Inc. Licensed under [MIT](LICENSE).
