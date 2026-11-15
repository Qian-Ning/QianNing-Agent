# 13. Workspace file search

Status: **not implemented**. This note records the design constraints we would
have to meet before shipping it, so the first implementation does not have to
rediscover them. It is not a specification of a surface we already have.

The composer has attachments and the agent has `search_files`; neither is a
workspace-wide picker. The gap is a **UI** gap, and the cost of filling it is not
the ranking — it is the concurrency.

## The failure this design exists to prevent

A file picker looks like "list the workspace and filter". Run naively it becomes:
every keystroke starts a directory walk, each walk holds a lock, and a large
workspace starves the small one being opened beside it. The symptom is a picker
that freezes for seconds on the second repository open, which is exactly when the
user is most certain the application is broken.

## Rules that must hold

**1. Discovery belongs to a query, not to mounting.** Opening the composer or a
picker starts no scan. An empty query answers from a bounded traversal prefix
instead of listing the tree.

**2. Permits are graded, not shared.** Discovery, scoring, and empty listings draw
from separate small pools. One large discovery must not be able to block a
small-root discovery or an empty listing. Acquisition is cancellable and bounded
by the query deadline.

**3. Queries attach to a job; jobs outlive their last consumer briefly.** Every
query for the same root joins one discovery job and holds a lease. Closing one
consumer releases only that lease. When the last leaves, the job lingers for a few
seconds, because a picker aborts its previous query on every keystroke — the next
keystroke must re-attach rather than restart the walk.

**4. Cancellation cannot publish.** A cancelled worker never publishes a partial
snapshot, and a late worker cannot publish over a newer job for the same root.
Publication checks job identity under the registry lock.

**5. Consumer generation rejects stale replies.** A response that arrives after
its consumer was replaced is dropped, not rendered.

**6. Budgets are finite everywhere.** Snapshots in the cache, consumers tracked,
failure-backoff entries, and the cooperative deadline all have caps. An unbounded
map here is a memory leak with a friendly name.

**7. The renderer never enumerates.** Commands rank natively and return a bounded
page. Rendering a whole workspace to filter it in the browser is the same defect
one layer up.

## What this means for our stack

The ranking and traversal belong in `host-core` next to the other filesystem
work, not in the renderer, and not in Electron main. The renderer asks for a
query and consumes a bounded page; cancellation is a first-class part of the call,
not an afterthought bolted on when the first report of a freeze arrives.

Ignore rules must be resolved once per root and shared: `.gitignore`, our own
ignore set, and the workspace boundary are part of the snapshot key, so changing
any of them selects a different snapshot instead of mutating one in place.

## Deliberately out of scope

- Content search (grep). That is a different cost profile and the agent already
  has a tool for it.
- Cross-root ranking. Multiple roots are searched, but each keeps its own
  snapshot and budget.
- Index persistence between launches. If it is added later, the on-disk index
  needs the same "job identity" discipline this note describes for memory.
