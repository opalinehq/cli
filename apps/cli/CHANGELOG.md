# Changelog

## [0.8.0](https://github.com/opalinehq/cli/compare/opaline-cli@0.7.0...opaline-cli@0.8.0) (2026-09-15)


### Features

* manage session uploads in a single repository table ([#481](https://github.com/opalinehq/cli/issues/481)) ([a5b8744](https://github.com/opalinehq/cli/commit/a5b87449535994d36f210f8315cb509794ac0ea3))

## [0.7.0](https://github.com/opalinehq/cli/compare/opaline-cli@0.6.0...opaline-cli@0.7.0) (2026-09-13)


### Features

* launch guided CLI onboarding with live browser progress ([#479](https://github.com/opalinehq/cli/issues/479)) ([24d76fe](https://github.com/opalinehq/cli/commit/24d76fe6aba45b6b67ce3a1f8d3d7d0cd9713142))

## [0.6.0](https://github.com/opalinehq/cli/compare/opaline-cli@0.5.3...opaline-cli@0.6.0) (2026-09-13)


### Features

* make opaline the primary CLI install ([#476](https://github.com/opalinehq/cli/issues/476)) ([dcc93df](https://github.com/opalinehq/cli/commit/dcc93df086f8c10486479fff78a132f27b1a471a))

## 0.5.3

### Bug fixes

- Use `opaline.so` for login and uploads, preserving existing credentials from the old production address.
- Install Claude Code upload hooks in user settings so repository selection works from any directory.
- Resolve and save workspace destinations for selected repositories and their future automatic uploads.
- Probe direct R2 support before rejecting a first oversized session upload.

## 0.5.2

### Bug fixes

- Support positional Codex uploads by resolving Conductor session IDs to canonical rollout metadata and normalize repository labels across platforms.

## 0.5.1

### Bug fixes

- Keep polling accepted R2 ingest jobs after busy or retry-later commit responses so successful background completion is not reported as failure.

## 0.5.0

### Features

- Add bounded R2 multipart uploads with resumable progress and legacy-ingest fallback.
- Filter known secrets locally before either upload transport and report merged redaction counts.
- Preserve unrelated coding-agent hooks and reconcile automatic-upload configuration safely.

### Bug fixes

- Keep existing credentials compatible with the legacy API hostname.
- Ship executable bin paths accepted by current npm publish validation.

## 0.4.0

### Breaking changes

- Rename the canonical package and executable to `@opalinehq/cli` and `opaline`.

### Features

- Preserve existing `~/.rudel` credentials and state without requiring login.
- Add read-only `opaline doctor` diagnostics and `OPALINE_LOG_LEVEL=debug`.
- Keep legacy `RUDEL_*` environment variables and installed hook commands compatible.

## [0.3.0](https://github.com/evrendom/rudel/compare/rudel@0.2.3...rudel@0.3.0) (2026-08-13)


### Features

* **usage:** add request-level usage events ([#433](https://github.com/evrendom/rudel/issues/433)) ([f9013b0](https://github.com/evrendom/rudel/commit/f9013b0f3a12429cab246bf22759fe6e0509397b))


### Bug Fixes

* **analytics:** rebuild session identity and retention ([#416](https://github.com/evrendom/rudel/issues/416)) ([4ab3775](https://github.com/evrendom/rudel/commit/4ab37755775db89decc90e8a7aeb446e799dd604))
* **cli:** repair hooks, endpoints, and dry runs ([#446](https://github.com/evrendom/rudel/issues/446)) ([59a35ca](https://github.com/evrendom/rudel/commit/59a35cab9d7e43d909a45d95962427b33fc5e3f4))
* **ingest:** protect uploads and retain failures ([#432](https://github.com/evrendom/rudel/issues/432)) ([ac1f9ac](https://github.com/evrendom/rudel/commit/ac1f9acbb24448919631e37b6d730e4cb1d4fe9b))
* move dashboard analytics server-side ([#444](https://github.com/evrendom/rudel/issues/444)) ([a1cd0e1](https://github.com/evrendom/rudel/commit/a1cd0e1db411efb5da8ce20d5b5ed97c61107ce5))

## [0.2.3](https://github.com/evrendom/rudel/compare/rudel@0.2.2...rudel@0.2.3) (2026-07-31)


### Bug Fixes

* **adapters:** harden session ingestion ([#412](https://github.com/evrendom/rudel/issues/412)) ([ddc855a](https://github.com/evrendom/rudel/commit/ddc855a0d7dc2392e95e964a0688271831190137))

## [0.2.2](https://github.com/evrendom/rudel/compare/rudel@0.2.1...rudel@0.2.2) (2026-07-29)


### Bug Fixes

* **cli:** repair existing credential permissions ([#399](https://github.com/evrendom/rudel/issues/399)) ([d8cf505](https://github.com/evrendom/rudel/commit/d8cf505809e06f039a55c25e4b2843ec599a376b))

## [0.2.1](https://github.com/evrendom/rudel/compare/rudel@0.2.0...rudel@0.2.1) (2026-07-29)


### Bug Fixes

* **cli:** stop persisting git remote credentials ([#394](https://github.com/evrendom/rudel/issues/394)) ([d09b547](https://github.com/evrendom/rudel/commit/d09b5479ac44d844708197c7d5988a80add7246e))

## [0.2.0](https://github.com/evrendom/rudel/compare/rudel@0.1.17...rudel@0.2.0) (2026-07-28)


### Features

* redact known secrets before transcript upload ([#391](https://github.com/evrendom/rudel/issues/391)) ([166abae](https://github.com/evrendom/rudel/commit/166abae54463ac12ef1328f0b98e72be54f7537c))


### Bug Fixes

* **cli:** harden login flow against hostile servers and plaintext API bases ([#388](https://github.com/evrendom/rudel/issues/388)) ([b0aac05](https://github.com/evrendom/rudel/commit/b0aac055de72070e0a68d30dc4a02b4e5765d8c6))
* **cli:** validate credential-bearing upload destinations ([#390](https://github.com/evrendom/rudel/issues/390)) ([b4086a5](https://github.com/evrendom/rudel/commit/b4086a5c6a9ffa44dc6381c3357dc99251842459))

## [0.1.17](https://github.com/evrendom/rudel/compare/rudel@0.1.16...rudel@0.1.17) (2026-07-24)


### Bug Fixes

* **api:** bound ingest abuse and duplicate work ([#377](https://github.com/evrendom/rudel/issues/377)) ([06d45f5](https://github.com/evrendom/rudel/commit/06d45f57f68e0a586a0d5feb3ee244aa6f997809))

## [0.1.16](https://github.com/evrendom/rudel/compare/rudel@0.1.15...rudel@0.1.16) (2026-07-24)


### Bug Fixes

* **cli:** return nonzero failures and revoke logout tokens ([#375](https://github.com/evrendom/rudel/issues/375)) ([aa20186](https://github.com/evrendom/rudel/commit/aa201860ca28f0bda672124112adf027cb43882a))

## [0.1.15](https://github.com/evrendom/rudel/compare/rudel@0.1.14...rudel@0.1.15) (2026-07-23)


### Bug Fixes

* preserve organization session ownership ([#366](https://github.com/evrendom/rudel/issues/366)) ([10d0cef](https://github.com/evrendom/rudel/commit/10d0ceff406cf3f561eeb0c8287882ece1771fa5))

## [0.1.12](https://github.com/obsessiondb/rudel/compare/rudel@0.1.11...rudel@0.1.12) (2026-05-04)


### Features

* **api-cli:** track lifecycle analytics events ([#161](https://github.com/obsessiondb/rudel/issues/161)) ([4b1940b](https://github.com/obsessiondb/rudel/commit/4b1940baba46a9a997163e6cca614f114c3d81f8))
* exempt manual/retry uploads from ingest rate limit ([572b816](https://github.com/obsessiondb/rudel/commit/572b81615558c6b8a665341d69373fe329bea4e2))
* ship first Rudel Wrapped version ([#252](https://github.com/obsessiondb/rudel/issues/252)) ([a56d36f](https://github.com/obsessiondb/rudel/commit/a56d36fc7ee8715d7d5f452dbc4a61bb66ed2fe4))


### Bug Fixes

* align Claude Code and Codex copy ([#189](https://github.com/obsessiondb/rudel/issues/189)) ([a68d6aa](https://github.com/obsessiondb/rudel/commit/a68d6aa0ad88b573eca550df803e38b23cde94ad))
* clarify CLI upload server errors ([#295](https://github.com/obsessiondb/rudel/issues/295)) ([50eebf0](https://github.com/obsessiondb/rudel/commit/50eebf008f7f58080ae4bfd261bbc52cfaf86869))
* disable CLI API key rate limit ([#294](https://github.com/obsessiondb/rudel/issues/294)) ([35211d9](https://github.com/obsessiondb/rudel/commit/35211d99381c6d7fbcba4056867faea5c04d1e4a))
* improve ingestion rate limit handling in CLI and API ([#156](https://github.com/obsessiondb/rudel/issues/156)) ([726370d](https://github.com/obsessiondb/rudel/commit/726370dcfbeb63b6255953da590617903a6ef516))
* surface CLI API key rate limits ([#292](https://github.com/obsessiondb/rudel/issues/292)) ([78c50a8](https://github.com/obsessiondb/rudel/commit/78c50a88169c352f3bbca7329095f7b411c6c587))

## [0.1.9](https://github.com/obsessiondb/rudel/compare/rudel@0.1.8...rudel@0.1.9) (2026-03-11)


### Bug Fixes

* **cli:** prevent prompt injection in session classifier ([#133](https://github.com/obsessiondb/rudel/issues/133)) ([b234023](https://github.com/obsessiondb/rudel/commit/b234023b8c381fdb0e1983080c7fa5f87e8a1c2e))
* replace CLI loopback token handoff with device code flow ([#141](https://github.com/obsessiondb/rudel/issues/141)) ([d2f1372](https://github.com/obsessiondb/rudel/commit/d2f1372be2aefe21e912a11531e50d0cfcd63778))

## [0.1.8](https://github.com/obsessiondb/rudel/compare/rudel@0.1.7...rudel@0.1.8) (2026-03-03)


### Features

* implement developer name resolution with git remote and package name ([#111](https://github.com/obsessiondb/rudel/issues/111)) ([f675de6](https://github.com/obsessiondb/rudel/commit/f675de6717ff6f0f14e8d50414aa47cc5845b9eb))
* remove repository column from ClickHouse schema ([#114](https://github.com/obsessiondb/rudel/issues/114)) ([6547b25](https://github.com/obsessiondb/rudel/commit/6547b2594666d899ebf0e366bbf85c87df5888d8))

## [0.1.7](https://github.com/obsessiondb/rudel/compare/rudel@0.1.6...rudel@0.1.7) (2026-03-03)


### Bug Fixes

* move agent-adapters to devDependencies to fix npm install error ([#105](https://github.com/obsessiondb/rudel/issues/105)) ([84f3544](https://github.com/obsessiondb/rudel/commit/84f35446fb9f455f865355d2e7c30c941c4ab44a))

## [0.1.6](https://github.com/obsessiondb/rudel/compare/rudel@0.1.5...rudel@0.1.6) (2026-03-02)


### Features

* add explicit retry, progress tracking, and failed upload tracking for CLI uploads ([#96](https://github.com/obsessiondb/rudel/issues/96)) ([419983d](https://github.com/obsessiondb/rudel/commit/419983d79060e27b138dc1be9d52a8a3e8e4526a))
* add git_remote and package_name as primary project identity signals ([#90](https://github.com/obsessiondb/rudel/issues/90)) ([1fda8bb](https://github.com/obsessiondb/rudel/commit/1fda8bbd175e444795c812687970feccf02b5842))
* add OpenAI Codex session support ([#86](https://github.com/obsessiondb/rudel/issues/86)) ([5e21a9c](https://github.com/obsessiondb/rudel/commit/5e21a9cdafa8d6623b07d0a7697e0fa825451117))
* add structured logging via @logtape/logtape ([#93](https://github.com/obsessiondb/rudel/issues/93)) ([b3ede93](https://github.com/obsessiondb/rudel/commit/b3ede9341a7cc99487e4a8d5c05264c5edd069a7))
* make agent source type-safe with enum ([#100](https://github.com/obsessiondb/rudel/issues/100)) ([fac4498](https://github.com/obsessiondb/rudel/commit/fac44983e4578e3655d84c20d31c0d932714e223))
* refactor batch uploads with separated logic and UI layers ([#97](https://github.com/obsessiondb/rudel/issues/97)) ([91ffb1a](https://github.com/obsessiondb/rudel/commit/91ffb1a49cfb268b775a2f27269b68d691ba7135))


### Bug Fixes

* correct ClickHouse set index syntax in migration ([#95](https://github.com/obsessiondb/rudel/issues/95)) ([ddf1da0](https://github.com/obsessiondb/rudel/commit/ddf1da0385573d073787a17fc70d8fa7ac319ca6))
* unify session discovery logic between enable and upload commands ([#94](https://github.com/obsessiondb/rudel/issues/94)) ([48e0ed6](https://github.com/obsessiondb/rudel/commit/48e0ed617838be6191671ec371fd2cbef0aabc13))

## [0.1.5](https://github.com/obsessiondb/rudel/compare/rudel@0.1.4...rudel@0.1.5) (2026-03-02)


### Features

* add auth verification and retroactive session uploads to enable command ([#63](https://github.com/obsessiondb/rudel/issues/63)) ([d6a4a5a](https://github.com/obsessiondb/rudel/commit/d6a4a5a9295c4e33359d982a671bfd836dd6f32f))
* add dev workspace with list-sessions command ([#75](https://github.com/obsessiondb/rudel/issues/75)) ([a0321ef](https://github.com/obsessiondb/rudel/commit/a0321ef1fa79ba04742ea291fe0868c705702ed4))
* add interactive project picker for rudel upload ([#66](https://github.com/obsessiondb/rudel/issues/66)) ([85bb3c9](https://github.com/obsessiondb/rudel/commit/85bb3c9a16d4c4531b86bf848db8344f133f7a5e))
* add organization deletion with session migration support ([#74](https://github.com/obsessiondb/rudel/issues/74)) ([1318351](https://github.com/obsessiondb/rudel/commit/13183517d4392a846c524992ab4b71e4e46635bf))
* make Rudel multitenant with organization support ([#43](https://github.com/obsessiondb/rudel/issues/43)) ([e40e589](https://github.com/obsessiondb/rudel/commit/e40e5897fcab697f1156bbdfff50eefb16ec3644))

## 0.1.4

Initial open-source release.
