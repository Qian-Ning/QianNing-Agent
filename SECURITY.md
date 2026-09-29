# Security Policy

QianNing Agent is a local-first desktop application derived from PI-Desktop. Security reports are handled for the QianNing distribution and its customizations through this repository.

## Supported versions

Security fixes are provided for the latest version published in the [QianNing Agent releases](https://github.com/Qian-Ning/QianNing-Agent/releases). Older releases and development builds may not receive fixes.

## Report a vulnerability

**Do not report security vulnerabilities through public issues, pull requests, or discussions.**

Use GitHub's private security advisory form:

<https://github.com/Qian-Ning/QianNing-Agent/security/advisories/new>

If private vulnerability reporting is unavailable, contact the repository owner through a private channel before disclosing technical details. Do not post credentials, private source code, personal data, exploit payloads, or unredacted logs publicly.

Include:

- a description of the vulnerability and its impact;
- the affected QianNing Agent version, operating system, and package type;
- minimal reproduction steps or a proof of concept;
- the affected component or security boundary; and
- redacted logs, screenshots, stack traces, or remediation ideas when useful.

Do not test against other users, access data that does not belong to you, or perform destructive actions. QianNing Agent does not operate a bug-bounty program.

## Scope

Reports are generally in scope when they affect:

- QianNing Agent release artifacts or custom branding/distribution behavior;
- Electron main, preload, renderer sandboxing, IPC, or RPC boundaries;
- the Rust host core, agent runtime, local database, or filesystem restrictions;
- credentials, permission prompts, tool execution, plugins, MCP, or local control interfaces; or
- voice models, update/release links, and other QianNing-specific integrations.

Issues inherited unchanged from the upstream PI-Desktop project may also need to be reported to the [upstream security process](https://github.com/vastsa/PI-Desktop/security). Do not disclose a vulnerability publicly in either repository before maintainers have had reasonable time to investigate.

## Disclosure

We aim to acknowledge private reports within seven calendar days and provide an initial assessment within fourteen calendar days. Timelines can vary with severity, reproducibility, and upstream coordination requirements.
