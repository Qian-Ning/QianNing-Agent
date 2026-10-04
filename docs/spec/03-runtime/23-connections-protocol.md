# Connections Protocol

- Status: Target specification; not implemented
- Decision: D660 / ADR 0320, extended by D661 and D662
- Architecture: `02-architecture/06-connections.md`
- Binding: the local stdio NDJSON JSON-RPC transport
  (`01-ipc-protocol.md`, `06-host-rpc-protocol.md`)
- Wire version: unchanged at v11; this document adds methods and tools, not a
  protocol-version bump

## 1. Scope

This document is the normative source for names, arguments, results, error
codes, gating, and tool definitions of the **Connections** capability. It
defines:

- the `connection.*` method domain, split into an Agent-facing half and a
  user-facing half;
- the `Connection` and `Console` agent tools;
- the error codes the domain emits; and
- the audit rows it writes.

It does not define a second transport, a second permission system, or a
protocol-version bump. The methods ride the existing dispatcher, the existing
error envelope, and the existing settings blob; the new persisted record is the
only storage change and it is recorded as a schema migration
(`04-data-storage.md`).

## 2. The profile resource

```jsonc
{
  "id": "0f5c…",                  // stable, opaque, host-generated
  "label": "build-box",           // user-visible, unique per host
  "kind": "ssh",                  // ssh | serial | telnet | raw-tcp
  "enabled": false,               // per-target switch, default off
  "target": { … },                // shape determined by kind, §2.1
  "credentialRef": "conn:0f5c…",  // secret-store handle, never the secret
  "hostKeyPolicy": "strict",      // strict | accept-new | pinned
  "hostKeyFingerprint": null,     // required when hostKeyPolicy is "pinned"
  "multiplex": "per-call",        // per-call | multiplex, §7
  "limits": {
    "timeoutMs": 60000,
    "outputBytes": 262144,
    "streamBytes": 65536
  },
  "lastProbe": null               // §3.2
}
```

`credentialRef` is returned to the user-facing surface so the interface can say
that a credential is configured, and is omitted entirely from Agent-facing
results. The value it names is returned by nothing.

### 2.1 `target` by kind

| kind | fields |
|---|---|
| `ssh` | `host`, `port` (default 22), `user`, `identityFile`, `proxyJump` |
| `serial` | `port`, `baud` (default 115200), `dataBits` (8), `parity` (`none`), `stopBits` (1), `flow` (`none`) |
| `telnet` | `host`, `port` (default 23) |
| `raw-tcp` | `host`, `port` |

`identityFile` is a path, not a secret; it is stored in the profile and may be
returned to the user-facing surface. A login password is a secret and lives in
the secret store under `credentialRef`.

## 3. Agent-facing methods

These are the only `connection.*` methods the `tools.execute` path and the
Agent tool can reach. Every one is gated by §8.

| Method | Idempotent | Meaning |
|---|---|---|
| `connection.list` | yes | enabled profiles, id and label only, with kind and last probe status |
| `connection.probe` | yes | connect, authenticate, verify the host key, disconnect; records `lastProbe` |
| `connection.exec` | no | run one command on the profile and return its result |
| `connection.read` | yes | read a file from the target into the result budget |
| `connection.write` | no | write a file to the target |
| `connection.upload` | no | copy a local file to the target |
| `connection.download` | no | copy a target file to the local scratch directory |
| `connection.stat` | yes | existence, size, and modification time of a target path |

`read`, `write`, `upload`, `download`, and `stat` belong to milestone R2 and
answer `1037`-class refusals until then only if a transport cannot serve them;
before R2 ships they are absent from the method table entirely, so a caller
gets the dispatcher's unknown-method error and does not learn a method that
does not exist.

### 3.1 `connection.probe`

```jsonc
// request
{ "id": "p1", "method": "connection.probe", "params": { "profileId": "0f5c…" } }

// result
{ "id": "p1", "result": {
    "ok": true,
    "durationMs": 412,
    "hostKey": { "algorithm": "ssh-ed25519", "fingerprint": "SHA256:…", "known": true },
    "multiplexed": false
} }
```

A probe is the operation that produces a host-key decision. Its result always
carries the fingerprint the far side presented, whether it was known, and
whether a shared connection was actually obtained. `lastProbe` is the
persisted summary of the most recent attempt, success or failure.

### 3.2 `connection.exec`

```jsonc
// request
{ "id": "e1", "method": "connection.exec", "params": {
    "profileId": "0f5c…",
    "command": "systemctl --user restart build-agent",
    "timeoutMs": 60000
} }

// result
{ "id": "e1", "result": {
    "ok": true,
    "exitCode": 0,
    "stdout": "…",
    "stderr": "…",
    "truncated": false,
    "durationMs": 1203
} }
```

Rules:

1. `command` runs in the target's own login shell. There is no session, no
   working directory carried between calls, and no shell state to inherit —
   the same contract the local `Bash` tool has.
