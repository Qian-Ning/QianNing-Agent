# 13. Workspace file search

Status: **implemented**, in the Electron main process —
`apps/desktop/electron/main/fs-index.ts`, serving the composer's `@` menu (D124,
ADR 0024). This page records how it works and what it trades away, because the
obvious "improvements" to it are the ones that make it slow.

## What it does

The composer asks for a snapshot of the workspace; the renderer filters and ranks
in memory. Two sources, in order:

1. **`git ls-files -co --exclude-standard -z`** — exact `.gitignore` semantics for
   free, with a 4 s timeout, a 32 MiB buffer cap, and a fallback when git is
   missing or the command fails.
2. **A bounded walk** over the panel's ignore set when git is unavailable.

The result is capped at `FS_INDEX_MAX_ENTRIES` (8000) with a `truncated` flag, so
a caller can tell "this is everything" from "this is the first 8000".

## The two properties worth keeping

**1. One snapshot per root, shared.** The index is cached for 15 s, and concurrent
requests for the same root join the in-flight build instead of starting a second
one. A picker sends a request per keystroke; without this, every keystroke would
walk the tree.

**2. Filtering is not the index's job.** The index returns paths. Ranking and fuzzy
matching happen in the renderer over an already-materialized list, which is why a
keystroke costs a filter rather than a filesystem call.

## What it deliberately does not do

- **No content search.** Paths only.
- **No incremental update.** A new file appears after the cache expires (15 s), not
  immediately. Cheap and predictable, at the cost of briefly stale results.
- **No per-query discovery sharing with leases.** The whole snapshot is the unit,
  so there is nothing to lease. If the workspace ever grows past the point where a
  full rebuild is affordable, that is the moment to introduce the graded permits
  and job identity described in the sibling project notes — not before.

## Why a second implementation is a mistake

Ranking a bounded walk inside `host-core` looks like an improvement and is not: it
would give the picker two sources of truth for "what files exist", one obeying
`.gitignore` exactly and one approximating it with a hardcoded directory list. The
renderer would then behave differently depending on which one answered.

New file-search needs go into this module, behind this snapshot shape.
