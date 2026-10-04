# Connections Security Specification

- Status: Target specification; not implemented
- Decision: D660 / ADR 0320, extended by D661 and D662
- Applies to: the `connection.*` method domain, the `Connection` and `Console`
  tools, and the profile record they act on
- Does not weaken: the local MCP boundary (ADR 0203), the remote agent control
  boundary (ADR 0205), the plugin sandbox, or the provider-secret boundary

## 1. Security goals

The capability MUST provide:

1. a principal that cannot widen its own reach — the Agent may use a target a
   person enabled, and may not create, edit, enable, or delete one;
2. credential confinement — a password or key material never enters a model
   context, a tool result, a log line, or an audit row;
3. host-key integrity — an unknown key is a refusal with a fingerprint, and a
   changed key is never accepted by any method call;
4. no new inbound surface — host-core binds no port, and this capability adds
   none;
5. bounded resource use — every operation has a timeout, an output budget, and
   a process tree that is terminated with the turn that started it;
6. an audit trail that records refusals as well as executions; and
7. safe defaults — off until switched on, per target and globally.

The design assumes the Agent can be prompt-injected. A prompt, a tool result, a
file on a target, or model output is untrusted data and MUST NOT grant an
authority the authenticated principal does not already have. In particular,
text arriving from a target is data, never an instruction, and never a reason
to reach a second target.

## 2. Trust zones and data flow

```text
┌──────────────────────────┐
│ Renderer                 │  user intent only; no secrets, no SQLite
│  Connections destination │
└───────────┬──────────────┘
            │ typed IPC (existing surface)
┌───────────▼──────────────┐
│ Electron Main            │  thin orchestrator; no SSH subsystem of its own
└───────────┬──────────────┘
            │ stdio NDJSON JSON-RPC (existing)
┌───────────▼──────────────┐        spawn        ┌────────────────────────┐
│ Rust host-core           │ ──────────────────▶ │ system ssh / scp /     │
│  connection/             │                     │ sftp (child process)   │
│  profile store + policy  │                     └───────────┬────────────┘
│  secret store (existing) │                                 │
└──────────────────────────┘                                 ▼
                                                 ┌────────────────────────┐
                                                 │ user-owned target      │
                                                 │ remote shell, device   │
                                                 └────────────────────────┘
```

| Zone | Trust assumption | Required boundary |
|---|---|---|
| Renderer | untrusted for secrets; may show a profile but never a credential | the existing typed IPC surface; no direct store or process access |
| Electron Main | trusted orchestrator, not a credential authority | forwards calls; stores no target secret of its own for this path |
| Rust host-core | the policy and secret authority for this capability | profile validation, the gating predicate, audit, process teardown |
| Spawned `ssh` child | untrusted execution agent of a trusted binary | argv only; a password travels through the askpass helper, never argv |
| Target | hostile by assumption | output is data; no credential is forwarded; no second target is reachable from it |
| Secret store | the only place a secret exists at rest | encryption at rest through the existing mechanism |

## 3. What this does not change

The capability is often described as "letting the Agent onto other machines",
which invites the wrong conclusion. Stated precisely:

- The `Bash` tool can already run `ssh host '…'` on this machine. The
  capability does not make a new category of reachable machine reachable. It
  adds a named, policy-bearing record and an audit trail to a path that exists.
- No new permission is introduced. The two tools are `Risk::High` and follow
  the existing Plan and Goal rules.
- No network listener is added. host-core still binds nothing, and a port
  forward is a child process's listener rather than the host's.
- No renderer capability is added. The renderer still cannot reach SQLite, and
  still cannot spawn a process.
- No credential is duplicated. Where the desktop already stores SSH material
  for the `pi-host` bootstrap, §6 states the convergence rule rather than
  creating a second store.

## 4. Threats and required behaviour

### 4.1 A proxy-injected Agent reaches a target

**Threat.** A poisoned tool result, a file on the target, or a provider response
instructs the Agent to run a command on another host.

