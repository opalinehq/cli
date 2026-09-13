# Releasing the Opaline CLI

`opaline` is the recommended public install name. `@opalinehq/cli` contains
the shared implementation. The `opaline` and `rudel` packages provide thin
launchers that depend on the exact matching `@opalinehq/cli` version.

## One-time npm setup

In each package's npm settings (`opaline`, `@opalinehq/cli`, and `rudel`),
configure a GitHub Actions trusted publisher:

| Field | Value |
| --- | --- |
| Organization | `opalinehq` |
| Repository | `cli` |
| Workflow filename | `release.yml` |
| Environment | `npm-publish` |

Allow direct publishing with `npm publish`. npm requires a separate trusted
publisher configuration for each package; granting `evrendom` write access
does not automatically authorize GitHub Actions. The repository field must
match the GitHub repository running the workflow, including any repository
rename. The publish job uses GitHub-hosted Ubuntu and Node 24.

npm support has already created `opaline@0.0.1-security`, so its package
settings exist. Configure its trusted publisher before running the first
release. A normal stable release with the `latest` tag supersedes that holding
package; it does not need to be unpublished.

See [npm's trusted publishing documentation](https://docs.npmjs.com/trusted-publishers/).

## Automated releases

1. Merge a conventional-commit PR to `main` and let CI pass.
2. Release Please creates one `opaline-cli` release PR. Its `extra-files`
   configuration updates both launchers' versions and exact dependency pins.
   The workflow refreshes `bun.lock` on that release PR so frozen installs
   continue to work. Review all three package manifests and the lockfile.
   The new launcher's starting version is a source baseline, not an assertion
   that `opaline@0.5.3` has already been published.
3. Merge the release PR. Release Please creates the GitHub release and the
   `opaline-cli@<version>` tag. There are no separate `rudel@*` or `opaline@*`
   Git tags: the existing repository tag rules remain compatible with this flow.
4. The publish job checks out the `opaline-cli@<version>` release commit,
   verifies that it is reachable from `main`, and validates matching package
   versions and dependency pins.
5. It runs `bun run verify`, publishes `@opalinehq/cli` with provenance, waits
   for registry availability, then publishes `opaline` and `rudel` with the
   same version and the `latest` tag.

All three install names remain supported. Do not deprecate or unpublish the
compatibility packages as part of this migration.

Release Please tracks changes under `apps/cli`. A launcher-only change should
include an update to the CLI's installation documentation under `apps/cli`
in the same conventional-commit PR so it triggers a shared release.

## Retrying a partial release

Run the **Release** workflow with `release_tag` set to the existing
`opaline-cli@<version>` tag. Successfully published versions are skipped;
missing packages are published from the same released commit. Fix package
ownership or trusted publishing settings before retrying an authorization
failure. Do not change package contents and reuse an already published version.

## Verification after publishing

```bash
npm view opaline version dependencies
npm view @opalinehq/cli version
npm view rudel version dependencies
npx --yes opaline@latest --version
npx --yes @opalinehq/cli@latest --version
npx --yes rudel@latest --version
```

The three commands should report the same CLI version. `rudel` also emits
its existing rename notice to stderr. Migration instructions for existing
global installations are in [README.md](README.md#install-names-and-upgrades).
