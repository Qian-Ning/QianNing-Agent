---
title: Start here
description: Get from installation to a verified QianNing Agent project session in about five minutes.
---

# Start here

QianNing Agent (千凝) is a local-first desktop workspace for developers and power users who want an agent to work on real projects without hiding its tools, approvals, or results.

This guide takes the shortest useful path: install the app, connect a model, bind a project, and complete one change that you can inspect and verify.

## The five-minute path

1. [Install QianNing Agent](/guide/install) for your operating system.
2. Add a provider and test its connection.
3. Open a project directory and create a project session.
4. Keep the permission mode on **Ask** for the first run.
5. Give Agent one bounded task, then inspect the tool record and result.

The complete walkthrough is in [Your first project session](/guide/first-session).

## Choose an operating mode

| Mode | Use it when | What happens before execution |
|---|---|---|
| **Agent** | The task is clear and you want the work done now | Host-owned permission policy still governs every tool |
| **Plan** | You want to review the implementation route first | The app preserves an immutable plan artifact and asks for separate approval |
| **Goal** | The outcome is clear but the implementation should remain autonomous | You approve the outcome, acceptance criteria, and boundaries |

Plan and Goal control the contract for the same Agent. They are not separate assistants. Bash follows the selected permission policy in every mode, so use **Ask** while learning the product.

## What is stored locally

A packaged installation uses `~/.qianning-agent` by default. Sessions are human-readable JSONL files, while SQLite provides indexes and structured application state. Provider secrets are encrypted through Electron `safeStorage` and managed by Rust host-core.

QianNing Agent does not currently use an OS keychain backend. A process running as the same operating-system user that can read the application data directory remains inside the local threat model. Read [Data, privacy, and security](/guide/data-and-security) before adding production credentials or marketplace plugins.

## Go deeper

| Your next task | Read |
|---|---|
| Install, update, or choose a package | [Installation and updates](/guide/install) |
| Configure a provider and finish a first task | [Your first project session](/guide/first-session) |
| Understand storage, permissions, secrets, and plugins | [Data, privacy, and security](/guide/data-and-security) |
| Run recurring prompts | [Scheduled tasks](/guide/automations) |
| Add an MCP catalog | [MCP market](/guide/mcp-market) |
| See the application surfaces | [Interface gallery](/guide/screenshots) |
| Build an extension | [Plugin development](/plugin-development) |
| Understand process ownership | [Architecture specification](/spec/02-architecture/01-architecture) |

## System model

```text
Renderer UI
    ↓ allowlisted preload IPC
Electron Main
    ├── Rust Host Core: persistence, tools, permissions, audit
    └── Node Agent Runtime: models, context, tools, subagents
```

The renderer owns presentation and has no direct Node, filesystem, or SQLite access. Electron Main coordinates desktop capabilities and child processes. Rust host-core owns persistent state and privileged operations. The Node sidecar owns the agent loop and provider-facing model work.

For repository development rules, continue with the [AI development workflow](/spec/06-delivery/03-ai-development-workflow) and [change checklist](/spec/06-delivery/05-change-checklist).
