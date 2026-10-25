# ADR 0327: Session-owned inline visualizations rendered in a no-script sandbox

- Status: Accepted for implementation
- Date: 2026-10-25
- Deciders: QianNing Agent maintainers
- Related: ADR 0235 (domain facades), ADR 0041 (bounded host runtime),
  `crates/host-core/src/scratch.rs` (per-session directory lifecycle),
  `crates/host-core/src/review.rs` (same lifecycle pattern),
  `packages/agent-runtime/src/runtime.ts` (`tools.list` mirror),
  `docs/spec/03-tools-and-permissions/` (tool gate and audit)

## Context

An agent working on a task frequently produces structured output that reads
poorly as raw text in the transcript: a chart, a diagram, a data table, a
small dashboard. Asking the model to write an HTML file into the user's
workspace just so it can be opened separately litters the project with
artifacts the user never asked to keep, and rendering agent-produced HTML
directly into the app is unsafe — the content is untrusted input at the
renderer boundary.

Three facts shape the design space:

1. **The renderer must not execute agent-authored markup.** Any HTML/SVG an
   agent produces is data, not code to trust. Even inside an Electron window,
   inline script execution would equal arbitrary code in the renderer, so
   whatever preview mechanism we build must have scripts disabled by
   construction, not by convention.
2. **Persistence belongs to host-core.** The frozen process model
   (AGENTS.md §4, ADR 0011) gives Rust host-core authority over persistence
   and per-session side data. A renderer that could name and write artifact
   files directly would be a new persistence path outside that boundary.
3. **Content must die with its session.** A visualization is conversation
   context, not a project deliverable. Its lifecycle should match scratch and
   review snapshots: created during a turn, listed and read while the
   conversation lives, removed when the session is deleted.

## Decision

**Inline visualizations are session-owned artifacts that an agent writes
through a normal host tool and the renderer shows inside a strict no-script
sandbox iframe.**

- **One new agent tool, `WriteInlineVisualization`** (arguments `sessionId`,
  `title`, `kind` ∈ `html | svg | json | csv | text`, `content`). It rides
  the existing `tools.execute` gate: the standard permission evaluation
  (`permissions.rs`), the `tool_execute` audit row, the tool budget, and the
  mode allowlist all apply unchanged. It is classified low-risk because it
  writes only into the host-owned session visualization root — it can never
  touch workspace files, run code, or reach the network.
- **Host-core owns the storage.** Artifacts live under
  `<data_dir>/inline-viz/<session_id>/<id>.json`, one file per artifact
  (meta + content), written atomically via temp-file rename. Lifecycle
  mirrors `scratch.rs` / `review.rs`: removed in the shared
  `drop_session_side_data` cleanup and swept at startup for orphaned
  sessions.
- **The renderer only reads, through two IPC channels**
  (`pi-desktop/inlineViz/list`, `pi-desktop/inlineViz/read`) that Electron
  main forwards to host-core RPC (`inlineViz.list`, `inlineViz.read`). There
  is deliberately **no write channel**: a renderer compromise can read back
  what the agent already wrote but cannot plant content. This round carries
  no custom URL scheme — content crosses the bridge as strings over the
  read channel and lands in `srcDoc`.
- **The preview iframe is sandboxed with an empty `sandbox` attribute** —
  no `allow-scripts`, no `allow-same-origin`, no `allow-top-navigation`.
  HTML is fed to `srcDoc` verbatim; SVG is wrapped in a minimal document;
  JSON/CSV/text are HTML-escaped into a `<pre>`. Every path is inert by
  construction.
- **Opt-in, default off.** A Settings toggle (`inlineVisualizations`) gates
  three doors at once: the runtime's tool declaration (the model is not even
  offered the tool while off), host-core's `tools.list` mirror, and the
  renderer card. The toggle is a normal `AppSettings` field persisted through
  the existing settings store — no new persistence path.

## Consequences

- Agent turns can now produce genuinely rendered output (charts, diagrams,
  tables) whose only cost is the bounded content size (512 KB ceiling) and
  the session-owned disk footprint.
- The transcript gains a third artifact renderer beside generated images and
  review cards; the card is a plain presentational component over `Panel`,
  `Badge` and `Button` with a `srcDoc` iframe.
- Off-switch behavior is complete but not hostile: while the toggle is off
  the tool is not declared, `tools.list` does not offer it, and no card
  renders. Existing stored artifacts remain until their session is deleted —
  the switch gates presentation and declaration, not the host-owned data.
- A stale in-context model call after the user switches the feature off
  would still be admitted at `tools.execute` (the tool is not refused at
  execution time). Its blast radius is one session-owned file that dies with
  the session and never executes; documented here so a future hardening pass
  can add an execution-time gate (with its own error code) if the risk is
  ever judged worth it.
- The low-risk classification means no approval card for each visualization
  in any permission mode; this matches the D114 precedent that writes to
  host-owned session scratch need no prompt.

## Alternatives

- **A custom URL scheme (`inline-viz://session/id`).** Rejected for this
  round: registering and serving a custom scheme in Electron main is real
  surface area, and the renderer already has a safe bridge for content
  (IPC with `srcDoc`). A scheme can be added later without changing the
  contract.
- **Rendered previews in the work panel browser.** The work panel browser is
  a real Chromium surface for trusted developer content; agent-authored
  markup does not belong there. The iframe card keeps the artifact inside
  the transcript where `sandbox=""` is guaranteed by markup, not by a
  navigation policy.
- **Store visualizations in the SQLite DB.** The artifacts are
  content-addressed blobs with a bounded size; a directory under `data_dir`
  matches the existing scratch/review pattern, keeps the DB small, and makes
  the session lifecycle cleanup a filesystem delete.
- **Let the renderer write.** Rejected outright: it would be a second
  persistence authority inside the renderer process, violating the frozen
  architecture.