2. `timeoutMs` is clamped to the profile's limit and to the host maximum. A
   timeout is a `1035` refusal, not an exit code.
3. Budgets follow §11. A truncated stream sets `truncated` and names the spill
   file in the same marker the local tool uses.
4. A non-zero `exitCode` is **not** an error. It is the answer.
5. `exec` against a transport without `exec` capability is `1037`, decided
   before a connection is attempted.
6. The spawned process tree is killed when the turn that started it is aborted,
   on the same path that terminates a local command.

### 3.3 Results and Agent-facing redaction

An Agent-facing result never contains `credentialRef`, never contains the
contents of the secret store, and never contains the raw `target` beyond the
non-secret fields. `connection.list` returns:

```jsonc
{ "id": "l1", "result": { "profiles": [
    { "id": "0f5c…", "label": "build-box", "kind": "ssh",
      "lastProbe": { "ok": true, "at": "2026-10-04T12:31:07Z" } }
] } }
```

## 4. User-facing methods

These serve the `Connections` destination and the settings card. They are not
reachable from the Agent tool surface, and the gating switch of §8 does not
close them, because they are how a person opens the switch in the first place.

| Method | Meaning |
|---|---|
| `connection.profiles` | every profile, including disabled ones, with the credential reference as a boolean "configured" |
| `connection.create` | create a profile; validates per kind and refuses a duplicate label |
| `connection.update` | edit a profile; a changed credential is written to the secret store and the old value removed |
| `connection.delete` | delete a profile and its secret; idempotent |
| `connection.setEnabled` | flip one profile's switch |
| `connection.setCredential` | write a secret into the store under the profile's reference |
| `connection.clearCredential` | remove the stored secret |
| `connection.activity` | recent audit rows for one profile, newest first, bounded |

Every one of these is recorded by the audit trail (§10) with the acting
principal. They remain subject to host-core's ordinary permission and role
rules; a role that may not mutate host state may not create a profile.

`connection.create` and `connection.update` validate the whole record before
writing: kind-specific target fields, port ranges, baud against the known set,
label length and uniqueness, and the `hostKeyPolicy`/fingerprint pairing. A
`pinned` policy with no fingerprint is a validation refusal, not a stored
record that fails later.

## 5. The `Connection` tool

One tool with an `action` field, following the `Computer` precedent.

```jsonc
{
  "name": "Connection",
  "description": "…",
  "risk": "high",
  "parameters": {
    "type": "object",
    "properties": {
      "action":   { "type": "string" },
      "profile":  { "type": "string" },
      "command":  { "type": "string" },
      "path":     { "type": "string" },
      "content":  { "type": "string" },
      "localPath":{ "type": "string" },
      "timeoutMs":{ "type": "number" }
    },
    "required": ["action"]
  }
}
```

| `action` | Requires | Dispatches to |
|---|---|---|
| `list` | — | `connection.list` |
| `probe` | `profile` | `connection.probe` |
| `exec` | `profile`, `command` | `connection.exec` |
| `read` | `profile`, `path` | `connection.read` |
| `write` | `profile`, `path`, `content` | `connection.write` |
| `upload` | `profile`, `localPath`, `path` | `connection.upload` |
| `download` | `profile`, `path`, `localPath` | `connection.download` |
| `stat` | `profile`, `path` | `connection.stat` |

`localPath` is resolved inside the session workspace and the scratch directory
only; a path outside both is refused on the same rule the local `Read` and
`Write` tools apply. An unknown `action` is `INVALID_PARAMS`, decided by the
same parser the methods use.

## 6. The `Console` tool

Milestone R4. It owns a stateful byte stream and nothing else.

| `action` | Requires | Meaning |
|---|---|---|
| `open` | `profile` | open a stream, returning a `streamId` and the ring's current contents |
| `send` | `streamId`, `content` | write bytes to the stream, optionally terminated |
| `recv` | `streamId` | return bytes received since the last `recv`, with a sequence range |
| `close` | `streamId` | close the stream; idempotent |

`recv` reports a sequence range so a caller can tell "nothing arrived" from
"the ring overflowed and bytes were dropped". The ring is bounded by the
profile's `streamBytes`; whatever falls out is reported as a gap, never
silently.

A stream is owned by the session that opened it and is closed when that session
is disposed, when the profile is disabled, when the global switch is turned
off, and on host shutdown. It is never reopened implicitly.

## 7. Transport options

### 7.1 Multiplexing

`multiplex` is `per-call` by default: every `exec`, `probe`, and transfer is
its own connection. `multiplex` asks for a shared connection (`ControlMaster`
on the spawned `ssh`). It is **not** the default and the protocol never assumes
it, because `OpenSSH_for_Windows` does not implement it. A probe reports
`multiplexed: true` only when a shared connection was actually obtained; a
profile that asked for multiplexing on a platform that cannot serve it behaves
as `per-call` and says so in the probe result rather than failing.

