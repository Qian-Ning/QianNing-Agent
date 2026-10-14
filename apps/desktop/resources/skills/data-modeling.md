---
name: data-modeling
description: a schema, a domain model, or an entity's shape is being designed
---

# Modelling data

The schema outlives the interface that inspired it. Model the domain, not the
screen, and the screens will be easier to build.

## Find the identity first

For each entity, answer: **what makes two of these the same thing?**

- A generated identifier is stable and never changes meaning. A **natural key**
  — an email, a name, a path, a title — will be edited by a user eventually, and
  every reference to it silently breaks or has to cascade.
- Ask the question out loud for each candidate key, because it is cheaper now:
  rename a project, change an email, move a file. If the answer is "everything
  pointing at it must be updated", that thing is not an identity.
- Every entity that can be referenced needs a stable identifier, even if a nicer
  human-readable one also exists. Keep both roles separate.

## Decide who owns each fact

Every piece of data has exactly one owner. A value derived and stored in two
places is two facts that will disagree.

- **Reference or copy**, decided deliberately per field. Denormalising is a real
  technique with a real cost: the copy needs an update path, and it needs a
  story for when the update fails.
- A copy that is only written once and never maintained is a bug with a
  migration already scheduled.
- Derived values that can be recomputed cheaply should not be stored at all;
  values that are expensive to compute and read often are worth caching, with the
  invalidation named.

## Model state as a state machine, not as booleans

Independent boolean flags allow states the domain forbids, and the code then has
to prevent them — everywhere, forever, and it will forget one place.

- One status field with a defined set of values, and transitions that are
  explicit and validated.
- Where transitions have side effects (a notification, a charge, an audit
  entry), record the transition, not just the resulting state. "It is now
  cancelled" does not tell you who cancelled it, or whether the refund went out.
- `is_visible`, `is_deleted`, `is_published`, and `is_archived` on one row is
  four booleans describing one lifecycle. That is eight states, of which probably
  three are real.

## Ask what the schema cannot express

The valuable question is not "does it have all the fields" but **can it express
something the domain says is impossible?**

- If yes, some code must enforce the rule, and that enforcement is now a
  requirement that can be forgotten in the next feature.
- If the rule can be expressed as a constraint — a uniqueness, a foreign key, a
  check, a not-null — put it in the schema, where it cannot be bypassed by a
  future code path.
- Constraints that only the application enforces should have a comment saying
  why, because the next person will assume it is enforced.

## Nulls mean three different things

`NULL`, an empty string, and a zero are not interchangeable, and a `NULL` may
mean any of:

- **unknown** — we do not know the value
- **not applicable** — this field has no meaning here
- **absent** — it was never set

One column cannot carry two of those meanings without a convention that someone
will break. Where the distinction matters, model it: a separate column for the
"known" flag, a lookup table, a state, or a different entity entirely.

Also decide, explicitly, how a `NULL` interacts with uniqueness, joins, and
comparisons in your engine — the answers differ, and they surprise people.

## Timestamps, deletion, and time

- Store times in **UTC**, and store the timezone separately where the user's
  zone is meaningful. A local time without its zone is uninterpretable after a
  data migration.
- Carry the three distinctions that matter: **created**, **updated**, and
  **deleted**. Without `updated` you cannot resolve a conflict; without `deleted`
  you cannot audit an absence.
- **Soft delete is a query-time contract, not a column.** Once rows remain, every
  query, join, aggregation, and unique constraint has to exclude them — and the
  one that forgets shows deleted data to a user. If the data does not need to
  stay, hard-delete it and keep an audit record elsewhere.

## Current state or history

Decide which question the table answers, because they are different tables:

- **Current state** — small, cheap, loses the past. Updates overwrite, and two
  concurrent writers lose one of the changes.
- **Event log** — append-only, complete, and answers "how did we get here". More
  storage, and reading the current state means folding the history.
- Audit requirements, undo, and dispute resolution all live on the history side.
  If the requirement exists, build it now — reconstructing it later is
  impossible.

Where both are needed, the event log is the source of truth and the current state
is a projection that can be rebuilt.

## Types that matter

- **Money**: never floating point. Integers in the smallest unit, or a decimal
  type, with the currency stored alongside. Rounding errors compound and they
  appear in an accountant's report, not in a test.
- **Enumerations**: a value set that changes with the business is a lookup table,
  not a database enum. Adding a value to a database enum is a migration; adding a
  row is an insert.
- **Large or unbounded text**: consider whether it belongs in the row at all, and
  what it does to backups and to every query that selects the row.
- **Collections**: one value per row, in a separate table, unless the engine's
  array or JSON type is genuinely the right shape — and then say what you give up
  in queryability and constraints.

## Before finalising

Name the three queries the application will run most often, and check the schema
supports them without a full scan or a chain of joins. Name the one that will be
slowest, and decide whether that is acceptable.

## Origin

QianNing Agent. Written in this repository; no third-party method, text, or document format is reproduced here.
