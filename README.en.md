<div align="center">

<img src="apps/desktop/src/assets/brand/logo.png" alt="QianNing Agent logo" width="144" />

# QianNing Agent

### A local-first desktop workspace for AI agents

**Keep projects, sessions, models, tools, and automation workflows in one persistent desktop environment.**

Windows-first · Local data · Multi-model · Plugin-extensible · Voice input

[![Release](https://img.shields.io/github/v/release/Qian-Ning/QianNing-Agent?label=release)](https://github.com/Qian-Ning/QianNing-Agent/releases)
[![CI](https://github.com/Qian-Ning/QianNing-Agent/actions/workflows/ci.yml/badge.svg)](https://github.com/Qian-Ning/QianNing-Agent/actions)
[![License](https://img.shields.io/badge/license-LGPL--3.0-blue.svg)](LICENSE)

[Releases](https://github.com/Qian-Ning/QianNing-Agent/releases) ·
[Documentation](docs/README.md) ·
[Privacy](docs/privacy-policy.md) ·
[简体中文](README.md)

</div>

> Current release line: `0.15.x` (latest `0.15.13`). This customized distribution is primarily maintained for Windows desktop use.

## About

QianNing Agent is a standalone AI-agent desktop application. It provides persistent project sessions outside a specific IDE and allows agents to inspect code, edit files, run commands, call tools, and continue long-running work.

The Chinese name is **千凝**. The English product name is **QianNing Agent**.

## Current capabilities

- Persistent local projects, sessions, transcripts, task state, and review results.
- OpenAI, Anthropic, OpenAI-compatible gateways, and local model configuration.
- Agent, Plan, and Goal operating modes.
- File, shell, diff-review, work-panel, browser, and plugin tools.
- Per-session system prompts, personas, and reasoning-effort selection.
- Local Whisper model catalog with model sizes, downloads, progress, and install state.
- Token and estimated-cost reporting with an editable local pricing table.
- Solid-color, image, and video skins plus a desktop pet.
- QianNing branding across the application, installer, shortcuts, and Windows processes.

## Local-first defaults

| Data | Default behavior |
| --- | --- |
| Projects and sessions | Stored locally |
| Application data | `~/.qianning-agent` |
| API credentials | Encrypted local storage |
| Model requests | Sent directly to the configured provider or local service |
| Application telemetry | No remote telemetry pipeline |
| Automatic updates | Disabled for this customized distribution |

Remote model providers, plugins, and MCP servers may receive data required for the operation you authorize. See the [privacy policy](docs/privacy-policy.md).

## Windows packages

Windows x64 builds produce:

```text
QianNing-Agent-Setup-0.15.13.exe
QianNing-Agent-Portable-0.15.13.exe
```

Published installers belong in this repository's [Releases](https://github.com/Qian-Ning/QianNing-Agent/releases). If no release asset is available, build from source.

## Build from source

Requirements:

- Node.js `>= 22.19`
- pnpm `>= 10`
- Stable Rust toolchain
- A compatible GNU or MSVC C toolchain for the Windows Rust host

```bash
git clone https://github.com/Qian-Ning/QianNing-Agent.git
cd QianNing-Agent
pnpm install
cargo build -p host-core
pnpm build:js
pnpm dev
```

Useful checks:

```bash
pnpm --filter @pi-desktop/desktop typecheck
pnpm lint
pnpm --filter @pi-desktop/shared test
```

Windows release build:

```bash
pnpm build:js
cargo build --release -p host-core --locked
pnpm -C packages/agent-runtime bundle
pnpm exec electron-vite build
pnpm exec electron-builder --win nsis portable --publish never
```

## Repository layout

```text
apps/desktop/           Electron main, preload, and React renderer
crates/host-core/       Rust host, SQLite, permissions, and native state
packages/agent-runtime Agent execution runtime
packages/plugin-sdk/   Plugin development contract
packages/shared/       Cross-process protocols and shared types
packages/voice-runtime Local voice model management and transcription
docs/                  Specifications, ADRs, and maintenance documentation
```

Some internal identifiers intentionally retain `@pi-desktop/*`, `pi-desktop/`, `PI_DESKTOP_*`, or Cargo crate names. They are compatibility contracts rather than product branding; renaming them would break existing data, plugins, or build tooling.

## Upstream and attribution

QianNing Agent is a derivative of [vastsa/PI-Desktop](https://github.com/vastsa/PI-Desktop) and continues to incorporate relevant upstream security and platform fixes. QianNing branding, Windows distribution behavior, voice availability, usage pricing, skins, pets, and other customizations are maintained in this repository.

This repository preserves upstream copyright and license notices. It is not an official PI-Desktop upstream release.

## Contributing and security

- [Contribution guide](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Specifications](docs/spec/README.md)
- [Plugin development](docs/plugin-development.md)

Do not include API keys, tokens, passwords, private source code, or personal information in public issues.

## License

Licensed under the **GNU Lesser General Public License v3.0**. See [LICENSE](LICENSE).
