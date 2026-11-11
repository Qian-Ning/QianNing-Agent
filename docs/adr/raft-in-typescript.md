# ADR: Raft runs in TypeScript on both sides

- Status: Accepted
- Date: 2026-11-12
- Deciders: QianNing Agent maintainers

## Context

Every other messaging channel splits along one line: inbound loops live in the
TypeScript host runtime, and outbound deliveries go through host-core's
`AdapterRegistry`, so the delivery ledger owns retries, attempt counts and the
last error for every send.

Raft does not fit that split. The service publishes its authentication and
installation routes as plain HTTP (`/api/integrations/…`, `/api/oauth/…`), and its
agent credential has a pull-based inbox (`events.receive`) — but the route that
*posts a message* is not documented. It exists only behind
`@botiverse/raft-sdk`, whose program layer exposes
`client.messages.send({ target, content, idempotencyKey })` on top of whatever
HTTP call the SDK makes.

The alternative to using the SDK is guessing a request shape. A guessed shape
passes every fixture test and fails on the first real send, which is worse than an
absent channel: the panel would claim a capability this build does not have.

## Decision

Raft is implemented in TypeScript on both sides:

- **Inbound** is a poll loop over `client.events.receive({ since })`, with the
  cursor doing what it does for the other polling channels. No public webhook is
  exposed, so there is nothing for a self-hosted user to open up.
- **Outbound** uses `client.messages.send` from the same credential, carrying the
  ledger's delivery id as `idempotencyKey`.

`@botiverse/raft-sdk` is pinned to a minor (`^0.34`), because the package is on
0.x: a minor may break, a patch never does.

## Consequences

- **Outbound for this one channel does not pass through the Rust delivery
  ledger.** It has no attempt count, no bounded backoff owned by the host, and no
  ledger row a support question could be answered from. It is the only channel in
  that position, and it is recorded here rather than left to be discovered.
- What replaces the ledger's guarantees, precisely: `idempotencyKey` is the
  delivery id, so a retry the caller makes cannot produce a second message; and a
  failed send surfaces as an error the caller records. What is *not* replaced is
  the attempt ledger itself — a delivery that never reaches Raft leaves no row.
- The removal condition for that debt: if Raft documents its message route as
  plain HTTP, the send path moves into host-core beside every other channel and
  this ADR is superseded.
- The credential is `sk_agent_*` and needs `send`, `read` and `server`
  capabilities, plus `channels` to join a public channel before posting to it.
  Joining is explicit and idempotent — it is never a hidden side effect of a
  send.
