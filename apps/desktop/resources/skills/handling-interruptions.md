---
name: handling-interruptions
description: work keeps getting interrupted, or resuming takes longer than it should
---

# Interruptions and context switching

The interruption is rarely the cost. **The reload is.** Thirty seconds of someone
asking a question can cost fifteen minutes of re-establishing where you were,
what you had decided, and what you were about to try — and that is the part worth
managing.

## Leave a note that makes resuming cheap

You resume badly because the state was in your head and the head moved on. The fix
is mechanical: **before you leave the work, write four things down.**

- What I was doing.
- What I had already decided, and why.
- **The next action** — one specific step, not a topic.
- What I was unsure about.

Written in that order, taken in a few seconds. Read when you come back, before
doing anything else. The note is not for posterity; it is for the hour ahead.

## The failing test is the best bookmark

- Where you must stop mid-work, **leave the thing in a state that tells you what is
  wrong**: a failing test, a comment with the failing case and the observed output,
  a task that prints the problem.
- A red check is a to-do that cannot be forgotten, because the suite will not let
  you forget it. A note in a file you might not open is a to-do you will forget.
- Where nothing failing is available, the next action written as an imperative
  sentence — "move the parse step before the validation" — beats a description of
  the area you were in.

## Batch the shallow work

- Messages, notifications, and questions arrive continuously and are each cheap.
  **The cost is the switch, not the task**, so the fix is to switch once.
- Do them in a pass, once or twice a day, rather than as they arrive. Where the
  medium does not allow it, decide the pass and let the channel wait.
- **A five-minute task should be done or logged, never held.** Holding it costs
  more than doing it, and it degrades the work you were actually on.
- Where a question keeps recurring, the fix is not to answer it faster — it is to
  remove the cause: a document, an obvious default, a clearer error message. Recurring
  interruptions are a defect report about the system.

## Protect one run of deep work

- Work that needs a long run cannot be done in the gaps between switches. Find the
  largest uninterrupted block available and protect it, however small it is.
- **Two tasks in progress is already a context switch.** A work-in-progress limit
  is not a management ritual, it is what makes finishing possible.
- Say no by scheduling rather than by refusing: "in an hour" preserves both the
  relationship and the block. Most people accept a time, and the ones who do not
  are telling you something about what they actually need.
- Notifications are a decision, not a fact of the environment. Every one you leave
  on is a switch you have chosen to allow.

## Resuming properly

- **Re-orient before working.** Read the note, look at the state of the tree, run
  the test you left red. Starting to work immediately is how you spend twenty
  minutes on the wrong step.
- Where the work spanned more than a day, expect the first few minutes to be
  overhead and budget for it rather than resenting it.
- Where a boundary is available, stop at it — a completed step, a green test, a
  commit. Stopping mid-edit is the most expensive point to stop, and the one most
  likely to leave a broken state that fails later for reasons nobody connects to
  the interruption.
- Keep work separated by task: one branch, one worktree, one thing. Work mixed into
  one place is work you cannot park, and that is why it cannot survive an
  interruption.

## The end of the day is a special case

- Before stopping for longer than an hour, **write the next action**. It costs a
  minute and turns the next session's ramp-up from twenty minutes into seconds.
- Leave the working tree in a state you would be willing to find: nothing
  half-renamed, nothing left in a condition where a run would produce a confusing
  error.
- Where you stopped for a reason other than the day ending — a blocker, a decision
  needed — write that reason down too. Tomorrow's you will otherwise re-attempt the
  thing that did not work.

## Things that make it worse

- **Holding the plan in your head.** A list outlives an interruption; memory does
  not. Write it down and drop it.
- **Leaving uncommitted work as the only record.** It exists on one machine, in one
  editor, and it is what you lose.
- **Resuming by re-reading everything** instead of reading the note and the failing
  test. The note exists precisely so you do not have to reconstruct from scratch.
- **Treating the interrupt as the problem.** The problem is the resumability. The
  interruptions are a given.

## The test

- Can someone else — or you in three days — pick this up from what you left and
  know the next action?
- If you were interrupted right now, how much of what you know would be lost?
- Is anything in progress that has no written next action?

## Origin

QianNing Agent. Written in this repository; no third-party method, text, or document format is reproduced here.
