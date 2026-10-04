# Privacy Policy

**Effective date: 2026-09-29**

This policy describes how the QianNing Agent desktop application handles information. QianNing Agent is a local-first open-source distribution maintained at [Qian-Ning/QianNing-Agent](https://github.com/Qian-Ning/QianNing-Agent) and derived from PI-Desktop.

## Privacy at a glance

- QianNing Agent does not require a QianNing Agent account.
- Projects, sessions, settings, transcripts, logs, and model pricing are stored locally by default.
- The default shipped data directory is `~/.qianning-agent`.
- QianNing Agent does not operate a remote telemetry or cloud crash-analytics pipeline.
- Prompts, files, tool results, and attachments may be sent to the model provider, gateway, plugin, or MCP server that you select or authorize.
- API keys and OAuth credentials are kept in the application's encrypted local secret store.
- Automatic application updates are disabled in the current customized distribution.

## Information stored locally

Depending on the features you use, QianNing Agent may store:

- project paths, project metadata, sessions, transcripts, prompts, responses, attachments, and tool results;
- provider, model, interface, permission, voice, skin, pet, and application settings;
- encrypted provider credentials and OAuth tokens;
- plugin code, plugin settings, plugin-owned data, MCP configuration, and local logs;
- token usage, estimated model costs, and locally edited model pricing;
- downloaded voice transcription models and their installation state;
- temporary files, caches, review snapshots, audit records, and crash minidumps; and
- a bounded in-memory clipboard history when clipboard features are used.

This data can include personal information or confidential source code. QianNing Agent does not upload local data merely because it is stored by the application.

## Information sent to other services

### Model providers and gateways

When you send a prompt or start an agent turn, the application sends the content required for that request to the provider, gateway, or local model server you configured. This may include conversation history, project excerpts, tool results, attachments, model metadata, and workspace instructions.

The selected provider's privacy and retention terms apply. Review the endpoint before sending confidential information.

### Plugins and MCP servers

Plugins and MCP servers can process data involved in operations you invoke or authorize. Remote MCP servers may receive initialization and tool-catalog requests before a tool call. Plugin code runs locally with user-level operating-system privileges and is not fully capability-sandboxed. Install only software you trust.

QianNing Agent does not intentionally expose raw credentials through documented plugin APIs.

### Catalogs, downloads, links, and media

Features you enable may contact model catalogs, voice-model download sources, plugin services, provider OAuth endpoints, GitHub, or other configured services. Those services can receive ordinary network metadata such as IP address and user agent.

External links open in the operating system's browser. Remote images, audio, or video referenced by content may cause network requests to their hosts.

### Local control interfaces

The optional local MCP control plane is disabled by default and binds to loopback when enabled. Protect the local data directory and its bearer token. Do not expose it to untrusted local users or remote networks.

## What QianNing Agent does not do

QianNing Agent does not currently:

- sell personal information or use it for advertising;
- require product registration;
- upload application telemetry or crash dumps to a QianNing-operated analytics service;
- use local projects or transcripts to train a QianNing model; or
- expose raw provider credentials to the renderer, normal application logs, or plugins through documented APIs.

Third-party providers, plugins, MCP servers, websites, and modified builds can have different practices.

## Retention and deletion

Local data remains until you remove it, subject to filesystem backups and operating-system behavior.

- Delete sessions in the application to remove their records and transcript files.
- Remove providers or credentials to remove their saved authentication data.
- Downloaded voice models remain until deleted from Voice settings or from local application data.
- Logs and audit records are rotated or pruned according to application limits.
- Crash minidumps remain local until deleted.
- Uninstalling the application may leave `~/.qianning-agent` behind so reinstalling does not destroy user data.

Deleting local data does not delete copies already sent to a provider, plugin, MCP server, or other third party.

## Security

QianNing Agent uses process boundaries, renderer sandboxing, workspace path checks, permission prompts, secret redaction, and encrypted local secret files. No security control is perfect. Agent tools and allowed shell commands execute with the current user's operating-system privileges.

Treat prompts, model output, plugins, MCP servers, downloaded models, and remote content as untrusted. Do not grant permissions to software you do not trust.

## Your choices

You can reduce data exposure by choosing local models, reviewing endpoints and permissions, disabling optional network features, and deleting local sessions, models, credentials, plugins, logs, and application data.

For privacy questions, use the [QianNing Agent repository](https://github.com/Qian-Ning/QianNing-Agent) without posting confidential information. For vulnerabilities, follow the [security policy](https://github.com/Qian-Ning/QianNing-Agent/security/policy).

## Upstream notice

QianNing Agent is derived from [PI-Desktop](https://github.com/vastsa/PI-Desktop). Upstream documentation can describe services or release behavior that differ from this customized distribution. This policy describes the QianNing Agent configuration maintained in this repository.
