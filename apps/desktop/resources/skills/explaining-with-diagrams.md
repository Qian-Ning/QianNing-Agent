---
name: explaining-with-diagrams
description: drawing a diagram or choosing how to explain a structure
---

# Explaining with diagrams

A diagram is for **relationships**. It is not decoration, and it is not a substitute
for prose: it carries the part of an explanation that prose is bad at — what
connects to what, in which order, and what contains what.

## One diagram, one idea

This is the rule that matters most and is broken most often.

- A diagram trying to show everything shows nothing, because the reader cannot
  tell which relationship is the point.
- Where there are two ideas, draw two diagrams. It is cheaper to read two clear
  pictures than one that requires decoding.
- If the diagram cannot be summarised in one sentence, it is not a diagram yet; it
  is a sketch, and sketches are for thinking, not for showing.

## The medium follows the question

| The question is | The shape is |
|---|---|
| What talks to what? | Boxes and arrows, one arrow per direction of dependency |
| What happens in what order? | A sequence, read left to right or top to bottom |
| What contains what? | Nesting — boxes inside boxes |
| How does it change over time? | A timeline, or a state machine |
| What are the states and transitions? | States as boxes, transitions as labelled arrows |
| Where does the data go? | A flow of values, with transformations on the arrows |
| How does a decision get made? | A tree, with conditions on the branches |
| What changed? | Before and after, side by side, same layout in both |

Using the wrong one is why a diagram feels harder to read than the text it replaced.

## Label the arrows

An unlabelled arrow is a guess. This is where diagrams most often mislead:

- **Say what the arrow means**: calls, returns, depends on, sends data to, reads
  from. They are different relationships and they fail differently.
- **Do not mix arrow types in one diagram** without distinguishing them. A reader
  will assume a uniform meaning, and half the arrows will then be wrong.
- **Direction is the most commonly misread element.** Where it is not obvious, say
  it — a legend, or a sentence under the picture.
- Where a relationship is not a straight line — an event, a callback, an
  asynchronous reply — draw it as the non-straight thing it is. A straight arrow
  for an asynchronous message teaches the wrong mental model.

## The reader needs somewhere to start

- Mark the **entry point**: which box is the thing they are actually looking at, or
  where a request arrives. Without it, the reader scans for a place to begin, and
  scanning is where comprehension stops.
- Order the elements the way a reader encounters them, not the way they were
  easiest to draw.

## Omission is the point, and the hazard

- A useful diagram leaves things out: that is how it stays readable. The obvious
  consequence is that **absence is invisible**.
- **Never omit something the reader will assume is present.** An escaped edge case
  reads as "not part of the system" rather than "not shown", and the reader
  proceeds with a model that is confidently incomplete.
- Where the diagram is a subset, say so in the caption: "the authentication path
  only", "external services omitted". One line prevents the wrong inference.
- Anything cut for space belongs in the prose, not nowhere.

## Legibility

- Text must be readable at the size it will actually be seen: in a document, in a
  terminal, on a slide. A diagram that requires zooming is a diagram that will be
  skimmed.
- **Colour may not be the only carrier of meaning.** If the distinction between two
  paths is red versus green, readers with colour blindness have lost it. Use a
  distinct shape, dash pattern, or label as well.
- Contrast and font size fail first when a diagram is scaled down. Where it may be
  scaled, check it at the small size.
- Where the medium cannot show the diagram reliably — a terminal, a plain-text
  context — the text must stand alone and the diagram is a bonus.

## Naming and boundaries

- **Use the system's real names**, not invented ones. A diagram calling something
  "Service A" while the code calls it `billing-api` makes the reader do a
  translation, and the translation is where the value leaks out.
- **A box should mean a boundary you would defend**: a process, a trust boundary, a
  module with an owner. Boxes drawn for convenience teach a structure that does not
  exist, and someone will later try to respect a boundary that was only a drawing.
- **Layout carries meaning whether you intend it or not.** Readers infer direction,
  hierarchy, and importance from position. Put what happens first on the left, what
  it depends on below or behind, and do not place two things adjacently unless they
  are related.

## Diagrams of behaviour, specifically

- **Most diagrams show only the happy path.** The failure path is usually the
  interesting one: which step times out, what retries, where it gives up, what the
  caller sees when a middle step fails. Draw the failure at least as clearly as the
  success.
- For a sequence, show the **return** as well as the call, or the reader infers a
  one-way system.
- For state machines, show the **transitions nobody wants**: the error state, the
  cancellation, the attempt to move backwards.
- Where a decision is made, put the **condition on the branch**. An unlabelled
  split is a puzzle.

## Keeping it true

- **A diagram is a claim, not proof.** It can be wrong in exactly the same ways a
  comment can, and it is harder to notice because it looks authoritative.
- **Version diagrams with the code**, in the same change as the behaviour they
  describe. A stale diagram lies as confidently as a stale comment, and more
  vividly.
- Where the tooling allows, **keep diagrams as text** so they appear in diffs and
  are reviewable. A binary image in a repository is a document nobody diffs, and a
  change to it is invisible in review.
- Check the diagram against the code before publishing it. The box you drew from
  memory is frequently not the box that exists.

## The test

- Can a reader answer a specific question from it — "what happens if this fails",
  "who calls whom" — without reading the prose twice?
- Can they redraw its structure from memory afterwards? That is what the diagram
  was for.
- If the answer to either is no, one idea is being asked to carry several. Split it.

## Origin

QianNing Agent. Written in this repository; no third-party method, text, or document format is reproduced here.
