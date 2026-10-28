# ADR 0339: One interface, two surfaces

- Status: Proposed
- Date: 2026-10-28
- Related: [The phone runs the agent itself](0335-mobile-agent-host.md);
  [The agent runs outside the WebView](0338-headless-agent-runtime.md)

## Context

The phone has its own interface: `apps/mobile/src/views/*`, a React app that
reimplements a subset of the desktop shell against the mobile host. Every desktop
feature has to be rebuilt there, and each rebuild drifts — different spacing,
different row anatomy, different words. The reader notices: "this doesn't look
like our software."

The comparison that prompted this ADR is an Android client that feels complete,
and the reason is structural, not craftsmanship: its phone build runs **the same
web client as its desktop**, pinned by a lock file, with a mobile adaptation
layer patched on top. Native code there supplies device capabilities only. When
the shared client gains a feature, the phone has it.

Spike evidence that we can take the same route:

- the desktop renderer has no direct Electron imports; all host access goes
  through `window.piDesktop.invoke/on`;
- built for web and loaded in a 390×844 window with a stub bridge, it **mounted**:
  212 nodes, real chrome and copy, no crash;
- boot touches **21** channels (`settings/get`, `session/list`, `providers/list`,
  `plugin/themes`, `window/control`, …); the whole renderer references **333**;
- what breaks at 390px is layout, not logic: the sidebar keeps its desktop width
  and the chat column holds a 450px floor, so the main pane is pushed off-screen.

## Decision

The phone loads the desktop renderer. It becomes the second **surface** of one
interface, not a second interface.

1. `data-surface="mobile"` selects the adaptation layer
   (`styles/responsive.css`, `mobile-surface` section). Layout only: the sidebar
   becomes an overlay drawer, the chat column loses its desktop floor, pointer-only
   affordances (the resize handle) disappear.
2. `window.piDesktop` is implemented by a bridge package over the mobile host —
   the same host the current phone UI uses (`LocalAgentHost`, RACP client). The
   renderer never learns it is on a phone.
3. The phone opens with the sidebar collapsed: the conversation is the screen.
4. `apps/mobile/src/views` stops growing. It keeps the native shell (bridge,
   keep-alive, alarms, notifications) and retires screen by screen as the shared
   surface covers it.

## Consequences

- Feature parity stops being a per-feature rebuild; a desktop feature reaches the
  phone through the surface layer.
- The bridge's surface is real work: **333 channel references** today. Only ~21
  are needed to boot, and a screen works when the channels it touches are
  implemented. The bridge must answer `null` for anything it cannot serve, so an
  unimplemented feature degrades instead of breaking the shell.
- The desktop renderer's CSS now has a second consumer. Every desktop rule must
  stay honest at phone width, or the surface layer has to override it — visible,
  reviewable drift instead of invisible divergence.
- The phone's bundle grows from ~0.9 MB to the renderer's size (megabytes, not a
  hundred KB). Acceptable: it replaces a second implementation.

## Alternatives considered

- **Keep maintaining the separate phone app** — proven to drift; this ADR exists
  because that is the observed failure.
- **Extract shared components into a `packages/ui`** — helps, but the drift is in
  composition and layout, not in individual components; a shared kit still leaves
  two shells to keep in step.
- **Run the desktop Electron app inside Android** — no Electron for Android.

## Open questions

- Whether the bridge lives in the WebView (JS, calling Capacitor plugins) or in a
  native/Node host reached over a socket. The WebView path needs no new runtime;
  the Node path is needed anyway for headless runs (ADR 0338).
- How far the surface layer must go before the first screen ships: chat first,
  settings second, panels later.
