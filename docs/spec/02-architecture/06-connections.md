# Connections Target Architecture

- Status: Target specification; not implemented
- Decision: D660 / ADR 0320, extended by D661 and D662
- Scope: letting the Agent operate other machines and devices from the desktop
- Source of truth: `03-runtime/23-connections-protocol.md`

## 1. Scope and status

This document specifies the architecture for **Connections**: an outbound,
user-owned set of targets — a remote shell over SSH, a serial device, a telnet
endpoint, a raw TCP socket — that the Agent can execute against, read from, and
write to.

Nothing here is implemented in the current release. The `Connections`
destination, the settings card, the `connection.*` host methods, and the
`Connection` / `Console` tools are target work. This document does not change
the frozen MVP boundary in `00-baseline.md`, ADR 0004, or ADR 0205.

The capability lets an authenticated local user:

- register a target once, by hand, and keep it;
- see its status, its last probe, and its recent activity;
- let the Agent run a command on it, upload and download files, and — for a
  byte-stream target — open a session and exchange bytes;
- switch the whole surface off, or one target at a time; and
- read an audit record of what ran where.

The feature is **not** a terminal emulator, a session manager, an arbitrary
network proxy, or a remote desktop. §10 states those exclusions as
requirements rather than preferences.

## 2. Design principles

1. **This structures an existing capability; it does not create one.** The
   `Bash` tool can already run `ssh host '…'` on this machine, because it can
   run any command. Connections add named targets, per-target policy, host-key
   verification, an audit trail, and a surface the user can see. It does not
   widen what the Agent can reach.
2. **A target is user-owned data.** A profile is created, edited, enabled, and
   deleted by a person in the interface. No Agent-facing method creates,
   edits, enables, or deletes one. This is enforced by method surface, not by
   caller identity.
3. **The agent-facing surface is off by default.** A global switch gates every
   Agent-facing method and both tools. A target carries its own switch so one
   machine can be reachable while another is not.
4. **`exec` mirrors local `Bash`.** One command per process, one result
   envelope, stdout head and stderr tail under the same output budgets, a
   non-zero exit code reported as data rather than as an error. The Agent
   should not have to learn a second convention for the same idea.
5. **A byte-stream target is a different primitive.** Serial, telnet, and raw
   TCP have no command boundary and no exit code. A transport advertises what
   it can do, and a method a transport cannot serve is refused by name instead
   of failing obscurely.
6. **No protocol stack is implemented here.** SSH, SFTP, and the port forward
   are the system's OpenSSH programs. The user's `~/.ssh/config`, agent, jump
   hosts, and `known_hosts` apply exactly as they do in their terminal.
7. **A secret never crosses a model boundary.** Passwords and key paths live in
   the host's secret store. No Agent-facing method returns one, and no audit
   record stores one.
8. **The switch closes every Agent-facing door; the user door stays open.**
   With the switch off the Agent can neither enumerate targets nor make the
   host dial one — `probe` is not a read, it opens a connection and
   authenticates, so gating it on the same predicate as `exec` is what keeps
   "off" meaning off. The user-facing methods are never gated, because seeing
   a target is how a person decides to switch it on.
9. **The Host stays the source of truth.** Activity, status, and the audit
   trail are Host state. The renderer displays them.

## 3. Relationship to remote agent control

Two capabilities now both connect to another machine. They are not the same
capability, and the specifications must not blur them.

| | Connections (`connection.*`) | Remote agent control (`RACP`) |
|---|---|---|
| Question it answers | "Run this on that machine" | "Run *me* on that machine" |
| Where the Agent loop runs | Here | There |
| What lives on the far side | Nothing of ours | A `pi-host`: sessions, turns, tools |
| Who owns the workspace | Nobody; it is the target's own shell | The remote Agent Host |
| Transport | System `ssh`, or a byte stream | `RACP-WS` inside an SSH tunnel |
| Status | Target specification, this document | Implemented target work, ADR 0205 |

A user who wants to drive a project on a remote Linux box interactively wants
remote agent control. A user who wants the local Agent to restart a service on
that box, copy a build artifact to a device, or read a sensor over a serial
line wants Connections. Both may be configured for the same host, and §9
records the convergence point so the two do not grow two incompatible
credential stores.

## 4. Why the layer lives in Rust host-core

The layer is a host-core module, alongside `computer/`, for four reasons.

1. **The output path is already there.** Per-stream budgets, spill-to-file,
   line and byte caps, the timeout ladder, and process-group teardown on abort
   all live in `tools/`. A remote `exec` that reimplemented them in TypeScript
   would diverge in exactly the cases that matter — a command that floods
   stdout, a command that hangs, a turn the user interrupts.
2. **Ownership.** SQLite, the secret store, permissions, and the audit record
   are host-core's. A profile is a persisted record plus a secret; both belong
   there.
