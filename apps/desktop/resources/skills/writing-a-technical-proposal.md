---
name: writing-a-technical-proposal
description: proposing a change, an investment, or an approach to other people
---

# Writing a technical proposal

The purpose of a proposal is to get a decision. Everything in it should serve
that, and the most common failure is a document the reader finishes without
knowing what they were asked.

## Put the ask in the first paragraph

- Say what you want, explicitly: "approve two weeks to move X to Y", "agree to
  freeze this interface", "tell me which of these two you prefer".
- Say who decides, and by when, if there is a deadline. A request with no owner
  and no date is a wish.
- If you cannot state the ask in one sentence, you have not finished deciding
  what you are proposing.

## The problem, with evidence

- Show it, do not assert it. "This costs about 6 hours a month of manual work,
  measured over the last quarter" beats "this is painful".
- Name who is affected and how much. A problem that hurts nobody is a preference,
  and should be argued as one, honestly.
- Say what happens if nothing changes. That is the real comparison, and it is the
  option people forget is on the table.

## Options, including doing nothing

- **Doing nothing** is always an option. Leave it in, with its cost stated.
- Include the **smallest version** that would help: a partial fix, a manual step,
  a document. It wins more often than the author expects, and it is cheaper.
- For each option: what it costs, what it makes easier, what it makes harder, and
  what would have to be true for it to be the right choice.
- Two options is usually enough. Five is a sign you have not chosen, and it moves
  the decision back onto the reader, who has less context than you.

## Recommend, and say why not the others

- State the recommendation plainly, in the same section as the options.
- Give the reason it wins **over each other option**, specifically. "Better"
  means nothing; "we already have the tooling for B, and A needs a new
  dependency we would have to maintain" is a reason.
- Where the reasoning turns on an estimate, give the range and the assumption it
  rests on. A precise number for an uncertain thing invites the reader to argue
  with the decimals instead of the idea.

## What it costs, honestly

- Time: whose, how much, and what gets delayed instead. Every hour spent here is
  an hour not spent somewhere the reader also cares about.
- Risk: what could go wrong, how you would notice, and what you would do.
- **What gets worse.** A proposal with no downside is not credible; the reader
  will assume you have not thought about it, and will supply the objection
  themselves, probably at the worst moment.
- What you are giving up by choosing this: the alternatives you are now locked
  out of, or would have to redo.

## What would change your mind

- Name the evidence that would flip the recommendation: "if the provider ships
  native support, this becomes unnecessary"; "if the volume is under N, the
  manual process stays cheaper".
- This is what makes a proposal a piece of engineering rather than advocacy. It
  also gives the reader something to disagree with precisely, which is the
  fastest route to a decision.

## Anticipate the strongest objection

- Write the objection in its strongest form, in its own terms, and answer it. A
  strawman is worse than leaving it out, because the reader has already thought
  of the real one and now trusts you less.
- If you cannot answer it, say so and propose how to find out. "We do not know
  yet, and here is how we would" is a credible proposal; silence is not.

## Keep it short

- One page for the decision, appendices for the detail. The reader is deciding,
  not implementing — they will read further only if the first page earns it.
- Do not bury the ask in the middle, and do not make the reader reconstruct it
  from the options.
- A proposal is not a specification. The proposal decides **whether**; the design
  decides **how**. Writing the design before the decision is a way of making the
  decision without the reader's input, and it reads as such.

## If the decision is already made

Do not write a proposal as a way of announcing one. If the choice has been made,
write the decision record: what was decided, why, and what it costs. A proposal
that only had one option wastes the reader's time and spends trust you will want
later.

## Before sending

- Does the first paragraph tell me what is being asked, by whom, and by when?
- Is the "do nothing" option present and honestly priced?
- Have I named what gets worse?
- Is there a line that says what would change my mind?
- Read it as the busiest person who will receive it, and cut the paragraphs they
  would skip.

## Origin

QianNing Agent. Written in this repository; no third-party method, text, or document format is reproduced here.
