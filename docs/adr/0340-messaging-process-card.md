# ADR: A messaging turn shows its progress as one editable card

- Status: Proposed
- Date: 2026-11-01
- Related: [messaging settings](../spec/04-ux/06-settings-ia.md);
  the redactor boundary in `packages/agent-host/src/messaging-redactor.ts`;
  `crates/host-core/src/messaging_outbound.rs` (the delivery ledger)

## Context

A messaging turn currently has exactly one visible event: the final answer. An
answer that takes forty seconds leaves the other side looking at a dead chat,
and there is no way to tell a slow model from a stuck Host.

The pieces that would make a "working on it" card possible already exist, but
each one is in the wrong shape for it:

- **The redactor forbids progress text by design.** `MessagingRedactor` forwards
  structure and metadata and never the text of a turn (ADR 0205, R3). A card that
  shows "调用 read_file" is a change to that boundary, not a formatting choice.
- **The ledger has one intent.** `messaging_outbound.rs` (≈780 lines) owns retry,
  backoff and terminal states for a `{channel, chat, text}` delivery. A card is a
  sequence — create, update many times, replace with the answer — which the
  current state machine cannot express.
- **The remote message id is thrown away.** `sendMessage` returns the id needed
  to edit that message; the adapter discards it, and the Telegram adapter has no
  `editMessageText` at all.
- **A non-delivery side channel now exists.** `messaging.typing` dispatches a
  transient request through the channel adapter and writes nothing to the ledger.
  That is the shape a card's updates should follow, not the delivery queue.

## Decision

**1. A card is a delivery lifecycle, not a second message.** The ledger gains one
intent kind, `card`, with three states: `open` (a message exists remotely),
`updating` (its text is being replaced), `finalised` (the answer replaced the
card, and the row leaves the retry path). The row stores `remote_message_id` and
`last_edited_at`. The existing `send` intent is untouched, so a channel that has
no card support keeps today's behaviour with no changes to its adapter.

**2. What leaves the host is fixed at three fields.** A card update carries:

- `phase`: one of `thinking`, `tool`, `answering`;
- `tool`: the tool's registered name only, never its arguments;
- `note`: one bounded status line, at most 120 characters, produced by the
  redactor from the event's metadata, never copied from model output.

No prompt text, no file path, no tool result, no partial answer. The redactor's
existing rule ("structure and metadata only") is preserved; the card adds a third
category, a *bounded* progress line, with its own cap enforced where the line is
built and asserted in a test that fails if a longer line is emitted.

**3. The final answer replaces the card.** On turn completion the card is edited
to the answer and the row is finalised. There is no "one card plus one answer"
pair, because two messages for one turn is the thing users complain about. If the
answer exceeds the platform's edit limit, the card is left as it is and the
answer is sent as a new message — a truncated answer is never preferable to two
messages.

**4. Updates are coalesced, and a lost update is not an error.** At most one edit
per 1.5 s per card; events that arrive inside that window fold into the next
edit. Platform answers meaning "nothing changed" and "that message is gone" are
both terminal for the card, not retryable: the first has nothing to do, the second
falls back to one plain `sendMessage` for the answer. Card updates are never
retried by the ledger; only the fallback answer is.

**5. Telegram first, Slack second.** Telegram's `editMessageText` covers the
product need and its adapter already exists. Slack's `chat.update` is the second
implementation. Every other channel returns "no card support" and keeps the
current single-message behaviour.

## Alternatives considered

- **Send one message per step.** Rejected: it floods the chat, cannot be corrected
  after a mistake, and the history becomes unreadable.
- **Stream partial answer text into the card.** Rejected: it publishes model output
  before the redactor has seen it, which is the boundary this ADR is explicitly
  preserving.
- **Build the card entirely in the desktop main process, bypassing the ledger.**
  Rejected: the card then has no owner across a restart and no durable state, so a
  crash leaves an "in progress" card that nothing ever finishes.
- **Keep a permanent card per turn.** Rejected: it doubles every conversation's
  message count and needs its own cleanup policy.

## Consequences

- A ledger migration adds the `card` intent, `remote_message_id`, `last_edited_at`
  and a terminal state; existing rows and existing `send` behaviour are unaffected.
- The gateway snapshot gains a per-channel `cardEnabled` flag so the settings page
  can show whether the channel supports it. The UI reads support from the adapter,
  not from a hardcoded list.
- The redactor gains one event kind and the 120-character cap, with a test that
  fails if the cap is exceeded.
- Each card-capable adapter gains two methods (`edit`, `supports_cards`), both with
  a default so existing adapters compile unchanged.
- A card that is never finalised (Host killed mid-turn) is closed on the next boot
  with the text "这条消息没有完成" rather than left spinning.

## Open questions

1. Is the tool *name* allowed to leave the host by default, or only when the user
   turns on "显示过程"? The former is more useful; the latter is a smaller change
   to the boundary.
2. Should the card show elapsed time? It is Host-local data with no privacy cost,
   but it makes the edit cadence user-visible.
3. Is 1.5 s the right throttle for Telegram, or should it follow the platform's
   own rate limit per chat?
