---
name: architecture-decision-records
description: a structural or contract decision needs to be recorded, or an existing record needs review
---

# Architecture decision records

A decision record exists so the next person does not have to re-derive the
argument you already had. It records the **decision and the reason**, and it is
short because its job is to survive being read in a hurry.

## What a record is, and what it is not

- It **is** the context, the choice, the alternatives, and the consequences.
- It is **not** a specification, a contract, a plan, or a design document. Those
  describe how the system works or will work; a record describes why it is this
  way and what else was on the table.
- It is **not** proof of current behavior. Code, public types, schemas, and
  tests are the source of truth for behavior. When a record and the code
  disagree, the code is right and the record is stale.

Getting this backwards is the most expensive mistake in this area: a record
starts being cited as a requirement, and then a stale paragraph outranks the
implementation.

## When one is actually needed

Write one when the decision is **structural and expensive to reverse**, or when
it is the kind that gets re-argued every quarter:

- A frozen boundary, a public interface, a data-ownership change, or a security
  boundary moves.
- A trade-off was made between real alternatives, and the losing options were
  reasonable. Without a record, they come back.
- A deliberate deviation from the obvious approach needs to be auditable: a
  compatibility exception, a pinned version, a performance shortcut.
- Something was declined on purpose. "We do not support X, because Y" is a
  decision, and its absence means it gets re-proposed.

Do **not** write one per change. A record that restates the diff is noise, and
noise trains people to skip the directory.

## The shape

1. **Status.** Proposed, accepted, superseded by another record, or rejected.
   Put it in the file, not only in a table somewhere else.
2. **Context.** The pressure that forced a choice: the constraint, the incident,
   the requirement, the property that had to hold. Written for someone who was
   not in the room.
3. **Decision.** What is now true, in the active voice: "requests go through a
   single dispatcher", not "it was decided to…".
4. **Alternatives considered.** What else was workable, and the specific reason
   each lost. This is the part that pays off years later.
5. **Consequences.** What gets easier, what gets harder, what is now impossible,
   and what would have to change to revisit it. A record with no stated downside
   was either trivial or dishonest.

## Keeping them honest

- **One decision per record.** Two decisions bundled together cannot be
  superseded separately, and one of them will age badly.
- **Never edit an accepted record's decision.** Supersede it with a new one that
  says what changed and why. Editing history destroys the only thing a record is
  for.
- **Update the record when the code moves away from it**, in the same change
  that moves the code. A stale record is worse than none, because it is
  confidently wrong.
- **Reference the record from the code** where the decision is load-bearing —
  a comment at the boundary, a test name, a type. Ratchet guards belong to
  records the same way they belong to specs.
- **Keep the rejected options short.** One line each, with the disqualifying
  reason. A paragraph defending every alternative turns the record into an essay
  nobody finishes.

## Reviewing an existing record

- Does the decision still match the code? If not, say which is authoritative
  here, and fix the one that is wrong.
- Are the consequences still accurate — the features that were going to be
  impossible, still impossible?
- Was it superseded and never marked? Status is the first thing to check.
- Is it doing someone else's job: prescribing an implementation, restating a
  spec, or acting as a plan? Move that material to where it belongs.

## Origin

QianNing Agent. Written in this repository; no third-party method, text, or document format is reproduced here.
