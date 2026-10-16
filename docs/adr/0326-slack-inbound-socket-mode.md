# ADR 0326: Deliver Slack inbound over Socket Mode

- Status: Accepted for implementation
- Date: 2026-10-16
- Deciders: QianNing Agent maintainers
- Related: ADR 0205 (D375 item 9),
  `06-delivery/07-remote-control-rollout.md` (R3),
  ADR 0325 (session ownership),
  `packages/agent-host/src/messaging-inbound.ts`,
  `packages/agent-host/src/messaging-slack-inbound.ts`,
  `crates/host-core/src/messaging_slack.rs`

## Context

The outbound messaging integration (ADR 0205 D375 item 9, rollout R3) delivers
redacted summaries to webhook, Telegram and Slack, and carries an inbound
command path: a message from a linked chat is mapped by a fixed vocabulary onto
four Host operations — `turn/start`, `turn/stop`, `turn/interrupt`,
`approval/respond`. That inbound path shipped Telegram-first, over an *outbound
long poll*, so the acceptance precondition "the Host opens no inbound listener"
held: the Host originates an HTTPS request; nothing binds or accepts.

Slack was outbound only. Its incoming direction was deferred (`messaging_slack.rs`,
"Slack inbound is deferred"), and the rollout spec likewise deferred "channels
that require an inbound callback". Two ways to receive Slack events exist:

- the **Events API**, an HTTPS endpoint Slack POSTs to — a public inbound
  listener on the Host, which the R3 exit criterion ("the Host has no new
  listener") forbids and which would need a frozen-boundary change and its own
  ADR; and
- **Socket Mode**, in which the Host calls `apps.connections.open` with an
  app-level token and receives a WebSocket URL it then *connects out to*. Slack
  pushes events down that connection; the Host acknowledges each envelope over
  the same socket.

Socket Mode keeps the precondition true (the connection is one the Host
originates) and needs no public endpoint, no TLS termination, and no inbound
port. It is the shape this decision chooses.

Two facts constrain the design. First, the receive-loop driver's cursor is a
numeric poll offset (`MessagingInboundDriver.pollOffset`), which a push transport
has no analogue of: there are no offsets to resume from. Second, the JavaScript
tree already ships a WebSocket client (`ws` is in the lockfile for
`@pi-desktop/racp` and the desktop apps), while the Rust tree has none — so the
incoming direction is a JavaScript concern and belongs beside the inbound driver
in `@pi-desktop/agent-host`, not in `messaging_slack.rs`.

## Decision

**Deliver Slack inbound over Socket Mode, as a push transport the existing
inbound driver serves.**

1. **The driver takes a transport *union*, not a poll shape.** A pull transport
   has `poll(offset, signal)` (Telegram, unchanged); a push transport has
   `start(onMessage, signal)`, to which the loop hands the one handler its
   routing path already uses (`MessagingInboundDriver.handleMessage`) and awaits
   until abort or socket close. The two are told apart structurally, so an
   existing Telegram transport object — one with only `poll` — is still a pull
   transport with no change, and a Slack message and a Telegram message go
   through the *same* routing path. There is no second driver, no second
   admission path, and no change to the four operations, the role gate, or the
   link reader (`readInboundLink` gains optional format/version parameters, both
   defaulting to Telegram's).

2. **The push transport owns its own restart-durable replay guard.** A push
   channel has no cursor to persist, so the cursor — which is what stops a
   restart from replaying on the Telegram side — does not apply. Instead the
   Slack transport keeps a durable guard keyed on the platform's own event id and
   checks it before handling, so a redelivery Slack sends after a restart is
   recognised and not acted on twice.

3. **Acknowledge an envelope only after the message is durably recorded.** Per
   envelope the client: unwraps the `event_callback`, applies strict filters,
   checks the durable guard, handles the message, records it durably, and only
   then acks. A failure to handle, or a failure to record, leaves the envelope
   unacked so Slack redelivers it. This is at-least-once with dedupe; it is never
   at-most-once with loss.

4. **Filters are strict, because Socket Mode input is externally reachable and
   untrusted.** A message event is refused unless: `type` is `message`; it
   carries no `bot_id`; it carries no `subtype` (the plain message case has
   none); its `channel_type` is one of the real conversation types; and it names
   a channel and a timestamp. The app-level token authenticates only
   `apps.connections.open`; the payload is never trusted for its own validity.

5. **No schema change, no migration, no change to the delivery ledger.** The
   durable replay guard rides the existing `app` settings row, under the Slack
   channel's own section (`messagingSlack.inbound.handledEventIds`), exactly as
   the Telegram cursor rides `messagingTelegram.inbound.pollOffset`. The app-level
   token is a new secret ref (`secret:messaging-slack:app-token`); the existing
   `secret:messaging-slack:bot-token` is the outbound credential and is unchanged.

6. **The only new dependency is the `ws` edge into `@pi-desktop/agent-host`**, on
   the version already in the lockfile. Socket Mode is a WebSocket client
   connection the Host originates; no listener is added.

## Consequences

- The Host still opens no inbound listener: Socket Mode is an outbound WSS
  connection, the R3 exit criterion holds, and the Rust `messaging_slack`
  channel is unchanged and stays outbound only.
- The receive-loop driver now has two shapes to reason about, but they are
  distinguished structurally and the poll path is byte-for-byte the behaviour it
  had; every existing Telegram test passes unchanged.
- Inbound Slack shares Telegram's routing, command vocabulary, link reader,
  audit surface and role gate. It adds only the transport, its filters, its
  durable guard, and the ack discipline.
- The two trees differ on purpose: Slack inbound is a JavaScript concern with a
  JavaScript websocket client; the Rust tree has none and now says so plainly.
- Slack's app-level token is a second Slack credential to configure, distinct
  from the bot token the outbound channel already uses.

## Alternatives

- **The Events API.** Rejected: it is a public inbound listener, contradicted by
  the R3 "no new listener" exit criterion and requiring a frozen-boundary change
  and its own ADR.
- **Force Slack into the poll shape.** Rejected: a push channel has no offsets,
  so a synthetic cursor would be a fiction, and the driver would carry a decision
  that belongs to the transport.
- **An in-memory-only replay guard.** Rejected: it cannot recognise a redelivery
  that spans a restart, which is the exact window Slack redelivers in.
