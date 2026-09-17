# Opaline CLI

**Your Claude Code and Codex sessions, in one place.**

This package, `@opalinehq/cli`, contains the shared CLI implementation. For new installations, use [`opaline`](https://www.npmjs.com/package/opaline), which runs the same implementation at the matching version.

## Get started

Requires Node.js 20 or newer. Run from any directory:

```bash
npx opaline@latest
```

Choose repositories with ↑↓ and Space. Press Enter to review, then Enter to confirm. Sign in through your browser when prompted. Existing sessions upload to Opaline, and future sessions sync automatically for enabled repositories.

After upload, new users finish setup in the browser; returning users open their workspace's Sessions page. If you start setup in your browser, use the command it supplies, including its `--code` value.

Run the command again to change which repositories sync. Existing Rudel credentials and settings remain in `~/.rudel`.

## Data and privacy

Opaline uploads full session transcripts, which can include prompts, responses, source code, tool output, and metadata. Known-secret filtering is best-effort and cannot guarantee every sensitive value is removed.

Official releases also send limited usage analytics, including repository/session counts, linked to your account after sign-in. Those events exclude transcript content, repository names, and local paths. Set `DO_NOT_TRACK=1` or `POSTHOG_ENABLED=false` in the CLI's environment to opt out of usage analytics.

## Learn more

- [CLI guide](https://github.com/opalinehq/cli/blob/main/docs/usage.md) — commands, installation, configuration, troubleshooting, and migration from Rudel.
- [Data handling](https://github.com/opalinehq/cli/blob/main/docs/data-handling.md) — full transcript and analytics disclosure, including persistent opt-out.
- [Contributing](https://github.com/opalinehq/cli/blob/main/CONTRIBUTING.md) — local development and the CLI playground.

## License

[MIT](LICENSE)
