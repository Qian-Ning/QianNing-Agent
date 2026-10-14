---
name: api-contract-design
description: an interface between producers and consumers is being defined or changed
---

# Designing and changing a contract

A contract is the set of things a consumer is entitled to rely on. Everything
else is implementation, and the most valuable thing you can do is be explicit
about which is which.

## Draw the line out loud

Write down what is promised: the fields, their types, their meaning, the
guarantees (ordering, idempotency, delivery), and the error surface. Then write
down what is not promised, because that is what you will want to change later.

Anything you do not name as a guarantee, do not silently rely on either. Half of
"we can never change this" is caused by nobody writing down which parts were
never promised in the first place.

## Additive is safe; everything else needs a story

Safe by default:

- A **new optional** field, with a defined behavior when it is absent.
- A new endpoint, method, or event.
- A new enum member — **only** if consumers are required to ignore unknown ones.
  If they switch exhaustively, this is a breaking change, and the rule has to be
  in the contract, not in your hopes.

Not safe, and each one has broken someone:

- **Removing or renaming** anything, including error codes and message text that
  gets pattern-matched.
- **Tightening validation.** A field that accepted `"  A  "` and now rejects it
  is a breaking change for every caller who sent it. Strictness is a contract
  change even when the diff is one character.
- **Changing a default.** Callers that omitted the value now get different
  behavior, and the diff shows nothing.
- **Narrowing a type or a length limit**, including "reasonable" ones.
- **Changing semantics under an unchanged name.** The worst kind, because nothing
  in the shape tells the consumer to look.
- **Changing the truthiness of absent.** `null`, missing, and `""` becoming
  interchangeable is a behavior change for every consumer handling them
  differently.
- **Changing ordering** where a consumer may depend on it, or making a
  synchronous guarantee asynchronous.

## The unknown-field policy

State it explicitly: are unknown fields preserved, ignored, or rejected?

- **Ignore** is the usual answer and the one that makes additive change possible.
- **Reject** is sometimes right for a closed internal boundary, but it must be
  written down, because it converts every additive change into a coordinated
  release.
- A validator that rejects unknown fields by accident — a strict schema with no
  escape hatch — is a trap for the next person who adds a field.

## Error surface is part of the contract

- Which failures are a response and which are a transport error.
- Whether an error is retryable, and whether a retry is safe (idempotency).
- The machine-readable code, not only the human message. Callers will switch on
  something; give them something stable to switch on, or they will switch on the
  message text.
- Timeouts and partial results: what a consumer should assume when the deadline
  passes with work in progress.

## Versioning

- Say what the version means: additive-only within a major version is the
  simplest rule to explain and to enforce.
- One version per boundary, not per endpoint, unless there is a reason.
- A version that never increments is decoration. Make sure at least one
  mechanical check fails when a breaking change lands without one.
- Deprecation is a process, not an annotation: announce, keep it working, give a
  date, then remove. Removing without the interval is what makes consumers stop
  trusting your announcements.

## Prove it from both sides

- **Producer tests** that the shape and the guarantees hold.
- **Consumer tests** — or contract tests — that read a real payload and assert
  what a consumer actually relies on. A producer-only test suite proves the
  producer agrees with itself.
- When the contract crosses a process boundary, pin the serialized form in a
  fixture. Type equality in one language says nothing about what the other side
  receives.

## Before changing one

Check, in this order: who consumes this, which of them are outside your reach,
what the shape of a compatible change is, and how you would find out if you got
it wrong. If you cannot answer the last one, you are not ready to change it.

## Origin

QianNing Agent. Written in this repository; no third-party method, text, or document format is reproduced here.
