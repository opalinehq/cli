# rudel

Compatibility alias for the [Opaline CLI](https://www.npmjs.com/package/opaline).

Existing `rudel` commands, hooks, cron jobs, arguments, standard input/output,
and exit codes continue through the Opaline CLI. The alias prints
`rudel is now opaline` once to stderr per invocation, then delegates to the
canonical CLI without changing stdout. New installations should use:

```bash
npm install --global opaline
```

Existing users can keep installing and updating `rudel`. It is released alongside
`opaline` at the same version.
Both `rudel` and `opaline` keep using the same `~/.rudel` state directory.
Automatic uploads use a retained CLI bundle under `~/.rudel/runtime` with
your Node executable, so no separate global `opaline` installation is required.

See the [migration guide](https://github.com/opalinehq/cli/blob/main/docs/usage.md#moving-from-rudel)
for details. Opaline uploads full session transcripts; known-secret filtering
is best-effort. Read the [data-handling disclosure](https://github.com/opalinehq/cli/blob/main/docs/data-handling.md)
for transcript contents, usage analytics, and opt-out settings.

## License

Copyright (c) 2026 Opaline Labs, Inc. Licensed under [MIT](LICENSE).
