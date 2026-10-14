---
name: working-with-legacy-code
description: changing code that is old, unclear, untested, or scary to touch
---

# Working with legacy code

The instinct is to clean it up first. That instinct has caused more outages than
most bugs, because the code is usually not badly written — it is written for a
world you cannot see yet. Every strange line was a fix for something, and the
something is not in any ticket.

## Earn the right to change it

- **Do not refactor first.** The code is the specification of current behaviour,
  including the behaviour nobody documented, and it is the only thing that knows
  what the callers depend on.
- Reading before writing is not hesitation; it is the work. On unfamiliar code,
  comprehension is most of the cost, and skipping it just moves the cost to the
  incident.
- **Never mix a behaviour change with a cleanup.** If the change breaks something,
  you cannot tell which of the two did it, and neither can the person reverting it.

## Pin the behaviour before changing it

The technique that makes legacy work tractable is a **characterization test**: a
test that asserts what the code currently does.

- **It asserts the behaviour, not the intention.** Bugs included. You are building a
  net, not a specification.
- **Do not fix anything while pinning.** Fixing changes the test's meaning, and you
  lose the reference point you just built.
- Write them against the seams where you can reach the code: a public function, a
  configuration, a wrapper. Where nothing is reachable, create a seam — a small
  interpolation point — and pin through it.
- Where a piece of behaviour is genuinely wrong and callers depend on it, keep it
  and **say so**: a test asserting the wrong behaviour, with a comment explaining
  that it is deliberate, is far better than a silent fix that breaks a caller.

## Read the data before the code

- The shapes and the states carry more information than the control flow: which
  fields are always present, which are often absent, which combination never
  occurs.
- **The odd rows are where the behaviour lives.** The case that breaks your
  assumptions is the case somebody fixed in 2016, and the fix is the line you were
  about to delete.
- Check what is in the database, the configuration, and the logs before reasoning
  from the source. Reality usually contains a case the source does not mention.

## Find the seams

A seam is a place where you can change behaviour without editing the surrounding
code: a function boundary, an interface, a configuration value, an injection
point, a feature flag.

- **Wrap, do not rewrite.** Put a new implementation in front of the old one, move
  callers across one at a time, and delete the old one when nothing calls it.
- Let the old path remain until the traffic says it is unused. **Log when the old
  path is taken**, and let the absence of that log line over a period be the
  evidence that it can go. A log that never fires proves more than a code search
  ever will.
- **Dead code is rarely provably dead.** Reflection, dynamic dispatch, a
  configuration file, or an external caller can reach things a search does not
  find. Log before deleting, and give it time.

## Change one thing at a time

- One behaviour change per commit, plus the test that pins it. Then the next.
- Where the change is large, **the migration has to be incremental, verifiable, and
  reversible** — running old and new side by side, comparing results, and being able
  to turn it off.
- Compare results against the old path **on real inputs** wherever possible. A
  differential check on production-shaped data catches the cases the unit tests
  were never told about.

## The rewrite temptation

- **"I will just rewrite it" is the highest-risk sentence in this domain.** The
  original is a record of every bug that was found and fixed, encoded in quirks
  nobody wrote down. A rewrite discards the fixes and keeps the bugs that were
  fixed in the behaviour nobody thought to copy.
- Where a rewrite is genuinely right, do it behind a seam with the old path still
  reachable, and keep the ability to go back until the new path has survived real
  traffic.
- Time-box it. A rewrite with no deadline is a project that consumes the team and
  ships nothing.

## Documentation is part of the work

- The map you build while reading is a real deliverable: **what calls what, what the
  shapes mean, which invariants hold, and which parts are known to be fragile.** It
  is the only thing that makes the next change cheaper than this one.
- Record the things you had to discover, in the place the next reader will look —
  the module, not a wiki nobody opens.
- Where you found behaviour that looks wrong but is load-bearing, leave the note at
  the line. Otherwise the next person deletes it.

## The ratchet

- **Every change adds a test.** The suite only grows, and the part of the codebase
  you have touched becomes the part that is safe to touch again.
- Never let a change reduce coverage of the code it touched. A legacy path with one
  new test is more valuable than a rewrite with none.
- Track the seams you have created. Each one is a place future work can go, and the
  count is a reasonable measure of whether the codebase is becoming workable.
- The goal is not a clean codebase. It is a codebase that can be changed — safely,
  incrementally, and by someone other than the person who wrote it.

## Origin

QianNing Agent. Written in this repository; no third-party method, text, or document format is reproduced here.
