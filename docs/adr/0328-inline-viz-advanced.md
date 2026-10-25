# ADR 0328: Scripted previews, a session-artifact scheme, and a user-driven write

- Status: Accepted for implementation
- Date: 2026-10-25
- Deciders: QianNing Agent maintainers
- Related: ADR 0327 (session-owned inline visualizations), ADR 0011 (frozen
  process model), ADR 0322 (media-asset scheme), ADR 0235 (domain facades),
  `crates/host-core/src/inline_viz.rs`, `crates/host-core/src/audit.rs`,
  `docs/spec/03-tools-and-permissions/`

## Context

ADR 0327 shipped inline visualizations with two deliberate limits: previews are
static (the iframe's `sandbox` attribute is empty), and artifacts are written
only by the agent, through `tools.execute`. Both limits were correct for the
first increment, and both block the use cases that made the feature worth
having.

1. **Charts ship as HTML that draws itself.** Nearly every charting library
   renders at runtime; a static preview shows an empty canvas. The artifact is
   already on disk, already session-scoped, and already shown in a frame with no
   origin — the missing piece is only whether its own inline script may run.
2. **Reading through IPC doubles the work for large documents.** The card fetches
   the content over `inlineViz.read`, then injects it as `srcDoc`. For a
   half-megabyte artifact that is a JSON round trip through two process
   boundaries plus a parsed copy in renderer memory, for content the iframe
   could stream directly.
3. **The agent is not the only one who produces a visualization.** A user
   reading an answer often wants to keep it as an artifact in the conversation
   without asking the model to re-emit it, which means the renderer needs a
   write path — the one thing ADR 0327 explicitly declined to add.

Each of these relaxes a boundary ADR 0327 drew. That is exactly the kind of
change AGENTS.md §4 requires an ADR for, and exactly the kind that must not be
done casually: an empty sandbox is a strong guarantee, and "allow scripts" is
the one upgrade that can hand agent-authored markup control of the renderer if
it is done wrong.

## Decision

**All three extensions are added, each behind its own gate, and none of them
grants scripts and the app's origin to the same frame.**

### 1. Scripted previews are a second opt-in, never a replacement

`inlineVisualizations` keeps its meaning and its default. A new setting,
`inlineVizScriptedPreviews`, defaults off and is only consulted when the first
one is on. When both are on and the artifact is `html`, the preview upgrades to:

- `sandbox="allow-scripts"` — and **never** `allow-same-origin`. The frame
  therefore has an opaque origin: it cannot read the renderer's DOM, storage,
  IPC bridge, or cookies, and `allow-scripts` cannot be combined with the
  parent's origin because there is no origin to inherit.
- A CSP meta injected ahead of the content:
  `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:;`
  Inline script and inline style only. No network of any kind: no `fetch`, no
  remote image, no frame, no websocket. An artifact's script can draw and can
  compute; it cannot phone home.
- A visible `inlineViz.scripted` badge in the card header, so a user can tell a
  scripted preview from a static one at a glance.

Every other kind (`svg`, `json`, `csv`, `text`) and every preview under the
first setting alone stays on the empty-sandbox path, unchanged.

The guardrail that makes this safe is the pairing: scripts without same-origin,
under a network-closed CSP. Any future change that would add
`allow-same-origin`, or loosen the CSP to permit a network scheme, is a new ADR
and not an adjustment to this one.

### 2. A session-artifact scheme replaces the srcDoc round trip

A privileged scheme, `qn-visuals:`, serves one artifact:

```
qn-visuals://localhost/<session-id>/<visualization-id>[?scripted=1]
```

The scheme is reserved with `registerSchemesAsPrivileged` before app-ready
(`standard`, `secure`, `supportFetchAPI`, `corsEnabled`) and its handler is
installed with `protocol.handle` after app-ready, mirroring the media-asset
scheme of ADR 0322. Teardown is `protocol.unhandle` on quit; the reservation
itself cannot be undone and does not need to be.

The handler is confined by construction:

- `parseInlineVizUrl` accepts only the scheme, an empty or `localhost`
  authority, and exactly two path segments that each pass the same character
  rule the storage layer uses. Anything else is a 404, not an error page.
- The resolved file must sit inside `<dataDir>/inline-viz/` after `realpath`,
  so a planted symlink cannot escape the root.
- The response serves the artifact's `content` field with the MIME type derived
  from its stored `kind`, plus `x-content-type-options: nosniff`.
- The CSP is chosen by the request's `?scripted=1` flag — the static tier omits
  `script-src` entirely and the scripted tier permits `'unsafe-inline'`. A
  static request can therefore never receive a script-capable document even if
  the renderer asks for one by accident.

The renderer still reads through `inlineViz.read` when it needs the text in
hand (for example to render a card in a context where a subresource load is not
appropriate); the scheme is the fast path for the preview frame, not a
replacement for the RPC.

### 3. The renderer may write, but only narrowly, and only on a user action

The transcript gains a "save as visualization" control on an assistant answer.
It writes that answer's markdown as a `text` artifact of the same session
through a new `inlineViz.write` RPC. ADR 0327's "no renderer write channel"
decision is superseded, and the replacement is intentionally smaller than a
general write API:

- **Existing session only.** The write requires a session row to exist; a
  swept or never-created session is `SESSION_NOT_FOUND`, never an orphan
  directory.
- **The same bounds as the agent tool.** Title and content limits are imported
  from `inline_viz`'s own constants rather than restated, so the two writers
  cannot drift apart; the `kind` must be one of the stored kinds.
- **Audited.** Every accepted write appends a `tool_execute`-shaped audit row
  tagged `"source": "renderer"`, so one query covers both writers and a
  renderer-originated artifact is distinguishable from an agent-originated one.
- **Gated.** The control renders only while `inlineVisualizations` is on. A
  user who never opted in has no write surface.

The residual risk is stated plainly: a compromised renderer can plant a
bounded, audited artifact into an existing session's visualization root. It
cannot write outside that root, cannot name a session that does not exist, and
cannot exceed the size limits. That is a materially smaller exposure than a
general file-write channel and is the cost of letting the user keep an answer
without a model round trip.

## Consequences

**Gained.** Charts that draw. Previews that stream instead of round-tripping.
A user-driven artifact path that does not need the model.

**Paid.** A second setting to explain and translate. A privileged scheme whose
URL rules are a security boundary and must be tested as one. A renderer write
path that widens the trust surface of the renderer by a bounded, audited
amount, and that ADR 0327 explicitly did not have.

**Reversibility.** Turning the first setting off restores ADR 0327's behavior
exactly — no scripted frames, no scheme loads, no write control. The scheme
itself stays reserved but serves nothing the renderer asks for.

**Not decided here.** Rendering artifacts outside the transcript, exporting
them to the workspace, or letting a scripted preview fetch remote assets. Each
would change the CSP or the trust boundary and needs its own ADR.

## Alternatives considered

- **Allow scripts by default once visualizations are on.** Rejected: it would
  silently change the guarantee of an already-shipped setting for every
  existing user, and there is no way to make that visible after the fact.
- **Keep srcDoc only.** Rejected: it makes large artifacts pay a JSON round
  trip and a double parse for content the frame could read directly, and it
  cannot serve a document whose size approaches the message ceiling.
- **Let the renderer write through a generic workspace file API.** Rejected:
  it would put artifact bytes outside the session lifecycle, so the sweep on
  session delete would no longer reclaim them, and it would hand the renderer a
  general persistence channel where a bounded, audited one suffices.
