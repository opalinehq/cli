# Contributing to Opaline CLI

## Prerequisites

- Node.js 20 or newer
- Bun 1.3.10, matching the `packageManager` version in `package.json`

## Setup

```bash
git clone https://github.com/opalinehq/cli.git
cd cli
bun install
bun run verify
```

Run the development CLI with:

```bash
bun run --cwd apps/cli dev --help
```

## Development commands

```bash
bun run lint
bun run lint:fix
bun run format
bun run check-types
bun run test
bun run build
bun run verify
```

`bun run verify` must pass before a pull request is opened.

## CLI playground

```bash
bun run dev:cli
```

Open <http://127.0.0.1:4077> to preview repository selection, review, and upload states using the real CLI renderer with sample data. No sessions are uploaded. Pass another port with `bun run dev:cli 4078` if needed.

The README screenshot uses the repository-selection screen with the default theme and sample repositories, a 96-column × 20-row viewport, and 16 px text. When updating it, capture the terminal window from this playground and keep the sample-data caption.

## Pull requests

- Use a conventional title: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`,
  `build:`, `ci:`, `chore:`, or another type accepted by the PR-title check.
- Keep changes focused and describe user-visible compatibility impact.
- Preserve stdout, stdin, arguments, and exit behavior for the permanent
  `rudel` compatibility alias.
- Never include service, dashboard, deployment, or private monorepo code in
  this public CLI repository.

Release Please versions `opaline`, `@opalinehq/cli`, and `rudel` together.
Publishing is performed by maintainers; contributors must not publish packages
from a branch. See [RELEASING.md](RELEASING.md) for npm setup and release recovery.

## Project structure

```text
apps/cli/              @opalinehq/cli source, tests, and bundled contracts
packages/opaline/      recommended opaline installation and executable
packages/rudel-alias/  thin rudel compatibility executable
```

Report security vulnerabilities privately as described in
[SECURITY.md](SECURITY.md).