3. **The frozen process model.** AGENTS.md §4 keeps Electron Main a thin
   orchestrator and forbids the renderer from reaching SQLite. An SSH
   subsystem in Main would be neither.
4. **Precedent.** `computer/` established the shape: pure logic (geometry,
   parameter parsing, policy) separated from a platform layer, with the
   platform layer absent rather than silently degrading on a platform that
   cannot serve it, and one shared argument parser so a method and its tool
   refuse identical input.

## 5. Transport abstraction

Two capability levels, because the target kinds do not share a shape.

```text
Transport
├── kind:           ssh | serial | telnet | raw-tcp
├── capabilities:   { exec, transfer, stream }
├── probe()                       reachability, authentication, host key
├── exec(command) -> ExecResult   only when capabilities.exec
└── open_stream() -> StreamHandle only when capabilities.stream
```

| Kind | `exec` | `transfer` | `stream` | Credential |
|---|---|---|---|---|
| SSH | yes | yes (SFTP) | yes | key, agent, or password |
| Serial | no | no | yes | none |
| Telnet | no | no | yes | login prompt, or none |
| Raw TCP | no | no | yes | none |

`ExecResult` is the local `Bash` result: `exitCode`, `stdout`, `stderr`,
`truncated`, and the spill path when the budget was exceeded. A non-zero
`exitCode` is not an error.

`StreamHandle` is a bounded, in-memory ring per open stream: bytes in, bytes
out, a scrollback cap, and a monotonic sequence so a reader can tell a gap from
silence. It is not a terminal: there is no cursor, no escape-sequence
interpretation, no alternate screen.

SSH specifics:

- `ssh`, `scp`, and `sftp` are spawned as the system's programs. Windows ships
  `OpenSSH_for_Windows`; Unix uses whatever `ssh` is on the login `PATH`.
- The user's own configuration is not overridden. A profile's explicit host,
  port, user, and identity file are passed as options that take precedence;
  everything else is inherited.
- **Connection multiplexing is not assumed.** `ControlMaster` is unsupported by
  `OpenSSH_for_Windows`, so every call is a full handshake there. A profile may
  request multiplexing explicitly (§7 of the protocol document), and the
  feature reports what it actually got rather than assuming a shared
  connection.
- Host-key policy is per profile and defaults to the strictest useful
  behaviour: an unknown key is refused with the fingerprint for the user to
  accept, and a **changed** key is always a hard stop that requires a person.

Serial specifics:

- Parameters are explicit: port, baud, data bits, parity, stop bits, flow
  control. Defaults are `115200 8N1`, no flow control.
- A serial port is exclusive. Two open profiles on one port is a refusal, not a
  race.
- Port enumeration and opening are platform work. Where the platform layer is
  absent the transport reports unsupported; it never reports an empty success.

## 6. Profiles and trust

A profile is a named record:

```text
ConnectionProfile
├── id, label, kind
├── enabled            per-target switch, default off
├── target             host/port/user, serial parameters, or address
├── credentialRef      secret-store handle; never the secret
├── hostKeyPolicy      strict | accept-new | pinned fingerprint
├── limits             timeout, output budget, stream cap
└── lastProbe          status, timestamp, failure reason
```

Trust is expressed by what the record holds, not by a ranking:

- A profile the user created and enabled is exactly as trusted as the user
  decided it is. There is no "trusted" flag the Agent could raise.
- Limits are per profile so a production host can be given a shorter timeout
  and a smaller output budget than a scratch box.
- A disabled profile is not merely unlisted; a call naming it is refused with
  its own code, so a model holding a stale list learns why.
- The set of profiles is Host state, visible to the user in the destination and
  in the settings card. The Agent sees ids and labels only.

## 7. Tool surface

Two tools, split by handle rather than by target kind.

| Tool | Actions | Handle |
|---|---|---|
| `Connection` | `list`, `probe`, `exec`, `read`, `write`, `upload`, `download`, `stat` | one connection profile |
| `Console` | `open`, `send`, `recv`, `close` | one open byte stream |

One tool per *handle* follows the `Computer` precedent: its actions share one
coordinate space and one window handle, so nine definitions would have put nine
copies of the same context into every prompt. Here the two halves share
nothing — a request/response call against a profile, and a stateful byte stream
— so folding them together would make an action vocabulary in which half the
entries are unavailable depending on the target, which is precisely the thing
the model gets wrong.

Both tools are rated `Risk::High`, so Plan and Goal contracts deny them
outright, and both are gated by §8.

`exec` returns the local `Bash` result shape. Remote output reuses the same
budgets and the same spill mechanism, spilling into the local scratch
directory, because the spill file is read back by the local `Read` tool.

## 8. Gating model

Three doors, one predicate, following D659.

| Door | When the switch is off |
|---|---|
| Agent-facing `connection.*` methods | refused with `1029 CONNECTION_DISABLED` before any transport work |
| `tools.list` | `Connection` and `Console` are withheld |
| `tools.execute` | refused even when the model holds a definition from an earlier turn |

