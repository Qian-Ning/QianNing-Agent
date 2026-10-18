---
name: email-inbox-triage
description: an inbox has to be triaged so the person knows what needs them today, without anything being sent on their behalf
---

# Triaging an inbox

Triage is not reading mail. The output is a shorter list of things that need the
person's decision, a set of things already handled, and a record of what was left
alone and why. A triage that ends with "you have 212 unread messages" has done
nothing.

## Three passes, in this order

**Pass one — headers only, no bodies.** Sender, recipients, subject, date,
thread, and the machine-readable headers that identify bulk mail. This is cheap
and it eliminates most of the inbox.

**Pass two — open what survived.** Body, quoted history, attachments. This is
where the time goes, so only spend it on pass-one survivors.

**Pass three — draft, never send.** Every action that produces text produces a
draft, and the person reads it before it goes anywhere.

Do not interleave the passes. The temptation is to open the interesting message
first and follow its thread; that is reading, and it has no stopping condition.

## Urgent versus merely recent

A message is urgent if **any** of these is true:

- it is addressed **to** the person (in `To`, not `Cc`) and asks a question or
  makes a request that has not been answered later in the thread;
- it names a date or a time inside the next five working days;
- it is the last message in a thread where the person owes a reply;
- it says it is blocking someone ("can't ship until", "waiting on your approval");
- it comes from someone the person reports to, or from a named escalation
  contact, and asks for something.

Recency is not urgency. The newest message in a busy folder is usually a
newsletter; the oldest unanswered direct question is usually the one that matters.
Sorted by date descending, the top ten messages are the ten most recent, which is
a different list.

Three buckets, and everything gets exactly one:

| Bucket | Test | Output |
|---|---|---|
| Today | urgent by the list above | a reply draft or a decision requested, with the thread linked |
| This week | needs the person, no deadline inside five days | a task, no draft |
| Read later | informational, or a thread the person is only copied on | archived and labelled, no notification |

Anything that needs no action is archived, not left in the inbox to be re-read.
That includes receipts, shipping notices, automated reports, and calendar
acceptances.

## Threads

A thread is a chain of `Message-ID` values: `In-Reply-To` names the parent, and
`References` lists the ancestors root-first. Use `References[0]` as the thread
key and fall back to a normalized subject (`re:` and `fwd:` prefixes stripped,
case folded) only when the headers are missing — and mark those groups as
uncertain, because two unrelated conversations routinely share a subject and a
reply routinely changes one.

- Act on the last message; the decision usually sits one message earlier.
- A thread where the person is only in `Cc` is not theirs to answer, even when it
  is busy.
- The message that started a long thread is rarely the one that needs a reply;
  check whether the question was already answered further down before drafting.
- IMAP servers expose a `THREAD=REFERENCES` capability, but many do not advertise
  it. Building the grouping yourself from headers is more portable than depending
  on the server's.

## Reading without changing state

Fetch headers with `BODY.PEEK`, not `BODY`. A plain `BODY[]` fetch sets the
`\Seen` flag, so scanning an inbox for triage marks everything read and the person
loses the only signal they had about what is new.

```python
import imaplib

mail = imaplib.IMAP4_SSL(host)
mail.login(user, password)
mail.select("INBOX", readonly=True)          # read-only mailbox: no flag changes at all

status, data = mail.uid("search", None, 'SINCE 12-Oct-2026 UNSEEN')
uids = data[0].split()

fields = "(BODY.PEEK[HEADER.FIELDS (FROM TO CC SUBJECT DATE MESSAGE-ID REFERENCES LIST-ID AUTO-SUBMITTED)])"
for uid in uids[:50]:
    status, parts = mail.uid("fetch", uid, fields)
    print(uid, parts[0][1].decode("utf-8", "replace")[:400])
```

`select(..., readonly=True)` is the stronger guarantee: no flag can change, so an
accidental fetch cannot mark anything read. Use it for every pass that is not
deliberately modifying the mailbox.

## Noise you can classify from headers

- `List-Id` present, or `List-Unsubscribe` present — bulk mail, not a person.
- `Auto-Submitted: auto-generated` or a `no-reply`/`do-not-reply` sender —
  automated; there is nobody to answer.
- `Precedence: bulk` or `Precedence: list` — same.
- `Content-Type: multipart/report` — a bounce or a delivery report. Read only if
  the person recently sent something that could have failed.
- A calendar invitation (`text/calendar`) is a decision, not a reply: surface it
  as accept/decline, and do not answer it in prose.

These five rules remove the majority of a typical inbox without opening a body,
which is the point of pass one.

## What to draft, and what to leave alone

Draft when the reply is one of:

- an acknowledgement with a specific next step ("got it, I'll send the figures by
  Thursday");
- an answer that is already in the thread, quoted back with the relevant lines;
- a scheduling reply offering two or three concrete slots;
- a status update the person has already stated elsewhere in the thread;
- a short question that unblocks the sender.

Do not draft when the reply would:

- commit money, headcount, a legal position, or a delivery date the person has
  not stated — ask instead;
- be the first contact with an external person, where tone is the person's own;
- sit inside a thread with conflict or a sensitive personal matter;
- answer a message you do not fully understand;
- require a decision the person has not made yet — draft the *question to the
  person*, not the reply to the sender.

Keep drafts short: one question, no invented facts, the specific ask quoted back,
and any uncertainty written into the draft rather than smoothed over. Three
sentences that are true beat a paragraph that sounds confident.

## Never send

The rule is absolute: **the person sees the text before it is sent.** Not "the
person approved sending a reply" — the exact text, in a form they can read,
including the recipient list and the attachments. A draft is a proposal.

That means:

- no sending from triage, at all, even for a one-line acknowledgement;
- reply to the sender by default; `Reply All` is a separate, explicit decision
  per draft, because a wide recipient list is how a private remark reaches a
  customer;
- no unsubscribing, no filter creation, no mailbox reconfiguration, no deletion —
  those are decisions about the person's account, not about a message;
- when a message must be answered today and no draft is possible, say so and
  surface it at the top with the deadline, rather than improvising.

## The output

A short report, in this shape:

1. **Today** — at most five items. For each: who is waiting, what they need, the
   deadline if any, and the draft id or the decision required.
2. **This week** — the rest of the "needs the person" set, one line each.
3. **Handled without you** — counts by rule ("14 bulk, 6 notifications archived"),
   not a list.
4. **Left alone deliberately** — the threads you chose not to touch, with the
   reason. Sensitive threads, anything ambiguous, and anything where a wrong
   draft would be worse than no draft.
5. **The window** — mailbox, date range, and the number of messages examined, so
   the person knows what was not looked at.

If the inbox is too large to triage in the time available, say that, and report
the fraction you covered. A complete triage of 40 messages is useful; a partial
triage of 400 that does not say so is misleading.

## Where this goes wrong

- Sorting by date and calling the newest ten urgent.
- Opening messages with a full fetch and marking the whole inbox read.
- Drafting a confident reply to a question the thread answered three messages ago.
- Grouping by subject line and merging two unrelated threads into one action.
- Answering on behalf of someone who was only copied.
- Sending. Ever, without the person having read the exact text.

## Origin

QianNing Agent. Written in this repository; no third-party method, text, or document format is reproduced here.
