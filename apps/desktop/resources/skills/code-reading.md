---
name: code-reading
description: an unfamiliar codebase has to be understood before it can be changed
---

# Reading a codebase you did not write

Reading everything is not comprehension; it is exhaustion with a progress bar.
The goal is a map good enough to change one thing safely.

## Start at an entry point, not at the biggest file

Find the path a real action takes: the command, the handler, the route, the
event consumer. Read **that** path end to end before opening anything else.

One traced request teaches more than ten modules read in isolation, because it
gives you the two things modules cannot: order and ownership.

## Read the data before the code

Schema, types, wire formats, and persisted records explain more than the
functions that touch them.

- What is the shape of the central object, and who creates it?
- What is a foreign key here, and what is a copy?
- What is the wire format between processes, and which side owns it?

Code is downstream of data. When the two seem to disagree, the data is usually
right and the code has a special case you have not found yet.

## Read tests as the executable specification

The tests say what the authors believed the behavior **should** be, including the
cases nobody documented.

- The test names map the intended surface.
- The fixtures show realistic inputs.
- A test that pins an odd behavior is a decision, and the commit that added it
  says why.

Where a test and a comment disagree, believe the test.

## Ask git why, not what

`git log -p -- <path>` and `blame` answer questions the code cannot: what was
here before, what the change was reacting to, whether the odd branch is
load-bearing or archaeology.

- An odd line with a linked issue is a decision.
- An odd line with "fix" and no context is usually a workaround someone meant to
  revisit.
- A file rewritten repeatedly is the pressure point — read its history before
  you touch it.

## Find the seams

Comprehension comes from knowing where the outside world enters: filesystem,
network, clock, environment, another process, a user. Draw those boundaries
first.

They tell you what can be tested in isolation, where a failure will surface, and
which of your changes will be felt somewhere you cannot see.

## Follow the error paths

Follow one failure the whole way: what throws or returns an error, who catches
it, what the caller sees, what is logged, what is left half-done.

Error paths reveal the real layering — which layer knows about which — and they
are where a change is most likely to break something silently.

## Answer one concrete question

Reading with a question beats reading with an intention. "If a user renames a
project, what has to change?" is tractable; "understand the project system" is
not.

The answer is the deliverable: name the files, the invariants, and the surprises.

## Write the map down

A short note, for the next person and for you in a week:

- Entry points, and what each is for.
- The central data shapes and who owns them.
- The seams, and what crosses them.
- The invariants that look fragile, and what enforces them (or does not).
- What still confuses you. Name it; unmarked confusion is the thing that bites.

## Stop

Depth is a budget. Once you can answer your question and predict where a change
would land, stop reading and start. Anything you learn afterwards is cheaper to
learn from the change itself, and from the tests that tell you what you broke.

## Origin

QianNing Agent. Written in this repository; no third-party method, text, or document format is reproduced here.
