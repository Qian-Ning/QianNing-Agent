# ADR: Yuanbao inbound runs in host-core

- Status: Accepted
- Date: 2026-11-12
- Deciders: QianNing Agent maintainers

## Context

Every inbound messaging channel so far has its loop in the TypeScript host
runtime: `messaging-inbound-supervisor` decides whether a channel may start, and
a transport in `@pi-desktop/agent-host` opens the connection and projects frames
into the shared ingress shape.

Yuanbao does not fit that shape cheaply. Its relay speaks protobuf over a
WebSocket — a handshake with application credentials, a `PushAck` for every
downstream frame, a heartbeat, and a message body carried in a typed element
rather than a JSON field. Writing that once is a week of careful work; writing it
twice, once to send (host-core) and once to receive (agent-host), is a permanent
maintenance cost on the one part of the channel most likely to drift when the
service changes.

## Decision

The Yuanbao loop runs in host-core, next to the sending side, which already owns
the signing and framing for this channel. `crates/host-core/src/messaging_yuanbao`
holds the whole protocol: `proto` (wire shapes), `session` (handshake, ack
discipline, echo rule, projection) and `socket` (dial, authenticate, keep alive).

The TypeScript side keeps two jobs and gains no protocol:

- the start gate in `messaging-inbound-supervisor`, which states what a record
  must contain before a loop may start (relay address, bot account, conversation,
  application id and secret), and
- the gateway row, which lets the panel report whether the loop is running.

## Consequences

- One implementation of the wire. A change to the relay shows up in one crate.
- The seam is complete on both sides: `service::run_configured` starts from the
  settings record and writes one `messaging.inbound` notification per projected
  message, and `bootstrap/startup.ts` subscribes to that method beside the
  supervisor and calls `startTurn` in the session the record names, dropping a
  message id it has already answered. The consumer lives with the supervisor
  rather than in `runtime/host.ts` because that is where the Agent Host and its
  turn surface are already in scope.
- Inbound for this channel does not go through the TypeScript ingress shape at
  the same point as the other channels; host-core surfaces the projected message
  itself. That is the exception this ADR records, and it is scoped to this
  channel: it does not create a second general channel between the layers for
  anything else.
- `session` holds no I/O, so the protocol is tested without a relay; `socket` is
  tested against a local listener that speaks the same frames, which is the
  closest this repo can get while no tenant credentials exist.
- If the service later publishes a documented HTTP API, the loop can move back
  into the TypeScript supervisor and this ADR is superseded rather than amended.
