# ADR 0322: Serve the media library to the renderer over a confined asset scheme

- Status: Accepted
- Date: 2026-10-09
- Related: ADR 0248, ADR 0255, ADR 0321, ADR video-generation-capability,
  `04-ux/12-media-workbench.md`,
  `packages/shared/src/media-workbench.ts`,
  `apps/desktop/electron/main/media-asset.ts`,
  `apps/desktop/electron/main/media-asset-protocol.ts`

## Context

The workbench can render a video, and the finished file is a real render under
`<data directory>/generated/video`, but the renderer could not play it. A
`file://` URL would put an absolute path into the renderer and is blocked by the
renderer's CSP; the renderer also must never name a filesystem path. Loading the
bytes over IPC and rebuilding a blob for a clip that can be hundreds of megabytes
is the wrong transport, and loses HTTP Range, which is what a `<video>` element
uses to drag-seek.

The host already serves two other renderer-facing resources over confined
schemes reserved before app-ready: plugin theme assets (`plugin-asset://`, ADR
0248) and skin backgrounds (`skin-asset://`). Neither can carry the library:
`plugin-asset` is keyed by loaded-plugin declaration and `skin-asset` is keyed by
an opaque asset id confined to `<data directory>/skins/assets`. Reusing either
would mean reworking its confinement contract to point at a second root, which is
exactly the drift the plugin/skin schemes exist to prevent. A frozen boundary —
the renderer may not read the filesystem — therefore needs one deliberate,
documented exception.

## Decision

Serve the media library to the renderer over one new host-owned scheme,
`media-asset://library/<capability>/<name>`. The path component is the
library-relative render path (`video/<name>` or `image/<name>`); an absolute path
is never carried by a URL. The main process attaches a `url` to a payload only
when an entry names a file that resolves inside the library root, so a `failed` or
`cancelled` entry — which has no `path` — carries no URL.

The request handler answers with the whole file (200) or the requested byte window
(206 + `Content-Range` / `Content-Length` / `Accept-Ranges: bytes`), so a video
element can seek. The containment rule, the Range parser and the response-header
assembly are pure functions in `media-asset.ts`, unit-tested without Electron; the
Electron wiring is `media-asset-protocol.ts`.

The renderer's CSP gains `media-asset:` on `media-src` and `img-src`. A video that
fails to load degrades to the file card plus an explanatory line, never a broken
element.

## Exception channel

Per `AGENTS.md` §4, a deliberate deviation from the frozen boundary states all
five parts in place.

1. **Boundary and prohibition.** This channel may only hand the renderer bytes
   for a file that resolves *inside* the media library root, addressed by a
   library-relative path, over one scheme with one fixed host (`library`). It must
   never grow into a general file reader: the path is percent-decoded, rejected if
   it is absolute, drive-qualified, NUL-bearing, or contains a `.`/`..` segment,
   required to begin with `image/` or `video/`, and proven after joining to sit
   inside the root (with a `realpath` re-check so a planted symlink cannot escape).
   It reads only the library root; it never accepts an absolute path from the
   renderer.
2. **Single source of the wire format.** The scheme name, host, URL builder, MIME
   table, containment rule and Range parsing are owned by
   `apps/desktop/electron/main/media-asset.ts` alone; the renderer never
   constructs a URL, it only consumes the `url` field the main process attaches.
   `apps/desktop/test/media-asset.test.mjs` enforces the shape (URL form, headers,
   rejection vectors) and asserts the startup/shutdown wiring and the CSP entry, so
   the two sides cannot drift.
3. **The coupling.** None: the channel depends only on the library root
   (`mediaLibraryDir(dataDir)`) and Electron's `protocol` API, both of which this
   row owns. It does not reach into another module's internals.
4. **fail-safe behavior.** A missing file, a non-file, an escaping symlink, an
   unknown extension, a malformed request, or an unusable Range fails closed with
   a 404 (or a 416 for an unsatisfiable range). A read error degrades the card to
   its file-name fallback; it must never break the page. The invariant the
   degradation preserves is that no file outside the library is ever served.
5. **Lifecycle pairing.** Setup pairs with teardown: the scheme is reserved in
   `registerApplicationStartup` before app-ready (`registerMediaAssetScheme`),
   its handler is installed after ready (`installMediaAssetProtocol(dataDir)`), and
   the handler is removed on quit (`uninstallMediaAssetProtocol`, from the
   `before-quit` shutdown path). The scheme privileges themselves cannot be
   un-reserved once registered, which is why they are reserved exactly once for the
   process lifetime, alongside the plugin-asset and skin-asset schemes. The handler
   is symmetric across window close, app quit, and shutdown.

## Consequences

- A finished clip plays in place with a progress bar and drag-to-seek, instead of
  a file card that defers to the OS player. The library history plays the same way
  after a restart, because the URL is attached on read rather than persisted.
- The index format is unchanged: `url` is derived at the IPC boundary and never
  written to `index.json`, so there is no migration and no machine-specific scheme
  in persisted data.
- A Range read of `bytes=0-` still materialises that window in the main process,
  like the existing asset schemes read whole files. Streaming the body would be
  the next step if very large clips become common; the pure Range/header layer
  already isolates that decision.
- The scheme serves `image/` renders too, so image playback could later move off
  the data-URL path without a new channel. Today images keep their existing
  thumbnail path.

## Alternatives

- **Reuse `skin-asset` or `plugin-asset`.** Rejected: both are confined to a
  different root and keyed by opaque id / plugin declaration; pointing either at
  the library would break its confinement contract.
- **`file://` or a data URL.** Rejected: the former leaks an absolute path and is
  CSP-blocked, the latter has no Range and inflates a clip into memory.
- **Read bytes over IPC and build a `blob:` URL.** Rejected: no Range, so no
  seeking, and a large clip is copied through the bridge before playback starts.
