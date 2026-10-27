# ADR 0334: The phone client is an app, not a page in a string

- **Status:** Accepted
- **Date:** 2026-10-27
- **Supersedes:** the client-shell half of [ADR 0333](0333-remote-entry-point.md) P2
- **Implemented:** `apps/mobile`, `apps/desktop/electron/main/remote/app-shell.ts`

## Context

ADR 0333 P2 shipped the smallest thing that could demonstrate remote control: a
single HTML document authored inside a TypeScript template literal in
`apps/desktop/electron/main/remote/app-shell.ts`, served at `/app`, with a second
copy extracted into the Android WebView by `sync-shell.mjs`.

It demonstrated the protocol. It did not survive contact with use.

1. **A page in a template literal cannot be built.** No imports, no type
   checking, no component model. A backtick inside a comment terminated the
   string and the page loaded blank with no error anywhere — three times.
2. **It re-fetched the transcript on every event.** `handleEvent` called
   `loadHistory()` for each `item.*` frame and re-rendered the whole document
   from an HTML string. On a phone, a running turn meant a request storm, a
   visible flicker, and a scroll position that jumped.
3. **It ignored streaming.** The Host already emits `item.delta` with
   incremental `deltaText` / `deltaThinking`. The page never read those frames,
   so an answer appeared whole at the end — the one behaviour that separates an
   agent client from a chat form.
4. **It was English-only.** Every string was hard-coded, in a product with nine
   locales, on the surface most likely to be handed to someone else.
5. **The two delivery paths drifted by construction.** The APK bundled an
   extracted copy, so "the app" and "the page" were only equal by discipline.

The complaint that started this was "it does not feel like our Agent". That is
an accurate reading of all five.

## Decision

The phone client is a real application package, `apps/mobile`, built with Vite
and React.

- **One bundle, two delivery paths.** `vite build` produces `dist/`. The Host
  serves it at `/app`, and Capacitor packages the same `dist/` for Android.
  There is no extraction step and no second copy.
- **The Host owns only the mapping.** `serveClientShell` turns a URL into a file
  from the bundle: the document at `/app`, `/app/`, `/` and `/index.html`, hashed
  assets under `/assets/` or `/app/assets/`, nothing outside the directory.
  Packaged builds read `resources/mobile-shell` (electron-builder
  `extraResources`); a checkout reads `apps/mobile/dist`.
- **Deltas are applied, history is not refetched.** `item.delta` grows the
  bubble; the transcript is re-read only on `resync.required`.
- **A late history read merges under live rows.** The initial `session/history`
  can land after the stream has already painted; replacing the list there would
  erase what the user watched arrive.
- **The phone localises itself.** `apps/mobile/src/lib/i18n.ts` carries the
  phone's own catalog (zh/en). Desktop catalogs are shaped around desktop
  surfaces; the phone has different nouns and should not grow desktop keys.
- **Markdown is rendered, not escaped.** Fences, inline code, emphasis, links,
  lists, quotes — the shapes agents actually emit.

## Consequences

- `sync-shell.mjs` and `apps/mobile/www/` are gone; `capacitor.config.ts` points
  at `dist`.
- A page defect is now a compile error or a failing test instead of a blank
  screen. `apps/mobile` has its own test suite, including a streaming test that
  asserts a delta reaches the DOM and that deltas do not trigger refetches.
- **Packaging gained a requirement:** the mobile bundle must be built before the
  desktop installer is made. `pnpm -r build` already builds every workspace
  package, so the ordinary build is sufficient; a packaging run that skips it
  ships an installer whose `/app` answers 404.
- The Host does one `readFileSync` per request. The client is a few hundred
  kilobytes served once per device; a cache would be premature, and a stale
  cache across a rebuild is a worse failure than a file read.
- Android builds still depend on a local SDK, as before. The app no longer
  depends on the Host being reachable to open — it starts, then asks which
  computer to talk to.
- The protocol is unchanged. No RACP operation, HTTP route, permission, or
  storage format moved.

## Alternatives rejected

- **Keep the inline page and improve it.** The failure modes are properties of
  the form: no build step means no imports and no type checking, and rebuilding
  a document from a string means the flicker stays.
- **Serve the page from a separate static host.** It would need CORS for `/app`
  itself, and the page must be reachable on a LAN with no internet.
- **A React Native client.** The Host already speaks HTTP/SSE, the UI is
  text-shaped, and the same bundle has to run in a browser for a device that
  has not installed anything. A WebView plus the same bundle is strictly less
  work than a second renderer.
