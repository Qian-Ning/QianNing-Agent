# QianNing Agent Brand Contract

QianNing Agent is the shipped product identity. Its Chinese name is 千凝.

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