The predicate reads two values: the global `remoteControlEnabled` setting and
the named profile's own `enabled`. A refusal names which one closed the door —
`1029` for the global switch, `1031` for the profile — because those call for
different remedies.

**Profile management is not behind the switch.** Creating, editing, and
deleting a profile is a user action in the interface; it is served by
user-facing `connection.*` methods that the Agent cannot call. Those methods
are still governed by host-core's ordinary permission and role rules, and every
one of them is audited.

## 9. Credentials and convergence with the bootstrap path

Secrets live in the host's secret store under a reference the profile holds.
The reference is what a profile read returns; the value is never returned to
the renderer, never enters a tool result, and never enters an audit record.
Audit rows carry the profile id, the action, the exit code or byte count, and
the time — not the command's arguments when the argument is itself a secret,
and never the credential.

The desktop already holds SSH material in one place for another purpose: the
`pi-host` bootstrap in `apps/desktop/electron/main/remote/` spawns the system
`ssh` and can store an encrypted login password for a host that authenticates
with one rather than a key. The convergence point is the profile record: a
later milestone may let one profile serve both the target work here and the
remote-host bootstrap, so a user with one machine configured twice ends up with
one entry. That is recorded so the two do not grow two credential stores in the
meantime; it is not part of the first milestone.

## 10. Explicit exclusions

These are requirements, not omissions.

- **No terminal emulation.** No VT/xterm state machine, no escape-sequence
  interpretation, no cursor addressing, no alternate screen, no split panes.
  A user who wants a terminal already has one on this machine.
- **No session manager.** No tab bar of live logins, no per-session
  reconnect-and-restore policy, no session grouping.
- **No file-transfer protocol implementation.** XModem, YModem, and ZModem are
  not implemented; file transfer is SFTP over SSH only.
- **No X11 or agent forwarding, and no dynamic or reverse port forwarding** in
  the first milestone. A profile may request a forward; the listener that
  results is the spawned `ssh` child process, never a socket the host opens.
- **No arbitrary protocol server.** A raw TCP profile connects out; it does not
  bind, listen, or accept.
- **The Agent cannot manage profiles.** §8.

## 11. Milestones

| Milestone | Content |
|---|---|
| R1 | Profile storage and migration; the settings card; the `Connections` destination with list and detail; SSH transport; `exec` and `list`; the gating model; audit; error codes; documentation; E2E |
| R2 | File transfer over SFTP: `upload`, `download`, `read`, `write`, `stat`, with binary safety and a per-profile size cap |
| R3 | Connection reuse as an explicit per-profile option, with the negotiated mode reported back; port forwarding via a spawned `ssh -N` child |
| R4 | The `Console` tool and the byte-stream transports: serial, telnet, raw TCP |

R1 deliberately excludes file transfer. SFTP is a second transport path with
its own failure modes, and folding it in would double the milestone without
proving the model.

## 12. Acceptance criteria

1. A profile can be created, listed, edited, enabled, and deleted from the
   interface, and survives a restart.
2. With the global switch off, no Agent-facing `connection.*` method succeeds,
   neither tool appears in `tools.list`, and a `tools.execute` call naming one
   is refused — the same three-door behaviour the `Computer` tool has.
3. With the global switch on and a profile disabled, a call naming that profile
   is refused with the profile code, and other profiles still work.
4. `exec` against an SSH profile returns stdout, stderr, and the exit code, and
   a non-zero exit code is not reported as an error.
5. Remote output that exceeds the budget is truncated with the same marker the
   local `Bash` tool uses, and spills to a file the local `Read` tool can open.
6. A turn interrupted while a remote command is running terminates the spawned
   process tree; no `ssh` child outlives the turn.
7. An unknown host key is refused with its fingerprint; a changed host key is
   refused and requires a person to accept it through the interface.
8. No Agent-facing method, tool result, or audit row contains a credential.
9. `exec` against a serial, telnet, or raw TCP profile is refused by name,
   without attempting a connection.
10. A profile managed by the user cannot be created, edited, enabled, or
    deleted through any Agent-facing method.
11. The renderer reaches profiles only through the IPC surface; no renderer
    code opens SQLite or spawns a process.
12. Rust host-core continues to bind no network port, including while a profile
    is connected.

## 13. Related

- `01-product/01-product-scope.md` — where this sits in the current phase.
- `01-product/02-non-goals.md` — terminal emulation and the other exclusions.
- `03-runtime/23-connections-protocol.md` — the methods, the tools, and the
  error codes.
- `05-security/03-connections-security.md` — the threat model and the
  boundaries this must not weaken.
- `02-architecture/05-remote-agent-control.md` — the neighbouring capability,
  and why §3 separates them.
- ADR 0320, ADR 0203, ADR 0205.