**Required.** The gating predicate (§5) is evaluated per call against Host state
the Agent cannot write. A target the user has not enabled is refused by name.
A global switch that is off refuses everything. The Agent has no method that
creates or enables a profile, so it cannot promote a target into reach.

### 4.2 Credential exposure

**Threat.** A password, a private key, or a passphrase reaches a model context
through a result, an error detail, or a log line.

**Required.** §6.

### 4.3 Host-key substitution

**Threat.** An intermediary presents its own key, or a previously trusted host
presents a changed key.

**Required.** Every probe returns the presented fingerprint and whether it was
known. `strict` refuses an unknown key. A **changed** key is refused on every
policy, and clearing it is a user action in the destination — never something a
method call, an `exec`, or a retry can resolve. An `accept-new` profile records
the key once and is strict from then on.

### 4.4 Hostile output from the target

**Threat.** The target returns data crafted to look like instructions, to open
a second connection, or to exhaust memory.

**Required.** Output is data. It is budgeted (§7), truncated on the same rule the
local command tool uses, and spilled to a file rather than buffered without
limit. A stream that overflows its ring reports a gap instead of silently
dropping bytes. Nothing in the output path interprets a byte as a decision.

### 4.5 Exfiltration through the connection

**Threat.** The Agent uses a target as an exfiltration channel for local data —
uploading a file the user did not intend to leave the machine.

**Required.** `upload` resolves its local path inside the session workspace and
the scratch directory only, on the same rule the local `Read` tool applies to a
path. A path outside both is refused. The audit row records the transfer, its
direction, and its byte count. Workspace-ignore rules
(`15-workspace-ignore-rules.md`) are consulted before an upload of a path they
cover.

### 4.6 Resource exhaustion and orphaned processes

**Threat.** A hanging remote command, or a target that accepts input forever,
outlives the turn and burns the machine.

**Required.** Every operation carries a timeout, clamped to the profile limit
and the host maximum, and a timeout is a refusal rather than an exit code. The
spawned process tree is terminated on the same path that terminates a local
command when a turn is aborted, and the teardown covers the tunnel children a
forward may have created. A stream is closed when its session is disposed, when
its profile is disabled, when the global switch is turned off, and on host
shutdown.

### 4.7 A serial device as a side channel

**Threat.** A serial port drives hardware whose effects are physical and not
observable through the result — the one target kind whose failure mode is not
in the data returned.

**Required.** A serial profile is off by default on the same rule as every
other, carries the same audit trail, and is subject to the same timeout. The
destination states in the profile detail that a serial action can change
physical state, so the record the user approves is the record that describes
what it can do. Port ownership is exclusive: an already-open port is a refusal
rather than a race against another holder.

## 5. The gating boundary

```text
allowed(profileId) = settings.remoteControlEnabled && profile.enabled
```

The predicate is read at three doors and is the same function at all three: the
Agent-facing method, the `tools.list` listing, and the `tools.execute`
dispatch. Two files implement it — the method registry and the tool registry —
and a test asserts they agree, because D659's defect class is exactly a listing
door and an execution door that drift apart.

The switch is Host state. The Agent has no method that writes it, and no method
whose name resembles a settings write is exposed on the Agent surface.

Profile mutation is a user capability and is not behind the switch, since it is
how a person turns a target on. It is, however, still a privileged mutation: it
is subject to the host's ordinary role rules and it is audited.

## 6. Secret handling

| Rule | Statement |
|---|---|
| Storage | a credential lives in the existing secret store, encrypted at rest, under a reference the profile holds |
| Return | no Agent-facing method returns the reference or the value; the user-facing surface learns only that a credential is configured |
| Transport into the child | through the askpass helper, never as an argv element, never through the environment |
| Tool results | never included, including in an error detail and including when the failure *was* an authentication failure |
| Logging | never logged; a redaction step guards the spawn path's own output, as the existing bootstrap path already does |
| Audit | never written; an audit row carries the profile id, the action, the outcome, and counts |
| Display | the destination shows whether a credential exists and its kind, never its value |

