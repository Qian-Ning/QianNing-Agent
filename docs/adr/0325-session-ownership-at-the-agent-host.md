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
   a caller's path records that caller's subject. **This corrects the recorded
   plan once**: it said "the local desktop's own principal is the owner of the
   sessions it creates". The local subject is stable, but it is a module-level
   literal in the desktop's Electron bridge and is not visible to the Agent Host
   module, and the headless root has no local-principal concept at all, so the
   local creation path leaves `owner` null and the local principal reaches those
   rows through the `owner` role it already holds (decision 3). This is the
   smallest change that gives the ownership check something to compare against.

2. **Enforce ownership host-side, in the Agent Host module.** The check is a
   private admission step in the Agent Host (`requireSession`,
   `packages/agent-host/src/agent-host.ts`) applied by every session-addressed
   operation. It is a Host property: the messaging adapter is not consulted, so
   a second caller cannot bypass it.
   - `attach`, `startTurn`, `history`, `snapshot`, `subscribe` with `scope:
     "session"`, and `cancelSessionMessage` address a session by id. Each of
     them re-reads the session row and applies the comparison. **This corrects
     the recorded plan**, which named none of `history`, `subscribe`
     (`scope: "session"`) or `cancelSessionMessage` and assumed every
     session-addressed operation already resolved the session through
     `requireSession`. None of the three did — each went straight to
     `this.state(id)`, which *creates* a state entry on demand for any id — and
     `subscribe` was synchronous, so it had no way to resolve a durable row at
     all. `subscribe` is now asynchronous for the session scope, and its callers
     await it.
   - The operations that address a turn — `stopTurn`, `interruptTurn`,
     `cancelTurn`, `prioritizeTurn`, `reorderTurn` — and the two that address an
     approval or an input request — `respondApproval`, `respondInput` — take no
     session id. **This corrects the recorded plan a second time**: it said they
     "resolve the session first", but they resolved it from `stateForTurn`, a
     lookup in the in-memory `turnIndex`, and fell back to the same
     create-on-demand `state(id)`. Nothing on that path compared an owner, and a
     principal that never created the turn could address it with a known id.
     Each of them now resolves the session id from the turn, re-reads the
     durable session row, and asserts ownership before it touches runtime or
     queue state. The in-memory index is routing, not authorization, and no
     longer stands in for one.
   - A principal that is neither the session's owner nor a holder of `owner` is
     refused with `FORBIDDEN` — the code the error table already reserves for a
     missing session scope.
   - **The remote operations the Agent Host module does not itself reach.**
     `session/configure`, `session/fork`, `session/rename`, `session/delete`,
     `session/compact`, `workspace/list|read|diff`,
     `terminal/open|input|resize|close`, and `turn/get` address a session on the
     RACP surface, but their handlers go through the Host operations catalog
     (`packages/racp/src/operations.ts`) rather than the Agent Host module, so
     the module's private admission step never ran for them and the role gate
     was the only gate they met. **This corrects the scope recorded when this
     decision was first written**, which named only the operations that already
     resolved a session through `requireSession`; an adversarial run over the
     real `RacpServer` with a principal holding `controller`, `viewer` and
     `approver` showed every operation above admitted. They are now admitted on
     the one path every RACP caller shares: the RACP server's `dispatch`
     (`packages/racp/src/server.ts`) applies the Host's ownership admission
     once, next to the role gate, before any handler runs. The rule stays the
     Host's — `dispatch` only resolves *which* session an operation addresses:
     the wire `sessionId` for the session-addressed operations, the session the
     terminal belongs to for `terminal/input|resize|close` and for
     `terminal/open` when it carries a `terminalId` (a re-attach — resolved
     through `RacpTerminalAccess.sessionOf`, never the caller-supplied
     `sessionId` beside it), and the session the turn belongs to for `turn/get`
     (through `AgentHost.authorizeTurn`). No handler restates the
     check, and no caller of a handler skips it, because the catalog is
     reachable only through `dispatch`.
   - `getTurn` takes no principal: it serves the RACP `turn/get` operation
     (`RACP_OPERATIONS["turn/get"]`, role `viewer`, HTTP route
     `GET /v1/turns/{turnId}`) and the desktop bridge's own local-principal
     caller. **This corrects a false statement** in this decision as first
     written, which said `getTurn` "is not a RACP operation (it is reached only
     from the Host's own callers)" — it *is* the handler of `turn/get`. It
     carries no session id on the wire, so it is admitted by the same gate
     through [`AgentHost.authorizeTurn`], which resolves the session from the
     turn and re-reads the durable row.

