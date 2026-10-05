# QianNing Agent Brand Contract

QianNing Agent is the shipped product identity — its name in every language and
locale. The product is never named 千凝.

千凝 is the developer: the person who builds and maintains the product, whose
pen name is QianNing. Two features carry that name — the desktop companion and
the default theme — so 千凝 does appear in the product, as a feature name. That
is the whole of it: 千凝 is not the product, not the software, and not the
agent's own name.

QianNing Agent is developed and maintained by QianNing, and by no one else. That
is the only developer, vendor, and owning organization the product recognizes:
neither the agent in chat nor any bundled copy may name another company,
upstream project, or parent organization as its maker.

The following operating-system and user-visible surfaces use `QianNing Agent`:

- application, window, taskbar, process group, shortcut, and tray labels
- installer, portable package, macOS bundle, Linux package, and desktop-entry names
- the packaged host process, named `QianNing-Agent-Host-Core`
- system permission descriptions, feedback environment text, OAuth pages, errors,
  built-in plugin metadata, tool descriptions, and in-app changelog copy
- application id `com.qianning.agent` and shipped data directory `~/.qianning-agent`

Internal compatibility identifiers remain stable where renaming would break existing
plugins, automation, data, or source-package resolution. This includes scoped npm
packages under `@pi-desktop`, IPC channels under `pi-desktop/`, `PI_DESKTOP_*`
environment variables, plugin ids, protocol header names, Cargo crate names, remote
host artifact names, and links that intentionally identify the upstream repository.

The packaged Rust executable is copied from Cargo's internal
`pi-desktop-host-core[.exe]` output to `QianNing-Agent-Host-Core[.exe]`. Development
launches continue to accept the Cargo output name; released packages must expose only
the QianNing name.