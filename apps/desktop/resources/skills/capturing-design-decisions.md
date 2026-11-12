---
name: capturing-design-decisions
description: Use at the end of a session where the user corrected the look, feel, or wording of an interface, to turn each correction into a rule the next session will follow.
---

# Turning corrections into rules

A correction is taste the agent did not have. Written down, it is a rule the next
session follows. Left in a chat log, it is a correction the user will make again —
in the same words, on the same component, next week.

This skill writes rules. It does not touch component code, and it does not add a
rule the user never expressed.

## Only the user's taste

Every rule traces back to something the user said, changed, or confirmed. "It is
generally better practice" is your taste, and your taste is the thing being
corrected. If nothing was corrected, write nothing.

## Find the corrections — including the quiet ones

Stated corrections are the minority. The five signals:

| Signal | What it looks like | What it means |
| --- | --- | --- |
| Stated correction | "Not a border — a soft shadow" | The rule, often with its reason attached |
| Silent edit | The user changed `duration: 400` to `200` in a file you wrote | Your default was wrong; their value is the rule |
| Repeated nudge | "Smaller." … "Still too big." … "Good." | The rule is where they landed, not the steps |
| Revert | "Undo that", or picking variant B after you built A | What not to do — usually with no reason given |
| Confirmed non-obvious choice | "Yes, keep the label outside the field" | Worth recording only if a fresh agent would plausibly do the opposite |

Skip what is not taste: a functional bug, copy that belongs to one screen, a
correction to your understanding of the task.

## Filter before writing

Would an agent building a **different** component in this repository make the same
mistake? If no, it is a one-off — skip it. If yes, check whether a rule already
covers it: if the existing rule says the same thing and the mistake still
happened, the rule failed, and the answer is a check rather than another sentence.

## Writing the rule

- **Rule plus reason**, always. A rule without a why gets extended by the next
  agent into cases it does not fit.
- **Never invent the reason.** If the user gave none, propose one marked as
  inferred and get it confirmed before writing it down.
- **Write for an agent that was not there.** Name the component class, the value,
  the token, the file. No "as we discussed", no "the card from earlier".
- **Generalise exactly as far as the evidence goes.** One screenshot of one dialog
  supports a rule about dialogs, not about every surface.

## A check beats a sentence

If a violation can be recognised mechanically — a banned value, a raw colour where
a token belongs, a transition on a layout property, a string outside the
catalogue — propose the check: a lint rule, a token restriction, a test. A check
runs on every change; a paragraph in a long document is skipped the moment the
agent's context is full.

## Where it goes

Pick one, by how it will be enforced:

| Destination | For |
| --- | --- |
| The project's design notes (`DESIGN.md` when the project keeps one) | Decisions a human reads and an agent consults before designing |
| A skill document | A procedure with steps, not a single constraint |
| A lint rule, token restriction, or test | Anything a machine can catch |

## Propose, then stop

Present the candidates — rule, reason, destination, and whether the reason was the
user's or inferred — and write only what is approved. A wrong rule is worse than a
missing one: it repeats in every future session, which is exactly what the
original mistake did.

## Origin

QianNing Agent. Written in this repository; the craft guidance is restated in our
own words from general interface-design practice, with no third-party text,
examples, or vocabulary reproduced.