3. **An unowned session is admitted by the `owner` role.** A row whose `owner`
   is null — every pre-existing session, and any session a path creates without
   naming a principal — is admitted to a principal that holds the `owner` role,
   and to a principal whose `subject` equals the recorded owner; the owner value
   may also be null, in which case no subject can equal it. This is the rule that
   ships, and **it corrects decision 3 as first recorded**, which said a
   null-owner row is "reachable only by the Host's own local principal". That
   wording contradicted decision 2 in the same document — decision 2 already
   admits any holder of `owner` to any session, and `owner` is all-access
   (`packages/shared/src/racp.ts`) — and the Host's local principal is not even
   visible to this module (see "Two recorded points this decision corrects"
   below). The rule still fails closed in the direction that matters: a legacy
   row never becomes any-role accessible, and a principal with a foreign subject
   never gains access by the owner value being absent.

4. **Per-session scoped roles are the follow-on, not this step.** The
   specification's own wording is "one or more scoped roles per session" (§6.2),
   so the ownership model should eventually be a per-session role assignment —
   `owner`, `controller`, `approver`, `viewer`, scoped to one session — assigned
   rather than only derived from a single subject. That is the
   specification-aligned enforcement primitive. It is recorded here and deferred:
   it adds a membership table and an assignment lifecycle, and this ADR is the
   smaller change that makes gate 4's Session clause true first. Until it lands,
   ownership is a single subject per session.

5. **The messaging bind also records the owner.** No ownership-transfer
   operation exists and a linked chat principal cannot create a session, so a
   session must become owned as part of the bind the operator already performs.
   The existing host-internal bind write — `bindMessagingInboundSession` in
   `packages/host-runtime/src/messaging-inbound-wiring.ts`, behind the
   `pi-desktop/messagingInbound/bindSession` IPC channel — now also sets that
   session's owning subject to the linked principal's subject, through a
   host-RPC method (`session.setOwner`) that is not a RACP operation. No RACP
   verb and no new remote operation is added; the remote protocol contract is
   unchanged. The owner writer is a **required** parameter of the bind, not an
   optional one: a bind that did not record an owner would leave a linked
   principal unable to reach the session it is bound to, and a caller that
   omitted it would fail to compile. A blank session id, a channel with no
   readable link, and an unknown session id each fail the bind closed with the
   owner write refused and the binding then not written. **This corrects an
   accuracy claim recorded when this decision was first written**, which called
   the bind "all-or-nothing": the owner write and the settings write are two
   writes with no transaction between them, so the bind is not atomic, and a
   bind where the owner write succeeds and the settings write then fails leaves
   the session owned and the conversation unbound. The failure *direction* is
   what makes the shape safe rather than atomicity: an owned-but-unbound
   conversation reaches no inbound command (the driver refuses an unbound
   conversation) and a later bind completes the pair, and no window leaves a
   conversation bound to a session it does not own.

## Two recorded points this decision corrects

**The local desktop principal.** Decision 1 says the local desktop's own
principal owns the sessions it creates. The subject is stable — it is a
module-level literal in
`apps/desktop/electron/main/agent-host-bridge.ts` — but the value is not visible
to the Agent Host module, and the headless root (`apps/pi-host`) has no
local-principal concept at all. So the Host cannot name the local principal, and
the desktop's own creation path
(`apps/desktop/electron/main/ipc/session-ipc.ts`) keeps creating rows with a
null owner rather than threading an Electron constant into host-core. What makes
those rows reachable is the `owner` role the local principal already holds,
which is exactly the rule decision 3 now states. **This corrects the open
question** below, which asked whether the local principal's subject is stable:
it is, and stability is not the problem — the problem is that the value lives in
the desktop bridge and cannot be threaded into host-core without inventing a
second source of truth for it.

