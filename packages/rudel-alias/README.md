# rudel

Compatibility alias for [`@opalinehq/cli`](https://www.npmjs.com/package/@opalinehq/cli).

Existing `rudel` commands, hooks, cron jobs, arguments, standard input/output,
and exit codes continue through the Opaline CLI. The alias prints
`rudel is now opaline` once to stderr per invocation, then delegates to the
canonical CLI without changing stdout. New installations should use:

```bash
npm install --global opaline
```

Existing users can keep installing and updating `rudel`. It is released with
`opaline` and `@opalinehq/cli` and depends on the exact matching CLI version.
Both `rudel` and `opaline` keep using the same `~/.rudel` state directory.
Running `rudel upload` installs hooks using the `rudel` executable, so no
separate global `opaline` installation is required.

## License

Copyright (c) 2026 Opaline Labs, Inc. Licensed under [MIT](LICENSE).