An authentication failure returns `1034 CONNECTION_AUTH_FAILED` with the
profile named and nothing about the credential. A caller cannot use the error
surface to distinguish "wrong password" from "wrong key" beyond what the
transport itself reported, so the error cannot be used as an oracle for the
stored secret's shape.

## 7. Bounds

| Resource | Bound | Applied where |
|---|---|---|
| Command wall clock | profile limit, clamped by the host maximum | before the child is spawned |
| stdout | first N bytes, then truncated with a marker | drain, same rule as local |
| stderr | last N bytes, then truncated with a marker | drain, same rule as local |
| Spill file | one per truncated stream, in the local scratch directory | overflow |
| Stream ring | profile `streamBytes`, default 64 KiB per stream | on write into the ring |
| Open streams | one per session per profile | on `open` |
| Transfers (R2) | profile size cap, default 64 MiB per file | before the transfer starts |

A profile's limit may lower a host bound; it can never raise it. The effective
bound is the minimum, and the result reports it when it differs from the host
default, so a caller that received less than the default knows why rather than
suspecting a silent failure.

## 8. Safe defaults

- The global switch is off. A fresh installation has the capability closed.
- A new profile is disabled. Creating a target does not make it reachable.
- A new profile's `hostKeyPolicy` is `strict`.
- A new profile's `multiplex` is `per-call`, so no shared connection exists
  unless the user asked for one.
- Deleting a profile deletes its secret in the same operation; no orphan secret
  survives a delete.
- Turning the global switch off closes every open stream and refuses every
  subsequent Agent-facing call, including one already holding a profile id.

## 9. Failure behaviour

| Failure | Required behaviour |
|---|---|
| Global switch off | `1029`; no transport work, no connection attempt |
| Profile disabled | `1031` naming the profile; no connection attempt |
| Unknown profile id | `1030`; distinguishable from a disabled profile, because the remedies differ |
| Unknown host key | `1033` with the fingerprint; the profile's `lastProbe` records the refusal |
| Changed host key | `1033` with `kind: "changed"`; clearing it requires a person in the destination |
| Authentication rejected | `1034`; nothing about the credential in the result, in a log, or in an audit row |
| Target unreachable | `1032` with the stage named; retriable |
| Timeout | `1035`; the process tree is terminated before the error is returned |
| Transport has no `exec` | `1037`, decided before any connection attempt |
| Platform has no implementation | `1036`; reported rather than returning an empty success |
| Secret store unavailable | the profile cannot be used for authentication; reported as a refusal, never by falling back to an unencrypted store |
| Turn aborted | the spawned tree is terminated with the turn; no child outlives it |

## 10. Verification requirements

Security properties that a reviewer must be able to check by execution:

1. With the switch off, each Agent-facing method and each tool returns the
   documented code, and `tools.list` omits both tools — asserted at both doors
   in both switch states.
2. A profile cannot be created, edited, enabled, or deleted through any
   Agent-facing method — enumerated exhaustively, not sampled.
3. No Agent-facing result, audit row, or log line contains the credential, on
   success and on authentication failure.
4. A probe returns the fingerprint; an unknown key under `strict` is refused;
   a changed key is refused under every policy by every method.
5. An aborted turn leaves no spawned `ssh` process on either side of the tree.
6. Truncated output produces the same marker and a spilling file the local
   `Read` tool can open.
7. host-core holds no listening socket while a profile is connected and while a
   forward is active.
8. An `upload` of a path outside the workspace and the scratch directory is
   refused on the same rule the local `Read` tool applies.

The end-to-end scenario identifiers for these are recorded in
`06-delivery/04-e2e-test-plan.md`.

## 11. Related

- `02-architecture/06-connections.md` — the architecture this secures.
- `03-runtime/23-connections-protocol.md` — the methods and codes.
- `05-security/01-security.md` — the general boundary rules this extends.
- `05-security/02-remote-control-security.md` — the neighbouring capability.
- ADR 0320, ADR 0203, ADR 0205.
