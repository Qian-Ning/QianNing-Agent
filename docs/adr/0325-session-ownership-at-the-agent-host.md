# ADR 0325: Give sessions persisted ownership and enforce it at the Agent Host

- Status: Accepted for implementation; the per-session scoped-role follow-on is deferred
- Date: 2026-10-15
- Deciders: QianNing Agent maintainers
- Related: ADR 0205 (D373 / D374 / D375 / D385), ADR 0285, ADR 0213,
  `02-architecture/05-remote-agent-control.md` §6.2,
  `03-runtime/19-remote-agent-control-protocol.md` (error table),
  `05-security/02-remote-control-security.md` §12

## Context

The messaging integration (ADR 0205 D375 item 9) now carries an inbound command
path. A message typed in a linked chat is mapped by a fixed vocabulary onto four
operations the Agent Host already exposes — `turn/start`, `turn/stop`,
`turn/interrupt`, and `approval/respond` — and invoked through the same
`AgentHost` methods the RACP handlers call, under the linked principal and its
roles (`packages/agent-host/src/messaging-inbound.ts`). The chat-to-principal
link is read from the channel's settings row and fails closed: any way of not
being a complete link yields "not linked" (`readInboundLink`,
`packages/agent-host/src/messaging-inbound.ts`).

That path deliberately performs no session-ownership check, and its own
documentation says so (`packages/agent-host/src/messaging-inbound.ts`, module
note; the landing change records the same gap). The reason is structural:

- The `sessions` table has no owner or principal column
  (`crates/host-core/src/db/schema.rs`).
- `turn_queue.principal` records who *queued* a turn, not who owns the session,
  and a session can carry turns queued by different principals
  (`crates/host-core/src/db/migrations.rs`, the v15 step).
- `session_grants` maps a session id to a list of tool names, not to a principal
  (`crates/host-core/src/state.rs`, `crates/host-core/src/permissions.rs`).
- The authorization gate is role-only. `AgentHost.requireRole` admits an
  operation when `rolesAllowOperation(principal.roles, operation)` is true, and
  `requireSession` only looks the session id up and raises `NOT_FOUND` when it is
  unknown (`packages/agent-host/src/agent-host.ts`; `packages/shared/src/racp.ts`).

So "confirm the principal owns the session" has nothing to compare against
today: a linked principal that holds `controller` for a session it never created
passes the only gate there is.

The specification already requires the boundary this ADR makes true, and does not
yet implement it:

- `02-architecture/05-remote-agent-control.md` §6.2: "An authenticated principal
  receives one or more scoped roles per session."
- `03-runtime/19-remote-agent-control-protocol.md`: `FORBIDDEN` means the
  "principal lacks the operation or session scope".
- `05-security/02-remote-control-security.md` §12, gate 4: "A controller cannot
  select an unauthorized Session, workspace, tool, model, permission mode, or
  provider secret."

The remote-control boundary ADR already fixes the credential model: the only
credential a client holds is a Host-issued device token, and no project-operated
identity may be in the path (ADR 0205, D385).

## Decision

1. **Persist ownership on the session.** Add a nullable `owner` column to
   `sessions` holding the owning principal's `subject`. A session created through
   a caller's path records that caller's subject; the local desktop's own
   principal is the owner of the sessions it creates. This is the smallest change
   that gives the ownership check something to compare against.

2. **Enforce ownership host-side, in the Agent Host module.** The check is placed
   where every session-addressed operation already passes: `requireSession`
   compares the acting principal's `subject` against the session's owner, and the
   operations that address a turn, an approval, or an input request resolve the
   session first and apply the same comparison to the resolved session id
   (`packages/agent-host/src/agent-host.ts`: `stopTurn`, `interruptTurn`,
   `cancelTurn`, `prioritizeTurn`, `reorderTurn`, `respondApproval`,
   `respondInput`). A principal that is neither the owner nor a holder of
   `owner` is refused with `FORBIDDEN` — the code the error table already
   reserves for a missing session scope. The check never lives in the messaging
   adapter: the boundary is a Host property, so a second caller cannot bypass it.

3. **An unowned session is host-local.** A row whose `owner` is null (every
   pre-existing session, and any session a path creates without naming a
   principal) is reachable only by the Host's own local principal. Every other
   principal — including a linked chat principal — must be recorded as the owner
   to act. This fails closed: a legacy row never becomes any-role accessible.

4. **Per-session scoped roles are the follow-on, not this step.** The
   specification's own wording is "one or more scoped roles per session" (§6.2),
   so the ownership model should eventually be a per-session role assignment —
   `owner`, `controller`, `approver`, `viewer`, scoped to one session — assigned
   rather than only derived from a single subject. That is the
   specification-aligned enforcement primitive. It is recorded here and deferred:
   it adds a membership table and an assignment lifecycle, and this ADR is the
   smaller change that makes gate 4's Session clause true first. Until it lands,
   ownership is a single subject per session.

## The named-but-unauthenticated chat principal

The chat link names a principal with a `subject` and a role list
(`readInboundLink`), but that principal presents no credential. ADR 0205 (D385)
says the only credential a client holds is a Host-issued device token and forbids
a project-operated identity. The named principal does not contradict that,
because it is not a client: it is a host-local configuration value — an identity
the Host has chosen to act as — written through the host-internal settings path
that no RACP peer can reach (the operation table names no `settings` verb, pinned
by a test in `@pi-desktop/shared`). Its roles are therefore a delegation of the
Host's own authority, not an authenticated peer's.

