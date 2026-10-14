---
name: document-to-action-items
description: the user wants the tasks, deadlines, or obligations out of a document
---

# Turning a document into action items

The failure mode is not missing an item. It is producing a confident list of
things the document never actually asked anyone to do.

## Read the whole thing first

Extract nothing until you have read the document end to end, including the
appendix, the footnotes, and the tables. Obligations hide in the parts nobody
titles "obligations": a validity date inside a definition, a duty inside an
exception, a deadline inside a schedule reference.

Note the document's own vocabulary for obligation as you go — `shall`, `must`,
`agrees to`, `is responsible for`, `will provide`, and in other languages the
equivalents. That vocabulary is what distinguishes a requirement from a wish.
The signal words are specific to the document, not universal.

## Every item carries its source

Each extracted item gets a citation that a reader can open and check: a section
number, a page, a clause, or a quoted sentence. See `grounded-citations` for the
discipline; the short version is that a list of obligations nobody can verify is
worse than no list, because it will be acted on.

For each item, capture:

| Field | Rule |
|---|---|
| **Action** | The smallest unit that one person can finish. Split "review and approve" into two if different people do them. |
| **Owner** | Exactly who the document names. If it names nobody, write `unassigned` — do not infer the owner from context. |
| **Deadline** | As written, including the format. `within 30 days of the effective date` is more useful than a computed date, and less likely to be wrong. |
| **Condition** | What must happen first, if anything. An obligation that only triggers on an event is not yet due. |
| **Source** | Section, page, or the quoted sentence. |
| **Type** | Obligation, prohibition, right, or recommendation. These are not interchangeable. |

## Keep three kinds of statement apart

1. **What the document requires** — quoted or closely cited. This is the output.
2. **What you infer** — a deadline implied by two clauses, a dependency the text
   only gestures at. Mark it as yours, and put the reasoning next to it.
3. **What the document does not settle** — an unassigned owner, a term used but
   never defined, two clauses that conflict. This section is often the most
   valuable output, and leaving it out is how it gets silently resolved by
   whoever acts first.

Do not invent an owner, a date, or a priority to make the list look complete. An
empty field is information; a plausible guess is a liability.

## Output shape

- Group by owner when the reader is going to hand items out; group by deadline
  when they are going to sequence them. Pick one, and say which.
- Sort within the group by dependency, not by the order the clauses happened to
  appear.
- Where two items are the same obligation expressed twice, list it once and cite
  both places.
- End with the open questions: unresolved owners, undefined terms, conflicting
  clauses. Do not bury them in a footnote.

## Working from a partial document

If you only have an excerpt, say so and say what is missing. A list of
obligations from page four of an unknown document is a trap for whoever reads it
next — mark it clearly as partial, and do not reason about the whole from a
piece.

## Origin

QianNing Agent. Written in this repository; no third-party method, text, or document format is reproduced here.