### 7.2 Host-key policy

| Policy | Unknown key | Changed key |
|---|---|---|
| `strict` | refused, `1033`, fingerprint returned | refused, `1033`, requires a person |
| `accept-new` | accepted and recorded | refused, `1033`, requires a person |
| `pinned` | refused unless it matches the pinned fingerprint | refused, `1033`, requires a person |

A changed key is never accepted by a method call, on any policy. Clearing it is
a user-facing action in the destination.

### 7.3 Port forwarding

Milestone R3. A profile may carry forward definitions. The listener is the
spawned `ssh -N` child process; host-core does not open a listening socket, and
the acceptance criterion in `02-architecture/06-connections.md` §12 that
host-core binds no network port applies while forwards are active.

## 8. Gating

One predicate, read in three places (D659):

```text
allowed(profileId) =
    settings.remoteControlEnabled == true
    && profile.enabled == true
```

| Door | Refusal when closed |
|---|---|
| Agent-facing method | `1029 CONNECTION_DISABLED` (global) or `1031 CONNECTION_PROFILE_DISABLED` (profile), before any transport work |
| `tools.list` | the `Connection` and `Console` tools are withheld entirely |
| `tools.execute` | the call is refused even when the model holds a definition from an earlier turn |

The two files that must agree are the method registry and the tool registry, and
the rule is that the listing predicate and the execution predicate are the same
function. D659's defect class — a model that saw a tool on an earlier turn still
holds its definition — applies here identically.

Reads (`connection.list`, `connection.probe`, the user-facing methods) are not
behind the switch, because they are what let a caller see before it acts.

## 9. Error codes

| Code | Slug | Retriable | Meaning |
|---|---|---|---|
| 1029 | `CONNECTION_DISABLED` | no | the global switch is off; nothing was sent |
| 1030 | `CONNECTION_NOT_FOUND` | no | no profile has that id |
| 1031 | `CONNECTION_PROFILE_DISABLED` | no | this profile's own switch is off; `details.profile` names it |
| 1032 | `CONNECTION_UNREACHABLE` | yes | the target could not be reached; `details.reason` names the stage |
| 1033 | `CONNECTION_HOST_KEY` | no | the host key is unknown or changed; `details.fingerprint` and `details.kind` (`unknown` or `changed`) |
| 1034 | `CONNECTION_AUTH_FAILED` | no | the target rejected the credential |
| 1035 | `CONNECTION_TIMEOUT` | yes | the operation exceeded its timeout |
| 1036 | `CONNECTION_UNSUPPORTED` | no | this transport kind has no implementation here, or the required program is absent |
| 1037 | `CONNECTION_NO_EXEC` | no | the transport has no command channel; use `Console` |

Rules that hold for every code in this table:

1. **The payload travels beside the slug, never instead of it.** A code that
   carries `details.profile`, `details.reason`, `details.fingerprint`, or
   `details.kind` also carries `details.errorCode` with its own slug. This is
   the correction D659's follow-up recorded: a payload field that replaced the
   slug made one failure answer two different codes through the two doors.
2. A non-zero remote exit code is not in this table. It is result data.
3. `1029` and `1031` are user decisions, not host or platform limits; the same
   call succeeds once the corresponding switch is on.

## 10. Audit

Every Agent-facing call and every profile mutation writes one audit row:

```jsonc
{
  "at": "2026-10-04T12:31:07Z",
  "principal": "local-user",
  "profileId": "0f5c…",
  "label": "build-box",
  "action": "exec",
  "outcome": "ok",
  "exitCode": 0,
  "bytes": 1284,
  "durationMs": 1203
}
```

An audit row never contains a credential, a secret-store value, or a command
argument classified as a secret. `connection.activity` returns these rows for
one profile, newest first, bounded, and the destination renders them.

The row is written whether the call succeeded or failed, including the gate
refusals of §8, so "the Agent tried to reach a host while the switch was off" is
itself visible.

## 11. Result budgets and spill

`exec` reuses the local command budget pair: stdout keeps its first budget and
stderr its last, a stream over budget is truncated with the same marker the
local tool writes, and the overflow spills to a file under the local scratch
directory named in that marker. `read` and `download` reuse the read budget.

A profile's `limits.outputBytes` may lower the host maximum; it can never raise
it. The effective budget is the minimum of the two and is reported in the
result when it differs from the host default, so a caller that got less than it
expected knows why.

## 12. Conformance

A binding or implementation of this document must:

1. expose the same method names, arguments, and result fields;
2. emit the codes in §9 with the payload rule in §9.1;
3. apply the §8 predicate identically at the listing door and the execution
   door, verified by calling both with the switch in each state;
4. refuse an action a transport cannot serve before attempting a connection;
5. write an audit row for both outcomes;
6. return the fingerprint on every probe, and never accept a changed host key
   from a method call; and
7. leave the wire protocol version unchanged.
