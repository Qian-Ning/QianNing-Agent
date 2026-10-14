---
name: technical-runbook
description: a procedure has to be written down so someone else can run it under pressure
---

# Writing a runbook

A runbook is read by someone tired, at a bad hour, who did not write it and
cannot ask you. Write for that person, and assume they will follow it literally
— because when they are frightened, they will.

## Lead with what the reader must know before starting

- **What this procedure accomplishes**, in one sentence, and when it should be
  used. Also when it should **not** be used — the neighboring problem it looks
  like and is not.
- **Prerequisites**: access, roles, permissions, tools and versions, and how to
  confirm each. A step that fails because of a missing permission wastes the
  worst ten minutes of the night.
- **Where credentials live** — the vault, the environment, the password manager.
  Never the credential itself. A runbook is a document that gets shared; a
  secret in it is a breach with a distribution list.
- **Blast radius and time.** What this touches, who is affected, roughly how long
  it takes, and whether it requires a maintenance window.
- **The stopping condition**: what the reader should see when it is done, and the
  point past which they should stop and escalate instead of continuing.

## Then the steps

Each step should have all four parts:

1. **The action** — one action, and the exact command, copy-pasteable. Not
   "adjust the configuration" — the file, the key, the value.
2. **The expected result** — the output, the exit code, the line in the log. The
   reader needs something to compare against, or they cannot tell success from
   silence.
3. **The meaning of a mismatch** — that is the common failure, here is what it
   usually means, here is the next thing to check.
4. **Whether it is reversible**, and how.

Never write "as needed" without saying what need looks like. Never say
"obviously" — the obvious thing is what the reader is too tired to see.

## Order the steps so the irreversible ones come last

Anything that deletes, migrates, overwrites, or cannot be undone goes late, after
everything that could fail safely has already failed safely. And before it, an
explicit checkpoint the reader can stop at.

## Write the rollback before it is needed

- What restores the previous state, with the same precision as the forward path.
- What cannot be rolled back — a schema migration that dropped a column, an
  overwritten file — and what the reader must therefore capture first. Name the
  backup command, and say what a good backup looks like.
- The decision point: if it has gone wrong at step N, is the right move to roll
  back or to continue? Answer that in advance; nobody evaluates calmly mid
  incident.

## Name the tempting shortcut

Every procedure has a step someone will be tempted to skip or a shortcut that
appears to do the same thing faster. Say which one, and what breaks if it is
taken. "Do not run this twice" is worth a line in bold if a second run corrupts
data.

## Verification is its own section

Saying "done" is not verification. Write the check: the endpoint that returns the
expected payload, the row count that matches, the log line that appears only on
a healthy start, and how long to wait before believing the absence of an error.

## Keeping it alive

- **Test it.** Walk the whole thing on a clean environment at least once, and
  record the date you did. An untested runbook is a hypothesis with formatting.
- **Date it and name an owner.** Steps rot; the versions, the paths, and the
  dashboard URLs rot fastest.
- **Update it after every real use**, in the same sitting, from what actually
  happened — including the parts that were wrong.
- **Note the last time it was used in anger.** A procedure that has not run in a
  year is a candidate for deletion, not for trust.

## Origin

QianNing Agent. Written in this repository; no third-party method, text, or document format is reproduced here.
