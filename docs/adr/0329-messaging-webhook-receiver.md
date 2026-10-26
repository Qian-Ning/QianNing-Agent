# ADR 0329: The shared inbound-webhook receiver as a messaging channel

- Status: Accepted
- Date: 2026-10-26
- Related: [settings information architecture](../spec/04-ux/06-settings-ia.md);
  `packages/agent-host/src/messaging-ingress-receiver.ts`;
  `packages/host-runtime/src/messaging-inbound-wiring.ts`

## Context

The messaging catalogue lists thirty-three platforms. Eleven of them could be
reached and heard from; the rest were honest "not supported" cards. Webhooks is
the one unsupported entry whose infrastructure already existed in both
directions: host-core has an outbound webhook adapter (endpoint, bearer,
retries) and the Agent Host has a complete HTTP receiver — port binding, replay
window, body cap, per-path platform registration, a restart-durable handled
store — that no build ever instantiated.

The receiver's own contract decides what a channel built on it can promise: it
verifies the signature, records the delivery, answers **200 immediately**, and
processes the message after the response. That is correct for platforms whose
retry policy reads the status code, and it means a per-event refusal is not
available to this channel — by the time a delivery could be judged unusable,
the sender has already been told it was accepted.

## Decision

Ship the receiver as one messaging channel, `webhookReceiver`, served from the
`messagingWebhookReceiver` settings section.

- **One shared surface, one path per platform.** The record names a
  `/webhooks/<path>` segment (this build serves `generic`) and the receiver's
  platform table is keyed by it. A future adapter adds a row, not a second
  listener, so one port serves the whole family.
- **The sender's scheme is Standard Webhooks.** HMAC-SHA256 over
  `<timestamp>.<body>`, keyed by one shared secret held in the host's secret
  store under a `secret:` ref, with the message id, timestamp and signature in
  headers. A sender that already signs this way needs no bespoke code, and the
  receiver reuses its existing verifier rather than inventing a second scheme.
- **The binding is a start condition.** A record must name
  `inbound.sessionId` for the loop to start at all. Because an accepted event is
  answered before it is acted on, a listener with no session could only accept
  events it must drop; refusing at start makes the failure a visible
  configuration gap — the panel's Setup dimension already names the missing
  field — instead of a stream of 200s for turns nobody runs. The gate reads one
  dotted path (`inbound.sessionId`); every other channel's fields stay at the
  section's top level.
- **Delivery is fire-and-forget.** One accepted event starts one turn on the
  bound session under the receiver's own principal and holds a session owner
  role, the same identity model the local API channel uses, so no per-session
  ownership write is needed. No reply is followed back to the sender: a webhook
  response is not a chat turn's answer.
- **The panel offers loopback only.** The listener speaks plain HTTP; exposing
  it is a deployment decision that belongs behind a TLS-terminating proxy, not
  a checkbox. `allowNonLoopback` stays in the record for an operator who sets it
  deliberately, and the panel never writes `true`.

## Consequences

An operator can now point any signer at `http://127.0.0.1:8787/webhooks/generic`
and have events become turns. The delivery is at-least-once from the sender's
side and effectively-once here: a repeated delivery id is answered 200 without
starting a second turn.

The channel inherits the receiver's limits rather than working around them: no
synchronous reply, one bound session per record, and no per-event refusal. A
record rewritten while the loop runs is picked up by the supervisor's reconcile
path — clearing the binding stops the listener, rather than leaving it accepting
events it cannot act on.

Adding a second webhook-shaped platform is now a path segment, an adapter and a
panel entry, not new transport code.

This ADR covers the receiving direction only. Host-core's outbound webhook
sender (`messagingWebhook`, endpoint plus bearer token) keeps its own section and
still has no panel card: a card that wrote both sections from one form would be
two records pretending to be one, and the outbound side is not what made the
platform unreachable. Pointing the agent *at* a webhook URL stays a record the
host reads wherever it is written.
