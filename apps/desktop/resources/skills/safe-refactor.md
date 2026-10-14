---
name: safe-refactor
description: code is being restructured without intending to change behavior
---

# Refactoring without changing behavior

A refactor is a claim: **the same inputs produce the same outputs and the same
side effects, in the same order.** Everything below exists to make that claim
checkable rather than assumed.

## Before touching anything

Write down four things. If you cannot write them, you are not ready.

1. **The structural problem being removed** — one sentence, naming the coupling,
   duplication, or mixed responsibility. "It is ugly" is not a problem.
2. **The invariants that must survive** — the observable behavior, contract, and
   ordering that must not move. These become your tests.
3. **The scope** — the files and boundaries in play, and explicitly what is out.
4. **The completion criteria** — how you will know it is done, and what will no
   longer exist when it is.

## Establish the baseline first

Find the existing tests that cover the invariants and **run them before you
start**, so you know they were green. Where they do not exist and the change
crosses a real boundary, write characterization tests that pin current behavior
— including behavior you privately think is wrong. A refactor preserves bugs
too; fixing one is a separate change with its own test.

## Two kinds of step, never one

- **Behavior-preserving** steps: extract, rename, move, change a type without
  changing values. These should be reviewable by reading a diff of moves.
- **Behavior-changing** steps: the default, the error type, the ordering, the
  null semantics. These need their own tests and their own message.

Interleaving them is how a behavior change ships inside a `refactor` commit, and
how a bisect lands on a commit that says it changed nothing.

## Keep every intermediate state whole

- The tree builds and the suite passes after **each** step. Not "at the end of
  the sequence" — a refactor that is only valid when finished cannot be reviewed,
  reverted, or bisected.
- Change one axis at a time: shape, then location, then names. If two steps must
  land together to compile, that is one step — say so in the message.
- Large mechanical moves are fine, done in one commit, as long as nothing else
  is in that commit.

## The invariants that quietly move

These are the ones a refactor breaks while every test stays green:

- **Defaults.** A parameter that gains a default, or a config that gains a
  fallback, changes behavior for every caller that omitted it.
- **Absent versus empty.** `undefined`, `null`, `""`, and `[]` are four different
  inputs. A helper that normalizes two of them together changed the API.
- **Order.** Iteration order, notification order, and the order of side effects
  are observable. A map swap or a `Promise.all` is a behavior change until you
  prove otherwise.
- **Error shape.** The same failure surfacing as a thrown error instead of a
  returned result, or vice versa, breaks callers that handle one form.
- **Timing and batching.** A synchronous path made async, or a debounce moved
  one level up, changes what the caller can rely on.
- **Telemetry.** Log lines, metrics, and event names have consumers too.

## Finish by removing the old path

Do not leave the previous implementation, the compatibility shim, or the
temporary flag in place "just in case". Two live implementations is the
duplication you set out to remove, now with a switch. Delete it in the same
change; if it must stay, it needs its own record saying until when.

## Proving it

- Cite the tests that cover the stated invariants, and say you ran them. "It
  type-checks" is not evidence that behavior is unchanged — types do not see
  ordering, defaults, or error shapes.
- For a large mechanical change, ask for a diff that ignores moves so the review
  sees what actually changed. If that diff is empty except for the declared
  structural change, you have your proof.
- Where an invariant cannot be tested, say which one and what you checked by
  hand instead. An unstated gap reads as full coverage.

## Origin

QianNing Agent. Written in this repository; no third-party method, text, or document format is reproduced here.
