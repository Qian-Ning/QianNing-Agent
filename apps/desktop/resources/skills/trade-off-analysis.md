---
name: trade-off-analysis
description: a decision has to be made between competing approaches
---

# Choosing between approaches

Most bad technical decisions are not made by picking the wrong option. They are
made by comparing options against criteria chosen **after** someone already had
a favourite.

## Frame the options first

- List every live option, including **doing nothing** and **doing the smallest
  version now**. Those two win more often than they are allowed to compete.
- One option must be the current state, clearly described. Half of "we should
  rewrite this" arguments are really "we don't like what this is", and the
  honest comparison is against the status quo with its frictions, not against an
  imagined ideal.
- If two options differ only in effort, they are one option. Collapse them.
- Look for the option nobody proposed: a smaller first step that buys
  information, or a change that removes the need to choose. It is often the
  answer, and it never appears on a list of two.

## Name the criteria before scoring

Write the criteria down, order them, and only then evaluate. If you evaluate
first, you will discover criteria that happen to favour the answer you wanted.

Use criteria that belong to **this** decision rather than generic virtues:

- What does this cost to run and to change later, not just to build?
- What does it make impossible, and does anyone need that?
- How quickly does it fail, and how badly?
- Who has to understand it, and is that realistic?
- Does it make the next likely change easier or harder?

For a personal project, add the ones that actually dominate: how long until it
is useful, how much attention it needs, and whether you will still want to work
on it.

## Estimate in ranges, and say what is unknown

- Give ranges, not single numbers. A precise estimate of an uncertain thing is
  false confidence with a decimal point.
- Mark the unknowns explicitly. "We do not know how the provider handles
  partial writes; if it drops them, option B loses."
- Do **not** build a scoring matrix with invented weights. Ranking by weighted
  score looks objective and hides the fact that the weights were chosen freely.
  Prose that names the trade-off is more honest and shorter.

## Reversibility decides how much analysis is warranted

- **One-way doors** — data formats, public contracts, a language choice, a
  schema — deserve the full treatment, because being wrong is expensive.
- **Two-way doors** — internal structure, a helper's shape, a library behind an
  interface — decide quickly, pick the one that is fastest to undo, and move.
  Spending a week on a reversible decision is itself the mistake.

Ask of every option: *if this is wrong, how do I get out, and what does it cost?*

## Steelman the option you dislike

State the strongest case for it in its own terms, not a strawman version. If you
cannot, you do not understand it well enough to reject it. The reason it loses
should be a fact about the situation — not that it is unfamiliar, not that it is
newer or older, not that it was someone else's idea.

## Close the decision

- **Write the choice and the reason.** One paragraph, in the change or in a
  record. A decision made in a meeting and remembered nowhere gets remade, twice,
  worse.
- **Write what would change your mind.** "If we exceed N users, revisit" or "if
  the provider adds X, the constraint disappears". This is what turns a decision
  into something reviewable.
- **Price the delay.** Deciding later is not free: the work waits, and the
  information you were waiting for may not be the information you needed.
- **Decide at the level of the blast radius.** A decision that affects one
  module does not need everyone's agreement.

## Revisiting

When the decision comes back, first ask whether the situation changed or only
the participants. Re-opening a settled decision without new information is churn,
and it has a cost: the work that was already done on top of it.

## Origin

QianNing Agent. Written in this repository; no third-party method, text, or document format is reproduced here.
