---
name: dogfood
description: a build is ready to be tried by hand and nobody has yet used it the way a user would
---

# Exploratory QA on a running build

Automated tests check what someone thought to assert. The purpose of using the
build by hand is to find what nobody thought of: the empty state that renders
"undefined", the dialog that cannot be dismissed with the keyboard, the save that
works once and silently fails the second time.

## Start with a charter, not with clicking

A charter is one paragraph and it is written before the app is opened:

- **Area**: the surface under test, named narrowly ("note editing and the save
  path", not "the app").
- **Mission**: what you are trying to break. "Confirm a note survives an edit
  when the window is closed mid-save."
- **Build identity**: `git rev-parse --short HEAD`, the version string, the
  platform, and whether this is a packaged build or a dev run. A finding against
  an unknown build is not reproducible.
- **Time box**: 45 to 90 minutes. Longer sessions lose the thread; several short
  charters beat one long one.
- **Out of scope**: written down, so a missing area is a decision rather than an
  oversight.

Then a coverage list of six to ten areas, ticked as you go. Without the list, a
session becomes the happy path, twice, in a slightly different order.

## Heuristics that find things

Work down this list when the obvious paths stop producing:

1. **Boundaries.** Empty string, one character, ten thousand characters,
   whitespace only, a leading or trailing space, emoji, right-to-left text, a
   name long enough to overflow every container it touches.
2. **Zero, one, many.** No items, exactly one item, more than fits on screen. The
   empty state and the single-item state are the two most commonly unhandled.
3. **First run versus second run.** No configuration at all; stale configuration
   from a previous version; a config file that has been hand-edited.
4. **Interruption.** Close the window mid-save, kill the process mid-write, pull
   the network mid-request, sleep the machine, lock the screen. Then reopen: is
   the state consistent, or half-written?
5. **Repetition and speed.** Double-click submit, hold Enter, click twice before
   the first response lands, drag while a refresh is running.
6. **Layout stress.** Resize to the narrowest sensible width, zoom to 200%, open
   a panel that steals space, use a display at a different scale factor.
7. **Permission and platform.** A read-only directory, a denied OS permission, a
   file name with spaces or a reserved character, a path near the length limit.
8. **Error paths.** Invalid input the server rejects, an expired session, a 500,
   a timeout. The question is not "is there an error message" but "is the app
   still usable afterwards, or is the state now poisoned".
9. **Recovery.** Undo, cancel, retry, back, close and reopen. A feature that
   works but cannot be undone is a trap.

## Capture evidence while it is on screen

- **Screenshot** at the moment of failure, not after navigating away. Name it so
  it survives a shared folder: `save-unicode-step3-empty-list.png`.
- **Logs**: launch from a terminal so stderr is visible, and copy the window
  around the action with timestamps. Note the clock time you performed the step;
  a log excerpt with no anchor is unreadable.
- **Steps**: numbered, starting from a named state ("fresh profile", "signed in
  as the test user", "note with three paragraphs"), including the exact data
  typed. "Typed a long note" is not a step.
- **Frequency**: if it is intermittent, say the count and what differed between
  attempts — 3 of 10, and it happened on the runs where the window had been
  resized.

## Narrow it before you file it

Reproduce from a clean state, then shrink: remove one action at a time until the
failure stops, and put the last one back. The shortest failing sequence is the
single most useful thing in the report, and it is the part a user's own bug
report never contains.

Try one variation to find the real boundary: does the long note fail at 4,000
characters or at the first newline? The answer often names the cause and saves
the developer an hour.

## The defect report

A report is done when a developer can reproduce it without asking you anything.

- **Title** states the behaviour, not a verdict: "Saving a note with a trailing
  space discards the whole note" beats "save is broken".
- **Build and platform**, copied from the charter.
- **Severity and impact**: data loss, crash, blocked workflow, wrong value,
  cosmetic — and who hits it.
- **Steps to reproduce**, numbered from a named state.
- **Expected** and **actual**, in one sentence each. If the expectation is a
  judgement call, say so.
- **Frequency** (always / 3 of 10) and any condition that changes it.
- **Evidence**: screenshot, log excerpt, and the exact data used.
- **Suspected area**, clearly marked as a guess, or omitted.
- **Workaround**, if you found one.

The test of the write-up: every adjective is replaced by a number or deleted.
"Slow", "sometimes", "broken", and "weird" are the four words that guarantee a
follow-up question.

## Close the session with a log

A short table — area, result (pass / fail / blocked), note, evidence file — plus
three lines at the end:

- what you did not cover, and why;
- the three risks you would test next;
- anything that felt wrong but did not fail yet. That list is where the next
  session starts, and it is usually right.

## Where this goes wrong

- Testing only the feature that was just built. The regression is usually in the
  neighbour: the list that reads the same data, the export that shares the
  writer.
- One pass on a dev build and no pass on a packaged build. Packaged builds have a
  different resource path, a different update path, and different permissions.
- Filing five symptoms as one defect. Split them; they will be fixed by different
  people.
- Reporting a console error with no steps. A stack trace is a clue for the
  developer, not a report.
- Declaring the area "tested" without re-running the failing steps after the fix,
  plus one neighbour case to check nothing new broke.

## Origin

QianNing Agent. Written in this repository; no third-party method, text, or document format is reproduced here.