**Gate 4 is partly satisfied, not wholly.** `session/list` and `session/get`
(`packages/racp/src/operations.ts`) return every session to every principal that
holds the operation's role. Neither is ownership-filtered, and this change does
not filter them. So gate 4's Session clause is true for *acting on* or
*subscribing to* a session — across every session-addressed operation on the
RACP surface, including the ones the Agent Host module does not itself reach —
and false for *enumerating* one: a principal can still learn that a session
exists and read its metadata. Filtering the catalog
would change `session/list` and `session/get`
responses on the RACP contract, which the migration section forbids, so the
residual is recorded rather than fixed. A second residual follows from the same
place: because the rule is "owner role OR subject equals owner", a principal
holding `owner` is admitted to every session, so the comparison is not a
uniqueness check — it is a floor, not a ceiling. A third residual is scope, not
ownership: the enforcement primitive is a single owning subject, so a principal
holding a non-`owner` role can reach *only* the sessions it owns, and the
"one or more scoped roles per session" the specification words is the deferred
follow-on (decision 4).

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

- Security acceptance gate 4's Session clause becomes true for *acting on* and
  *subscribing to* a session: a principal holding a non-`owner` role for a
  session it does not own can no longer select it or act on it, on either the
  messaging path or the RACP path — including the remote operations
  (`session/configure`, `session/fork`, `session/rename`, `session/delete`,
  `session/compact`, the workspace operations, the terminal operations, and
  `turn/get`) that never passed through the Agent Host module before this pass.
  It stays false for *enumerating* one, because `session/list` and `session/get`
  remain unfiltered (see above).
- The boundary is enforced once for each path a caller can take, and the rule is
  the Host's on both: the Agent Host module admits the operations that reach it,
  and the RACP server's `dispatch` admits the operations that do not, through the
  Host's own `authorizeSession`/`authorizeTurn`. Neither a handler nor a second
  caller restates or skips it.
- The messaging path keeps its "no parallel admission path, no own permission
  policy" property: the ownership check is the Host's, not the channel's.

Costs and risks:

- A first-writer rule is introduced: a session is owned by whoever creates it,
  and this ADR adds no ownership-transfer operation. The ways to change an owner
  are the follow-on role assignment, the messaging bind (which records the
  linked principal as the owner of the session it binds), or a direct settings
  or schema change.
- The check compares subject strings, so identity is only as strong as the
  subject the Host recorded — the residual risk stated above.
- Legacy rows are unowned until assigned or bound. That is safe, and it means an
  existing messaging workflow must be bound once (the bind assigns the owner in
  the same call) and every other existing remote workflow must record an owner
  once. A desktop-local row is unowned by design and is reached through the
  `owner` role.

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
- Existing rows get a null owner and are admitted only to the `owner` role under
  decision 3; no data migration or archive is required.
- The messaging bind, and only the bind, assigns an owner after the fact: it
  records the linked principal as the owner of the session it binds, in the same
  host-internal call, so the messaging path is usable without an
  ownership-transfer operation.
- The RACP contract does not change on the wire: no operation, parameter, or
  error code is added, and `session/list` and `session/get` keep their shape
  (and stay unfiltered). `FORBIDDEN` already exists and already means a missing
  session scope — the widened scope only makes it reach operations that
  previously met the role gate alone. `03-runtime/19-remote-agent-control-protocol.md`
  keeps every operation row and every error code; the enforcement of `FORBIDDEN`
  now covers the whole remote-host profile, which is what that document's
  `FORBIDDEN` row ("Principal lacks the operation or session scope") already
  promised.
- One host-RPC method is added, `session.setOwner`. host-RPC is the host's own
  call path, not a remote surface: `RACP_OPERATIONS` does not name it and the
  RACP server refuses an unknown method before dispatch, so no RACP peer can set
  an owner. `session.create` gains an optional `owner` parameter on the same
  surface, for the same reason, and the RACP `session/create` verb does not send
  it.
- The messaging command vocabulary, the chat-to-principal link record, and the
  settings row are unchanged.

## Open questions

- Whether a session may have more than one owner. The follow-on answers yes,
  through scoped roles; this ADR records one.
- How ownership is transferred, and by which operation. No `session/transfer`
  exists; `session/revoke` and `session/archive` do not change ownership.
  Deferred with the follow-on.
- The local principal's subject: it is **stable** — a module-level literal in
  `apps/desktop/electron/main/agent-host-bridge.ts` — so the question as first
  recorded ("does it resolve to the same subject each time?") is answered yes.
  The real constraint is different and is recorded above: the value is invisible
  to the Agent Host module and the headless root has no local-principal concept,
  so the Host cannot name the local principal without a second source of truth.
  Ownership for desktop-local rows therefore rests on the `owner` role, not on
  the local subject, and whether to thread a local-principal subject into
  host-core is deferred.

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
