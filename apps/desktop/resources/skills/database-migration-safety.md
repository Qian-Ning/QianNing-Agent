---
name: database-migration-safety
description: a schema or persisted-data change is being written or reviewed
---

# Changing a schema that has real data in it

A migration is the one change you cannot roll back by redeploying. Everything
below exists to keep the data intact when the code goes wrong.

## Start from "there is data, and the old code is still running"

- **Never assume an empty database.** Local development is empty; production is
  not, and it has rows your code has never seen, in states your types do not
  model.
- **Deploys overlap.** During a rolling deploy, old code and new code run at the
  same time against the same schema. Whatever you change has to work for both,
  or the two have to be released in separate steps.
- Write down the four cases before writing the migration:
  1. old code, existing data
  2. new code, existing data
  3. new code, newly created data
  4. interrupted halfway — is the state recoverable?
  If a case fails, the migration is wrong, not the deployment order.

## Expand, migrate, contract

The safe shape for a change that is not purely additive, in separate releases:

1. **Expand.** Add the new column, table, or index. Nullable, or with a default
   the old code also satisfies. Old code keeps working because nothing it reads
   has changed.
2. **Migrate.** Write to both shapes, then backfill existing rows in batches.
   Reads stay on the old shape until the backfill is verified complete.
3. **Switch reads** to the new shape, once a verification says every row is
   populated. Keep writing to both.
4. **Contract.** Remove the old shape and the dual writes — in a **later**
   release, after the switch has been live long enough to trust.

Never drop a column in the same release that stops writing to it. The drop is
the step that cannot be undone, and it should be separated from the change by a
release you can still roll back.

## Make every step re-runnable or explicitly not

- A migration that is interrupted and rerun must either be idempotent
  (`IF NOT EXISTS`, an upsert, a guarded check) or must refuse clearly rather
  than half-apply.
- Track and report progress in long backfills, so an operator can tell "still
  running" from "stuck" from "died".
- Backfills run in **batches**, commit as they go, are **idempotent**, and do not
  run on the hot path. A single-transaction backfill over a large table is an
  outage with a progress bar.

## Locks and size

- State which lock the migration takes, and for how long. An exclusive lock on a
  large table blocks every writer, and is the most common way a schema change
  becomes an incident.
- Adding an index on a large table locks or takes significant resources on most
  engines. Know the syntax for doing it without blocking on yours, and say in the
  migration which one you used and why.
- Rewriting a column type may rewrite the whole table. Estimate the duration from
  the real row count, not from the row count on your machine.

## Back up what cannot be recovered

- Identify the steps that **destroy** information — dropping a column, rewriting
  a type that loses precision, normalizing away a value — and before those, name
  the backup and where it goes.
- A "down migration" that recreates a dropped column does not restore its
  contents. Down migrations are usually a comfort, not a guarantee, and pretending
  otherwise is worse than saying they do not exist.
- If a step truly cannot be reversed, say so in the migration's own comment. The
  next person reads the file, not your message.

## Versioning and ordering

- Every migration gets a version, applied in order, recorded in the database.
  Never edit an already-applied migration; add a new one.
- Two migrations landing from separate branches need a defined order. If the
  versions collide, resolve by renumbering before merge, not by hoping the
  applied order works.
- Roll-forward is usually better than roll-back for data: write a new migration
  that fixes the state, rather than trying to unwind the previous one.

## Verify, at scale, on real data

- Test the migration on a **copy** of real data at real size. Fast on a table
  with a hundred rows means nothing.
- After applying, run a query that **counts**: rows migrated, rows remaining with
  the old shape, nulls where there should be none. A migration with no count is a
  migration with no verification.
- Keep the verification query next to the migration so the next person can
  re-run it — and so the contract step can be justified.
- Where the application has invariants the database does not enforce, assert them
  after the migration and roll the release back if they fail.

## Origin

QianNing Agent. Written in this repository; no third-party method, text, or document format is reproduced here.