This ADR legitimises the model with constraints and records the residual risk:

- The link is read from the channel's settings row and fails closed; an
  incomplete link is "not linked" and reaches no operation.
- The link is written only through the host-internal `settings.set` path, which
  no RACP peer can reach.
- The named principal is now also subject to the ownership check this ADR adds.
- The named principal never holds a device token and cannot reach a non-session
  operation.

Residual risk, with the chosen default: because the named principal presents no
credential, a link that names the owner's subject is indistinguishable from that
owner. The protection is the write path, not proof of possession. The chosen
default is to keep the named-principal model — the messaging capability depends
on it — constrained as above, and to treat the per-session scoped-role follow-on
as the point where a session-scoped grant can be revoked independently of the
settings row.

## The refusal is silent, and that is accepted

When a command is refused there is no reply on the channel today; only an audit
entry. The driver turns the mapper's refusals (`refused`) and any error an
operation raises (`operation-failed`) into `MessagingInboundAudit` records and
sends nothing back (`packages/agent-host/src/messaging-inbound.ts`).

Decision: keep the silence, and record it as the accepted behaviour. The inbound
driver's contract is one-way; it holds no reply channel, and a reply would have
to go out through the outbound messaging path, which relays redacted summaries
and is built to carry no raw transcript content and no error detail (ADR 0205
D375 item 9). A refusal detail on the wire would widen what the Host says, and a
refusal that names a session or a principal would leak exactly the boundary this
ADR is drawing. The audit log keeps the structured record (`refused`,
`operation-failed`, with ids and a refusal kind) without widening the channel. If
a user-visible acknowledgement is ever wanted, it must be a fixed,
non-sensitive vocabulary, not an error string; that is a later decision, not
this one.

## Consequences

Positive:

- Security acceptance gate 4's Session clause becomes true: a principal holding a
  non-`owner` role for a session it does not own can no longer select or act on
  that session, on either the messaging path or the RACP path.
- The boundary is enforced once, in the module both the IPC and RACP callers
  share, so no caller can bypass it.
- The messaging path keeps its "no parallel admission path, no own permission
  policy" property: the ownership check is the Host's, not the channel's.

Costs and risks:

- A first-writer rule is introduced: a session is owned by whoever creates it,
  and this ADR adds no ownership-transfer operation. The only ways to change an
  owner are the follow-on role assignment or a direct settings or schema change.
- The check compares subject strings, so identity is only as strong as the
  subject the Host recorded — the residual risk stated above.
- Legacy rows are host-local until assigned, which is safe but means an existing
  remote or messaging workflow must assign the owner once.

What remains true only by convention:

- That the linked principal is who the link says. Nothing proves possession; the
  write path is the protection.
- Gate 4's other clauses — workspace, tool, model, permission mode, provider
  secret — are enforced by their own boundaries or by Host policy, not by
  ownership, and this ADR does not change them.

## Migration and compatibility

- Schema v23 → v24: `ALTER TABLE sessions ADD COLUMN owner TEXT;`, nullable,
  following the v19 → v20 `system_prompt` precedent
  (`crates/host-core/src/db/migrations.rs`). The migration is purely additive and
  takes the standard pre-migration backup.
- Existing rows get a null owner and are host-local under decision 3; no data
  migration or archive is required.
- The RACP contract does not change: no operation, parameter, or error code is
  added. `FORBIDDEN` already exists and already means a missing session scope.
  `03-runtime/19-remote-agent-control-protocol.md` is unaffected.
- The messaging command vocabulary, the chat-to-principal link record, and the
  settings row are unchanged.

## Open questions

- Whether a session may have more than one owner. The follow-on answers yes,
  through scoped roles; this ADR records one.
- How ownership is transferred, and by which operation. No `session/transfer`
  exists; `session/revoke` and `session/archive` do not change ownership.
  Deferred with the follow-on.
- The local principal's subject and its stability across restarts: the ownership
  check depends on the local desktop's principal resolving to the same subject
  each time. This ADR assumes it does and records the assumption.

## What this decision does not cover

- Per-session scoped roles (deferred, above).
- Ownership transfer, session membership, and the revocation lifecycle.
- The remote-host ownership split across machines (ADR 0205 D375 item 5) beyond
  the local Host.
- A user-visible acknowledgement for a refused command.
- Any change to the RACP wire contract, the command vocabulary, or the messaging
  reply path.

## Alternatives considered

- **Leave the role-only gate.** Rejected: it leaves gate 4's Session clause
  false; that is the gap this ADR exists to close.
- **Derive ownership from existing data.** Rejected: `turn_queue.principal` is
  who queued a turn (a session can carry several), and `session_grants` is
  session-to-tool, not session-to-principal. Neither is ownership, so a derived
  check would be wrong, not merely smaller.
- **Enforce ownership in the messaging adapter only.** Rejected: the gate is a
  Host property; a channel-local check leaves every RACP client unguarded and
  creates the parallel policy the inbound path explicitly avoids.
- **Add the per-session scoped-role table now.** Recorded, not chosen: it is the
  specification's wording and the right end state, but it is a larger change
  (membership table, assignment lifecycle, revocation surface) than the smallest
  change that makes the gate true. This ADR takes the single-owner step first and
  names the follow-on.
- **Default-open for legacy rows.** Rejected: treating a null owner as any-role
  accessible would leave every pre-existing session open, which is the failure
  mode this ADR removes.
- **A separate membership or ownership sidecar table keyed by session.**
  Rejected as the first step: a single owner column is smaller, and the
  scoped-role follow-on subsumes it.
