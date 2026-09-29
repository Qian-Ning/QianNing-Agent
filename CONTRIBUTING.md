# Contributing to QianNing Agent

QianNing Agent is a customized distribution derived from PI-Desktop. Changes in this repository must preserve local user data, security boundaries, compatibility contracts, and the QianNing product identity.

## Before starting

Read:

- [`README.md`](README.md) for current product scope;
- [`AGENTS.md`](AGENTS.md) for repository-wide development rules;
- [`docs/spec/01-qianning-brand.md`](docs/spec/01-qianning-brand.md) for the public brand contract;
- the relevant specifications under [`docs/spec/`](docs/spec/); and
- [`SECURITY.md`](SECURITY.md) before reporting a vulnerability.

## Repository remotes

The expected remotes are:

```text
origin   https://github.com/Qian-Ning/QianNing-Agent.git
upstream https://github.com/vastsa/PI-Desktop.git
```

`origin/main` contains the QianNing distribution. `upstream/main` is used to inspect and synchronize upstream PI-Desktop changes. Do not push QianNing-only commits to the upstream repository.

## Development workflow

1. Inspect the worktree with `git status --short` and preserve unrelated changes.
2. Fetch `origin/main` and create a dedicated branch and worktree for the request.
3. Read the nearest `AGENTS.md`, relevant implementation, tests, and specifications.
4. Make the smallest coherent change and preserve compatibility identifiers unless a migration is explicitly designed.
5. Add tests for observable behavior, protocol, security, lifecycle, and regression fixes.
6. Run the applicable typecheck, lint, unit, integration, build, and package checks.
7. Review the complete diff before committing. Never commit credentials, databases, logs, build output, or personal data.
8. Push the request branch to `origin` and integrate it through the repository's normal review path.

Typical checks:

```bash
pnpm build:js
pnpm --filter @pi-desktop/desktop typecheck
pnpm lint
pnpm -r --if-present test
cargo fmt --check
cargo test -p host-core --locked
cargo clippy -p host-core --all-targets
```

Use the narrowest sufficient set for the files changed, but never report an unexecuted check as passing.

## Brand and compatibility

Public and operating-system surfaces use **QianNing Agent** and the Chinese name **千凝**. This includes application labels, installers, shortcuts, window titles, permission descriptions, release documentation, and packaged process names.

Some internal identifiers intentionally remain unchanged:

- npm scopes under `@pi-desktop`;
- IPC channels under `pi-desktop/`;
- `PI_DESKTOP_*` environment variables;
- plugin IDs, protocol headers, Cargo crate names, and remote-host artifacts; and
- links that intentionally identify the upstream PI-Desktop project.

Do not perform a blind repository-wide rename. Treat these identifiers as compatibility contracts.

## Upstream synchronization

Before importing an upstream release:

1. fetch the target upstream tag or commit;
2. verify the actual base by comparing trees, not only version strings;
3. integrate upstream into a dedicated QianNing branch;
4. resolve semantic conflicts in branding, data paths, UI, plugins, voice, pricing, skins, and packaging;
5. scan new files for user-visible upstream branding;
6. rebuild and verify packaged artifacts and process names; and
7. keep upstream attribution and LGPL notices intact.

## Commit messages

Use Conventional Commits with a subject and explanatory body:

```text
fix(voice): initialize the packaged model catalog

the settings page must load model metadata before it can offer downloads
```

Stage files explicitly. Do not use `git add .`, `git add -A`, destructive resets, or force-pushes.

## Issues and security

Use issues for reproducible bugs and scoped feature requests. Include the QianNing Agent version, operating system, expected result, actual result, and redacted evidence.

Use private security reporting for vulnerabilities. Never post secrets or exploit details in a public issue.
