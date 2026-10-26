# ADR 0332 — Outbound redaction before the provider

- **Status:** Accepted for implementation
- **Date:** 2026-10-26

## Context

A session routinely carries material the user would rather not hand to a model
provider verbatim: connection strings, API keys, phone numbers, ID numbers.
Today every one of those leaves the machine in exactly the bytes the user typed.
The existing `redact`-style helpers are confined to logs, error text, and SSH
paths; nothing touches the provider request body.

pi-ai 1.4.0 exposes `StreamOptions.onPayload(payload, model)`, which every
adapter calls with the body it is about to send. This repository already uses it
for hosted-search replay, request retry repair, and extra provider headers, so a
rewrite hook exists on the path that matters. A local relay process — the shape
other products use — is not required for redaction; it is required for a
different problem (a fixed egress address).

The open question is therefore not *how* to intercept, but *what the product
promises*: which strings count as secrets, what the model sees instead, and what
happens when the rewrite fails.

## Decision

Add an outbound redaction layer in `packages/agent-runtime/src/redaction/` and
install it on the model registry before hosted search is installed.

1. **Matched strings are replaced by typed placeholders.** A placeholder is a
   type prefix plus a 26-character id, wrapped in double braces; the visible
   part looks like `PHONE_01J9Z6…`. The grammar is narrow so ordinary prose is
   never mistaken for a token, and the same secret always maps to the same
   placeholder through a hash-keyed table.
2. **Only string values are rewritten, never object keys.** Keys belong to the
   provider request schema; rewriting one changes the wire contract.
3. **Binary payloads are skipped.** Base64 image and audio data is not text and
   is never scanned.
4. **The table is persisted** at `<data dir>/redaction/mappings.json` with
   owner-only permissions, an expiry, and a size cap. It stores the plaintext
   because restoration needs it; it is never sent anywhere.
5. **Replies are restored** in the stream, including a token split across two
   text deltas, and in the settled message. Tool-call arguments are restored
   after parsing, not in the raw JSON increment, because a restored secret may
   contain a quote.
6. **Failure is closed.** If the rewrite throws, the request fails and the
   provider never receives the body.
7. **The feature is off by default.** The runtime accepts a redaction binding,
   the settings page exposes one switch (`AppSettings.redaction.enabled`), and an
   absent or false value launches no binding: the sidecar never opens the table
   and the request stays verbatim.
8. **The model is told what a placeholder is.** When the rewritten body contains
   at least one token, one sentence is appended to whichever system-level
   surface that payload exposes. Without it a model reads the token as an
   unresolved template and refuses the task — verified against a live provider,
   where the reply said it had no value for the "variable". The sentence is
   added only in that case, so ordinary turns keep their exact prompt and
   providers keep their cache prefixes. An unrecognised body shape is left
   untouched: a missing sentence costs clarity, a guessed request shape costs
   the request.

## Consequences

### Positive

- The provider receives placeholders instead of credentials while the session
  transcript, tool execution, and UI keep the real values.
- No new process, port, proxy, or certificate: the hook already exists and is
  already exercised by two other features.
- The rule table is data, not code paths — narrowing or extending detection does
  not touch the payload walk.

### Negative

- A rule that fires on ordinary text costs the model context and can change an
  answer. The default table is deliberately conservative, and detection of
  generic high-entropy strings is excluded for this reason.
- The mapping table is a plaintext secret store on disk. It is protected by file
  permissions and an expiry, not by encryption at rest; a process running as the
  same user can read it.
- `onPayload` is shared with hosted search, retry repair, and header injection.
  Ordering is load-bearing: redaction must be installed first so it rewrites the
  post-replay body. A future hook installed in the wrong order would silently
  bypass it, so the ordering is asserted by a test.

### Follow-ups

- A dry-run preview that shows what would be replaced without sending.
- Per-rule toggles once real-project false-positive data exists.
- Surface the table size, and a way to clear it, on the same settings row.

## Alternatives

- **Local relay proxy.** Rejected: it solves egress address pinning, not
  redaction, and adds a listener, a trust boundary, and a failure mode to every
  request.
- **Redact at transcript ingestion instead of at the provider boundary.** 
  Rejected: the transcript is also the tool-execution record and the user's
  history; rewriting it would corrupt persisted sessions and require migration.
- **Detect generic high-entropy tokens.** Rejected for the default table: base64
  blobs, hashes, and minified code all look like secrets, and the false-positive
  rate would degrade answers more than the protection helps.
