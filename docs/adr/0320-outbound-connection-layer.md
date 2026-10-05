# ADR 0320: Outbound Connections Are a User-Owned Host-Core Capability

- Status: Target specification; not implemented
- Date: 2026-10-04
- Decision: D660 (extended by D661 and D662)
- Related: ADR 0203, ADR 0205, ADR 0004,
  `02-architecture/06-connections.md`,
  `03-runtime/23-connections-protocol.md`,
  `05-security/03-connections-security.md`

## Context

The desktop can already reach other machines, because `Bash` runs an arbitrary
command and `ssh` is an arbitrary command. What it cannot do is treat those
machines as first-class objects: there is no record of a target, no per-target
policy, no host-key decision the user made once, no audit trail, and no surface
where a person can see what the Agent has been running where.

Two questions had to be settled before implementation.

**Where does the layer live?** The desktop already contains an SSH path for a
different purpose: the `pi-host` bootstrap in
`apps/desktop/electron/main/remote/` spawns the system `ssh` to provision a
remote Agent Host. That path is deliberately thin — it exists to upload a
bootstrap script, forward a port, and pair a device — and it is written in
Electron main because it needs `safeStorage` for a stored login password. A
connection layer is a different shape: it needs per-stream output budgets, spill
to file, a timeout ladder, process-group teardown on abort, host-owned
permissions, a secret store, and an audit record. All of those exist in Rust
host-core, and none of them exist in Electron main.

**What is the primitive?** SSH has a command boundary and an exit code. A serial
device, a telnet endpoint, and a raw TCP socket have neither — they are byte
streams. Treating all four as "a session you send commands to" would produce a
vocabulary in which an action is sometimes unavailable depending on the target,
which is the failure mode the model is worst at recovering from.

A third question was answered by measurement rather than design.
`OpenSSH_for_Windows` does not implement `ControlMaster`: `ssh -G` with
`ControlMaster=auto` silently omits the option on the bundled Windows client,
while the same probe against a Unix `ssh` reports `controlmaster auto`. Any
design that assumes connection reuse is therefore wrong on the platform this
application ships on first.

## Decision

1. **The layer is a Rust host-core module**, `connection/`, structured like
   `computer/`: pure logic (profile model, validation, policy, argument
   parsing) separated from a platform layer, with the platform layer reporting
   unsupported rather than degrading silently. Electron Main forwards; the
   renderer reaches the layer only through the existing typed IPC surface.

2. **A profile is user-owned data.** It is created, edited, enabled, and
   deleted by a person through user-facing `connection.*` methods. The
   Agent-facing surface contains no method that mutates a profile. This is
   enforced by method surface rather than by inspecting the caller.

3. **Two capability levels, two tools.** A transport advertises
   `{ exec, transfer, stream }`. The `Connection` tool covers request/response
   work against a profile; the `Console` tool covers a stateful byte stream.
   Two handles, two tools, following the `Computer` precedent that one tool per
   shared handle beats one tool with a mixed action vocabulary.

4. **`exec` mirrors local `Bash`.** One command per process, the same result
   envelope, the same output budgets and spill mechanism, and a non-zero exit
   code reported as data rather than as an error.

5. **No protocol stack is implemented.** `ssh`, `scp`, and `sftp` are the
   system's own programs, so the user's `~/.ssh/config`, agent, jump hosts, and
   `known_hosts` apply as they do in a terminal. Connection multiplexing is a
   per-profile opt-in that is never assumed, and a probe reports whether a
   shared connection was actually obtained.

6. **Gating follows D659.** One predicate over the global
   `remoteControlEnabled` setting and the profile's own `enabled` is read at
   three doors — the Agent-facing method, `tools.list`, and `tools.execute` —
   and the listing and execution predicates are one function.

7. **The profile record is the only storage change**, persisted in SQLite with
   a schema migration, and the credential goes to the existing secret store
   under a reference the record holds.

8. **The neighbouring capability is not merged into this one.** Connections
   answers "run this on that machine"; ADR 0205's remote agent control answers
   "run *me* on that machine". Both are specified, and §3 of the architecture
   document states the distinction so neither grows the other's credential
   store.

9. **Exclusions are requirements.** No terminal emulation, no session manager,
   no XModem/YModem/ZModem, no X11 or agent forwarding, no reverse or dynamic
   forwarding in the first milestone, and no listener owned by host-core.

## Consequences

### Positive

- A capability the Agent already had becomes named, inspectable, revocable, and
  audited, which is the only way "off" can mean off for a path that already
  exists.
- The output path, the timeout ladder, the spill mechanism, and process
  teardown are shared with the local command tool, so a remote command behaves
  the way every other long-running command already behaves.
- Per-target switches let a user reach a scratch machine without reaching a
  production one, which a single global switch cannot express.
- The user's existing SSH configuration is reused rather than duplicated, so
  there is no second credential store and no second `known_hosts` to keep
  honest.
- The system `ssh` is a process rather than a linked library, so the transport
  is inspectable with the tools the user already has.

### Costs and risks

- A new persisted table and a schema migration, with the accompanying upgrade
  compatibility obligations.
- The capability's own error vocabulary — nine codes — becomes a release
  surface that bindings and clients must reproduce.
- Serial support is platform work whose failure mode is physical rather than
  observable in the result, so it carries an extra statement in the interface
  and its own verification burden.
- Authored command strings are still authored command strings. The audit trail
  makes them attributable; it does not make them safe, and the architecture
  document says so rather than implying otherwise.
- The convergence with the `pi-host` bootstrap credential is deferred, so for a
  period one machine may be configured twice with two independent secrets.

## Alternatives considered

### Implement SSH, telnet, and serial inside the application

Rejected. It is a protocol stack, a key-exchange implementation, and a device
abstraction to maintain, and it discards the user's existing configuration in
favour of a second one to keep correct. The system `ssh` is present on every
supported platform and is the program whose behaviour the user already trusts.

### Put the layer in Electron main beside the existing SSH bootstrap

Rejected. Output budgets, spill-to-file, the timeout ladder, process-group
teardown, the secret store, permissions, and the audit record are host-core's.
Reimplementing them in TypeScript would diverge precisely where they matter —
a flooding command, a hanging command, an interrupted turn — and would put a
subsystem in the process AGENTS.md §4 keeps thin.

### One `Remote` tool for every target kind

Rejected. Half its actions would be unavailable on half its targets, and the
model would learn the availability rule only by failing. Two handles are two
tools.

### Reuse the remote agent control protocol as the transport

Rejected. RACP controls an Agent Host, not a shell. Using it here would require
a `pi-host` on every target, which is exactly the constraint a serial device or
a telnet endpoint cannot satisfy.

### Assume connection reuse for performance

Rejected. The bundled Windows SSH client does not implement it, so the
assumption would be false on the platform this application ships on first.
Reuse is an explicit per-profile request whose outcome is reported.

### Gate the tool listing with one switch and the execution with another

Rejected. D659 recorded the defect: a model that saw a tool on an earlier turn
still holds its definition, so a listing-only gate is a lock on the front door.
One predicate, three doors, one function.
