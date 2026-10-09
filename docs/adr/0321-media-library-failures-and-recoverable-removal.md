# ADR 0321: The media library remembers what didn't render, and removal is recoverable

- Status: Accepted
- Date: 2026-10-09
- Related: ADR image-generation-capability, ADR video-generation-capability,
  `04-ux/12-media-workbench.md`,
  `packages/shared/src/media-workbench.ts`,
  `apps/desktop/electron/main/services/media-library.ts`

## Context

The workbench records every render in an `index.json` beside the files so the
library survives a restart without scanning directories. Three questions were
open once the history became something a person manages by hand.

**What happens to a run that produced nothing?** A failed or cancelled run wrote
no file, so the first index shape had nothing to record for it. The history then
answered "why is this render missing?" with a blank line, even though the run
still cost wall-clock time and, on a cancellation, may still be billed. The code
that knows the reason — a refusal before the request starts (no model
configured, credentials missing, the model unavailable) or a throw during the
request — had nowhere to put it.

**How does a render leave the library?** The files are the asset: a render cost
money, so an index that can be pruned must not be the only copy, and forgetting
an entry must not destroy the file behind it. A plain unlink would make a
mistaken removal unrecoverable, which is the wrong default for something the user
paid for.

**Does the path invariant still hold when a path is optional?** The index is read
defensively: an entry that names a file outside the library root is dropped so
neither "show in folder" nor "save as" can be pointed at an arbitrary file. If
`path` becomes optional, the invariant has to say what it bounds.

## Decision

1. **`path` is optional, and a run with no file is still recorded.** A
   `succeeded` entry carries the path of the file it wrote; a `failed` or
   `cancelled` entry carries no path but carries its `errorCode`. The history row
   maps that code onto a short localized reason, so an empty result reads as
   "why", not as a gap. Because old entries all carry a path, an older index
   reads unchanged: **there is no migration.**

2. **One run is exactly one row.** A tool refusal before the request starts and a
   throw during the request each append a single `failed` entry with an
   `errorCode`; a run that finishes appends one entry per output item. Success
   and failure never describe the same run, so the library cannot show a run
   twice.

3. **Removal goes to the operating system's recycle bin, not to unlink.** The
   IPC layer sends each `succeeded` entry's file to the OS trash
   (`shell.trashItem`), so a mistaken removal is recoverable from the recycle
   bin. Trashing is **best effort**: a file that is already gone, or an OS that
   refuses to recycle, never blocks the removal the user asked for. Both remove
   and clear answer with the surviving list, so the renderer replaces its list
   with what the main process returns.

4. **The library service never touches a file.** `media-library.ts` only forgets
   entries and hands the removed ones back to the caller, which is what keeps it
   free of Electron and lets the file reclamation stay an IPC concern. The
   removal's file step is therefore a caller responsibility, not the service's.

5. **The containment invariant bounds only an entry that names a file.** On
   read, a `succeeded` entry whose path no longer resolves inside the library
   root is dropped rather than handed to the renderer. A failed or cancelled
   entry has no file to hand out, so it is kept exactly as recorded and is not
   subject to the path check. This is the clause that keeps "show in folder" from
   becoming a general file reader while still letting a fileless row survive.

6. **The bound is shared, and it bounds the list, not the disk.**
   `MAX_LIBRARY_ENTRIES = 500` lives in `packages/shared` so the main process and
   the renderer use one number. Past it the oldest entries drop off the list
   while their files stay on disk; the history header states this outright
   (`N of 500 kept`, plus the note that older entries leave the list and the
   files remain).

## Consequences

- The history becomes honest about failure: a run that was cancelled, timed out,
  hit an unconfigured model, or failed authentication leaves a row naming the
  reason instead of a gap, and the same sentence the rest of the app uses for a
  given `errorCode` is reused here.
- No migration is owed: the new optional field is additive, and an index written
  by an earlier build reads without change.
- A removal is recoverable by construction, because the file lands in the OS
  recycle bin. The cost is that the "freed" disk space is only freed once the
  user empties the recycle bin, which is the point.
- The service stays free of Electron, so it stays testable without a window; the
  price is that its callers must remember to reclaim files, which is why remove
  and clear both return the entries they dropped rather than only the survivors
  internally.
- The path invariant is now narrower — it guards only what can actually be handed
  out — which keeps a fileless row from being discarded on a check that never
  applied to it.

## Alternatives considered

### Keep recording only finished runs

Rejected. It leaves the most common question a history must answer — "I paid for
this, where is it?" — with a blank row, and it discards the error code the
pipeline already computed.

### Delete the file on removal

Rejected for a paid asset. The index is a memory of files, not the files; a
removal the user did not mean must be undoable, and the recycle bin is the OS's
own undo.

### Make the service delete the file itself

Rejected. It would pull Electron into a service the rest of the codebase keeps
plain, so the file step belongs to the IPC caller that already owns the OS
surface.

### Apply the containment check to every entry

Rejected. A failed or cancelled entry names no file, so the check has nothing to
bound and would only invent a reason to drop a row the user needs to see.
