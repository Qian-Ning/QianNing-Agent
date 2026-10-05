---
title: Data, privacy, and security
description: Understand where QianNing Agent stores data, how secrets and permissions work, and what remains inside the local threat model.
---

# Data, privacy, and security

Local-first describes ownership and routing, not absolute isolation. QianNing Agent stores its application state locally and sends model requests to the provider you configure. Tools, plugins, MCP servers, external links, and model-rendered media can still cross machine boundaries when you use them.

## Data directory

Packaged installations use `~/.qianning-agent`; development builds use `~/.qianning-agent-dev`. `PI_DESKTOP_DATA_DIR` can replace the root for controlled development and test environments.

```text
~/.qianning-agent/
├── pi.sqlite                 # indexes and structured application state
├── sessions/*.jsonl          # complete human-readable transcripts
├── sessions/*.inflight.json  # transient streaming checkpoints
├── secrets/                  # encrypted secret blobs and machine key
├── attachments/              # content-addressed conversation files
├── plugins/                  # installed plugin code and plugin data
├── logs/                     # local application, host, and runtime logs
├── review-changes/           # bounded file-review and rollback evidence
└── scratch/<sessionId>/      # temporary files owned by one session
```

Rust host-core owns SQLite and transcript writes. The renderer and Node sidecar do not open the database directly.

## What leaves the machine

| Action | Network destination |
|---|---|
| Send a prompt | The model provider or gateway selected for that session |
| Refresh a model catalog | The configured provider endpoint |
| Install or refresh a skill/MCP catalog | The source URL and allowed document URLs |
| Use a network-capable MCP server or plugin | Destinations chosen by that extension |
| Render remote media in an assistant message | The remote `http(s)` host named in the message |
| Check for updates | The fixed QianNing Agent GitHub Releases feed |

Remote images, audio, and video in completed assistant Markdown can load without a click. The remote host can therefore observe the machine's public network address. Links open through the operating-system browser after URL validation.

## Secrets

Provider, MCP, and sync credentials are managed by host-core. The renderer receives configured/not-configured state and never receives the plaintext for display. Logs and audit writes apply secret redaction.

Electron `safeStorage` protects the local encrypted blobs, but QianNing Agent does not currently implement a separate OS keychain backend. A process running as the same operating-system user that can read the application data directory is part of the local threat model. Disk encryption, a protected user account, and normal operating-system access controls remain important.

## Workspace and permissions

File tools default to the project bound to the durable session. Relative paths resolve inside that workspace. A path outside the workspace and session scratch directory requires the explicit outside-path policy; denial, cancellation, or timeout does not execute.

High-risk operations are decided by Rust host-core, not by renderer state. Permission requests expire after 120 seconds and fail closed. Session grants are in-memory and scoped by tool name.

Bash runs with the current operating-system user's authority. QianNing Agent bounds its working directory, timeout, output, cancellation, and audit path, but it is not an operating-system container.

## Plugins, skills, and MCP

- A Skill is Markdown guidance loaded into the Agent context. Review it as instructions from its publisher.
- MCP servers expose tools and may make their own network or system calls. User-configured MCP tools are treated as medium risk by the host regardless of the server's self-declared risk.
- Marketplace plugins currently run in a separate utility process but may use raw Node built-ins. Treat installed plugin code as user-privileged code until capability sandboxing and trusted publisher signatures are implemented.
- Catalog transport hashes check downloaded bytes when provided; they do not prove publisher identity.

Install extensions only from sources you trust, and inspect the requested permissions and source code when the extension can access valuable data.

## Back up and restore

For a complete local backup, quit QianNing Agent before copying `~/.qianning-agent`. This avoids taking SQLite, WAL, and actively appended transcript files at different points in time.

The data directory contains secrets and private transcripts. Store backups with access controls at least as strong as the original account. Do not attach the whole directory to a bug report.

Encrypted WebDAV configuration sync is separate from transcript backup. It can carry selected preferences and user-owned capabilities, but it does not synchronize conversation history or project source files.

## Delete data

Deleting a session removes its transcript, scratch directory, and session review snapshots through host-core. Uninstalling the application may leave the data directory intact. To remove all local application state:

1. quit QianNing Agent completely, including the tray process;
2. back up anything you intend to keep;
3. remove `~/.qianning-agent`;
4. remove any separately configured development or override data directory.

This action is irreversible unless you retained a backup.

## Report a security issue

Follow the private reporting channel in the repository [security policy](https://github.com/Qian-Ning/QianNing-Agent/blob/main/SECURITY.md). Do not include live credentials, complete private transcripts, or unredacted local paths in a public issue.

The authoritative implementation contract is the [security specification](/spec/05-security/01-security), with storage details in [Data Storage](/spec/03-runtime/04-data-storage) and tool policy in [Tools and Permissions](/spec/03-runtime/03-tools-and-permissions).
