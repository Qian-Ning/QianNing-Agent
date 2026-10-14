---
name: explaining-and-teaching
description: explaining technical work, writing documentation, or teaching a concept
---

# Explaining something so it lands

The measure of an explanation is not how much is in it. It is whether the reader
can now do the thing, or decide the thing, or argue back.

## Start from where the reader is

- Before writing, decide what they already know. An explanation aimed at the
  wrong level is either obvious or useless, and both lose the reader in the first
  paragraph.
- Do not restart from the beginning of the topic out of habit. If they asked
  about the migration, they do not need the history of the database.
- **Answer the question that was asked.** Answering a neighboring, easier
  question reads as an evasion, and the reader will ask again.

## Name the answer in the first sentence

Put the conclusion first, then the reasoning. A reader who is interrupted after
one line should still have the answer.

- "It is slow because each item makes its own request; batching fixes it." Then
  the evidence.
- Withholding the conclusion to build suspense works in fiction and wastes
  everyone's time in an explanation.
- If the answer is "it depends", say **what it depends on** in that first
  sentence, and then walk the branches.

## Concrete before abstract

- One worked example first, then the general rule. The example gives the reader
  something to attach the abstraction to; the abstraction first gives them
  nothing.
- Prefer a real example from the actual code or data over an invented `Foo` and
  `Bar`. Real detail is what makes an explanation memorable, and invented detail
  has to be learned twice.
- When introducing a term, use it in a sentence immediately. A definition alone
  rarely survives.

## Analogies: useful, and dangerous when unmarked

- An analogy is a bridge, and every bridge ends. Say where it ends: "this is
  like a queue, except there is no ordering guarantee here."
- **State the difference explicitly.** An analogy that silently leaks a wrong
  property creates a bug in the reader's head that surfaces later, at the worst
  time.
- One analogy, used well, beats three mixed together. Mixing metaphors is how a
  reader loses track of which properties are real.

## Explain what they cannot look up

- Do not spend space on things a search or a type signature answers. Spend it on
  what cannot be looked up: the trade-off made, the alternative rejected, why it
  is shaped this way and not the obvious other way.
- The reasoning is the valuable part, and it is the part that is lost first. "We
  chose A over B because B fails when X" is worth more than a description of A.
- Where you are unsure, say so: "I think this is because X; the way to check is
  Y." Calibrated uncertainty is more useful than false confidence, and it teaches
  the reader how to find out for themselves.

## Length is a signal

- A short question earns a short answer. Answering "what does this flag do" with
  three screens is a failure to prioritise, and the reader will not read it.
- Depth should be available on request, not imposed. Lead with the answer, then
  offer the detail: "the full sequence is below if you want it."
- **Do not dump everything you know.** Volume is not thoroughness; it pushes the
  reader to skim, and a skimming reader keeps nothing. Choosing what to leave out
  is the work.

## Structure that a reader can navigate

- Headings that state the conclusion, not the topic. "Batching is required" beats
  "Batching considerations".
- Short paragraphs. One idea each.
- Code and commands in blocks, copy-pasteable, with the expected result stated —
  an explanation the reader cannot act on is only half an explanation.
- Put the caveat next to the thing it applies to, not in a footnote at the end,
  where it will be read after the mistake.

## When teaching, not just explaining

- **A task that requires the idea** teaches it; a summary that can be reread
  without doing anything does not. Give them something to build, break, or
  predict.
- Have them **predict** before checking: what will this print, what happens if I
  double it, what breaks if this is empty. Prediction is where a wrong mental
  model shows up cheaply.
- Teach the failure modes alongside the feature. What someone remembers is what
  went wrong and why.
- Do not perform competence. Being able to say "I am not sure, here is how we
  find out" is the most transferable thing you can model.

## The test

Ask whether the reader could now explain it to someone else, or act on it without
coming back. If not, the missing piece is usually one of: the conclusion came
last, the example came after the theory, or the reasoning was left out.

## Origin

QianNing Agent. Written in this repository; no third-party method, text, or document format is reproduced here.
