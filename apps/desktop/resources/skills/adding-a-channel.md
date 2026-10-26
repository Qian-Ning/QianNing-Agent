---
name: adding-a-channel
description: a channel, adapter, or third-party integration has to be added to a layered app without forking its transport
---

# Adding a channel to a layered application

Adding a channel looks like a transport problem — connect, authenticate, read
frames, write frames. It is really an interface problem. The channel that ships
cleanly is the one where the new code implements the interface the other channels
implement, and contains nothing the shared layer should own.

The failure mode is visible early and almost always ignored: the new adapter
copies the retry loop, the queue, or the message-formatting branching from the
previous adapter, because "that one already works". That copy is the point at
which the abstraction stopped being one.

## The seam

Three pieces, and the dependency direction is one-way:

```
handler (policy)  →  protocol (frames your app reasons in)  →  client (transport)
                                ↑
                       adapter (translation only)
```

- **Protocol** — the small vocabulary the application itself speaks: a message
  arrived, a message should be sent, a send succeeded, the link went down, a
  capability is or is not supported. It is defined once, in the shared layer, and
  it must not contain any channel's field names.
- **Handler** — policy: routing, authorization, deduplication, retry decisions,
  backpressure, what happens when a send fails. It sees protocol frames and
  nothing else. This is where the logic that every channel needs lives, once.
- **Client** — lifecycle and transport shape: open, close, write, receive,
  reconnect. One implementation, shared.
- **Adapter** — maps the channel's wire format and connection semantics onto the
  protocol. Nothing else. If the adapter has an `if` on message type that decides
  application behaviour rather than wire shape, the branch belongs in the handler.

Two tests tell you the seam is real:

1. Replacing the adapter with a fake requires no change to the handler or the
   client.
2. Deleting the adapter compiles — nothing in the shared layer imports it by
   name.

If neither holds, the adapter is not an adapter; it is a second application with
a shared logo.

## Shared layer versus adapter

| belongs to the shared layer | belongs to the adapter |
|---|---|
| identity mapping (channel user → app user) | the field the channel uses for a user id |
| deduplication and idempotency keys | whether the channel redelivers on reconnect |
| retry policy and backoff | the error code that means "rate limited" |
| rate limiting and queueing | the limit the channel enforces |
| logging with a channel tag | the channel's own request id |
| error taxonomy (transient / permanent / auth) | mapping its errors into it |
| attachment size and type rules | how it encodes an attachment |
| command parsing and authorization | how a command arrives (mention, prefix, DM) |
| capability declaration | what the channel actually supports |

The rule that keeps this table honest: **if two adapters would contain the same
lines, those lines belong to the shared layer.** Write the second adapter as if
the first did not exist, then look at the diff between them. Whatever repeats is
a missing abstraction, not a coincidence.

Capabilities are the mechanism that replaces per-channel branching. Each adapter
declares what it supports — threaded replies, editing a sent message, reactions,
attachments, typing indicators — and the UI and handler read the declaration.
A `switch (channel)` anywhere above the adapter is a capability that was never
declared.

## The four wiring points people forget

Implementing the adapter is the easy half. These four are what turn a working
class into a channel a user can actually select, and each one fails in a
different way.

1. **Registration and advertisement.** There is a list — a catalogue, a registry,
   a factory map — that the settings screen and the host enumerate. An adapter
   that is not in it is dead code that passes its unit tests. Check that the
   channel appears in the UI's list, not just that the file exists.
2. **Configuration schema, validation, and secrets.** The channel needs at least
   a token and an endpoint. Without schema validation the failure is a crash on
   first send with `undefined` in the log; with the token stored in plain text in
   a shared config file, the failure is worse and quieter. Add the keys to the
   schema, mark the secret ones, give them defaults where a default is sane, and
   validate before the connection opens so the error names the missing field.
3. **Lifecycle.** Start on launch, stop on quit, reconnect after sleep, and do
   not double-connect when the user saves settings twice. The classic bug is a
   second socket after a laptop resume, which shows up as every message being
   received twice — and deduplication in the shared layer hides it until the day
   it does not.
4. **Inbound authorization.** Who is allowed to make this channel do something?
   The other channels are probably locked to a paired user or an allowlist; a new
   one that accepts commands from anyone who can reach the bot is a remote
   control surface. Wire the same identity check before the first inbound frame
   is dispatched, and test it with an unknown sender.

Then the two that are skipped rather than forgotten: a test that runs the shared
adapter contract against the new adapter, and a page in the docs that says what
the channel supports and what it does not.

## Proving it without a remote server

A fake transport is cheaper than an account, a sandbox, and a rate limit, and it
is the only way to test the failure paths. Implement the same interface as the
real transport, record what was written, and let the test inject what arrives:

```js
export function createFakeTransport() {
  const written = [];
  const listeners = new Set();
  return {
    written,
    onFrame(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    write(frame) { written.push(frame); },
    inject(frame) { for (const fn of listeners) fn(frame); },
    close() { for (const fn of listeners) fn({ kind: "disconnect" }); listeners.clear(); },
  };
}
```

Verified against a client written to the seam above: an 18-line client plus this
11-line fake covered four behaviours in 30 lines of test — outbound text becomes
exactly one protocol frame, an inbound frame reaches the handler, an unknown frame
kind is ignored rather than thrown, and a disconnect rejects the in-flight send.
All four passed; no server was involved.

What the fake does *not* prove, and what therefore still needs a real account
once, manually:

- the handshake and token refresh against the real service;
- the real error codes, which are often documented differently from how they
  behave;
- pagination and history backfill;
- the channel's formatting limits — message length, markdown dialect, how it
  renders a code block;
- behaviour under a real reconnect, including how much history is replayed.

Say which of those you tested and which you did not. "Works against the fake" is
a claim about your adapter, not about the channel.

### The contract suite

Write the adapter tests once, parameterised over implementations, and run every
adapter through it. The suite asserts protocol behaviour only: one send produces
one outbound frame, a failed send surfaces a transient error, a duplicate inbound
frame is deduplicated by the shared layer, shutdown is idempotent. A new channel
that fails the shared suite has found a difference in the abstraction — usually a
capability it does not support — and the fix is to declare that, not to special-case
the test.

## Where this goes wrong

- **A second transport inside the adapter.** Retry loop, queue, or dedupe logic
  copied from the previous adapter. Symptom: two channels behave differently
  under the same network failure, and the bug is fixed twice or once.
- **Field names leaking upward.** A handler that reads `payload.channelData.ts`
  is coupled to one channel; the next one has `timestamp` and the branch count
  doubles.
- **Capabilities discovered at runtime.** The UI offers threaded replies on a
  channel that has no threads, and the error surfaces to the user as a failed
  send rather than a disabled control.
- **Registration forgotten.** Tests pass, the class is constructed nowhere, and
  the channel is invisible. This is the single most common "it works on my
  machine" report for a new integration.
- **Secrets in the shared config.** Written to a file that gets committed,
  backed up, or attached to a bug report.
- **Testing only the happy path against the fake.** The fake exists to test
  disconnects, duplicates, and rate limits; if it only ever delivers a well-formed
  message, it has proved almost nothing.

## Origin

QianNing Agent. Written in this repository; no third-party method, text, or document format is reproduced here.
