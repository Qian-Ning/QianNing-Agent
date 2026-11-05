# ADR 0342: Live wallpapers as skin backgrounds

- Status: Accepted
- Date: 2026-11-04
- Related: `apps/desktop/electron/main/wallpaper-protocol.ts`,
  `apps/desktop/electron/main/wallpaper-store.ts`,
  `apps/desktop/electron/main/protocol-schemes.ts`,
  `apps/desktop/src/lib/wallpaper-runtime.ts`, `packages/shared/src/skins.ts`

## Context

Skins can carry a still image or a video behind the chat. Both are *files*: one
`assetId` copied into the skin asset directory and served by `skin-asset://`.
A live wallpaper is not a file. It is a project — `project.json`, a scene or web
payload, textures — that needs its own renderer (`webwallgl`) and its own
origin, because the payload is a whole page or a whole scene graph rather than
something an `<img>` can paint.

Three constraints shaped the design:

- **The renderer holds no filesystem authority.** `wallpaper://` is a privileged
  scheme served by the main process from a whitelist of project roots; the
  renderer only ever names an opaque `projectId`.
- **A project directory is untrusted input.** It arrives from a folder the user
  picked, may contain symlinks, `..` segments, or hundreds of megabytes.
- **Electron registers privileged schemes once, as a table.** Four modules
  previously called `protocol.registerSchemesAsPrivileged` independently, so
  only the last call survived and `fetch()` on the others failed. That defect
  is fixed in `protocol-schemes.ts` and is a precondition for this feature.

## Decision

**1. A background kind, not a second field.** `SkinBackground.kind` gains
`"scene"` and `"web"`; both use `projectId` + `projectTitle` and ignore
`assetId`. `sanitizeSkin` drops an unknown `projectId` back to `"none"`, so a
half-copied skin keeps its colours instead of painting an empty frame.

**2. Projects live under the host data directory, keyed by content hash.**
`wallpaper-store` copies a picked directory to
`<dataDir>/wallpapers/<projectId>/`, where `projectId` is the first 16 hex
characters of a SHA-256 over the source path and the newest file mtime. Import
refuses a missing `project.json`, a symlink anywhere in the tree, and a tree
larger than the import cap. Deletion removes the directory; it never follows a
path out of the root.

**3. Routing is `wallpaper://project/<projectId>/<path>`.** The protocol maps
the id to its registered root, percent-decodes, normalises, and rejects any
path that escapes the root. Only roots registered at boot (by scanning
`<dataDir>/wallpapers`) or by an import handler are served. Responses carry
`Range` support so a video-heavy scene can seek, and the served documents are
returned with `frame-ancestors 'none'`.

**4. The renderer owns exactly one instance.** `wallpaper-runtime` imports
`webwallgl` lazily (`scripts: false`, `volume: 0`, 30 fps), mounts into the
skin background layer, pauses on `visibilitychange`, and destroys the instance
on every skin change. Importing the same project twice is a no-op; a stale
`import()` cannot mount after teardown because a generation counter is checked
before and after `mount()`.

**5. The phone build never mounts one.** The shared renderer checks for the
desktop bridge before mounting; the phone has no `wallpaper://` handler and no
`webwallgl` chunk is fetched.

**6. A shared skin carries its project.** `.qnskin` v2 adds an optional
`wallpaper` block: the project's files, base64, minus symlinks, capped at 4096
files and 256 MB. Import restores them under a fresh id owned by the importing
installation and rewrites the skin's `projectId`. A live skin whose project did
not travel degrades to its colours, exactly as a missing image asset does.

**7. Rotation is a skin setting, not a scheduler.** `skinRotation: { enabled,
minutes }` on `AppSettings` (5–1440, clamped). The shell advances every interval
through custom skins that carry a background; colour-only skins are skipped
because rotating them changes nothing visible. A hidden window does not rotate.

**8. The bundled demo animates with CSS, not script.** `webwallgl` mounts web
projects with `scripts: false`, so a demo page driven by `requestAnimationFrame`
renders exactly one frame and looks broken. The shipped demo therefore animates
entirely through CSS keyframes on composited layers — motion that survives the
no-script policy and costs the main thread nothing. A real workshop scene is a
`scene.json` project and never needed scripts at all; the demo exists only to
show the layer working.

**9. Packaging is part of the contract.** The demo reaches a packaged app only
through `build.extraResources`, and `apps/desktop/package.json` used to declare
that key twice — the second array parsed over the first, silently dropping the
`mobile-shell` entry. Both lists are now one array, and
`test/electron-builder-resources.test.mjs` fails if a duplicate key or a missing
runtime asset returns.

**10. Downloads arrive as `.zip`, so the store reads them itself.** A workshop
item downloaded outside Steam is one archive whose project sits one or two
folders deep. `wallpaper-store` parses the central directory with `node:zlib`
rather than taking a zip dependency: entry names go through the same
`safeRelativePath` gate as bundle restore, the scratch folder is removed in a
`finally`, and the root search is bounded to two levels so `__MACOSX` cannot
send it walking. The picker is a file dialog with a `zip/json/pkg/html` filter —
Electron cannot offer files and folders at once, and choosing `project.json`
inside a folder still imports that folder.

**11. `scene` is a format we host, not one we synthesize.** A Wallpaper Engine
scene layer's `image` points at a **model JSON** (`models/…json`), which resolves
a material, which resolves the texture — a hand-written `scene.json` whose
`image` names a PNG parses but draws nothing, which is how this was learned. The
bundled demo is therefore `web`, and the scene path is exercised against real
workshop projects, not fixtures we invent.

**12. A project that only names a `scene.pkg` is refused at import.** The store
used to accept any folder holding a `scene.pkg`, copy it, and register it — the
renderer then mounted an empty frame, which the user reads as a broken app
rather than as an unsupported format. `wallpaperProjectProblem()` now classifies
before copying: a manifest whose `file` ends in `.pkg`, a bare package, or a
manifest naming an entry that is missing all answer `packaged`, and the import
fails with `WALLPAPER_PACKAGED` so the renderer can say what to do (unpack it
first) instead of repeating a generic error. Stored projects that no longer
classify are skipped at boot with a log line, and their skin keeps its colours.

**13. A dropped file is the same import as a picked one.** Electron puts the
absolute path on a dropped `File`, so the skin center treats a drop as
`importWallpaper("path", …)` — one code path, no second validation. The drop
target is a dashed outline plus a floating label rather than a full veil: the
gallery has to stay visible while the user is deciding what to drop onto it.

**14. Rotation says when it cannot rotate.** The switch is disabled below two
background-carrying skins, with the reason in place of the interval select.
Making it a live-looking control that silently never fires is the failure mode
being avoided, not a cosmetic nicety.

**15. Swapping a wallpaper edits the skin; it never creates one.** The tile menu
offers 更换壁纸 only for skins that already carry a live background, and the swap
runs through `save` with the stored copy as its base: id, name, palette and rail
position survive, and the replaced project is deleted only once nothing points
at it — the same ownership rule that already governed replaced media files.

**16. A wallpaper mounted behind a hidden window is rebuilt, not resumed.** The
live-wallpaper leak measurement turned up something worse than a leak: an
instance mounted while the window was minimised stayed frozen on screen after
the window came back. `webwallgl` pauses a page source's CSS animations at
mount, and `play()` does not restart them, so `pause()`/`play()` alone can never
recover that instance. The runtime now records `pausedAtMount` and destroys and
remounts the project on the first visible frame — the only state the renderer
animates in. Measured over 40 switches: total process RSS flat (1496 → 1403 MB),
GPU flat (379 → 279 MB), one layer node, one wallpaper document, ~0.1 MB per
switch on that document.

**17. The release CSP keeps `wallpaper:` in `connect-src`.** Dev and release
builds do not share a CSP: `electron.vite.config.ts` rewrites the meta tag for
production, and that rewrite used to collapse `connect-src` to a bare `'self'`.
The renderer fetches `project.json` and scene files over `wallpaper://`, so the
packaged app refused every wallpaper while the dev build looked perfect — the
kind of bug only a packaged run can show. The rewrite now keeps the scheme, and
a test pins the string.

**18. Bundled gallery is data, not a second code path.** The app ships five
ready-made projects under `resources/wallpapers/`, each a `web` project whose
motion is pure CSS (the engine mounts with `scripts: false`). The renderer never
sees a path: `listWallpaperPresets` returns `{id, title, accent, bytes}` and
`installWallpaperPreset` copies the folder through `importWallpaperSource`, the
same function a dropped ZIP uses — so validation, id minting and root
registration cannot drift from the user-facing import. The tile paints the
photograph's average colour from `project.json` rather than a second copy of the
image; the gallery costs 1.3 MB of installer, not 2.6. Sources are CC0
(Unsplash, mirrored on Wikimedia Commons) and recorded in
`resources/wallpapers/ATTRIBUTION.md`. An unknown id is refused by matching the
directory listing first, never by joining the string.

**19. A card shows the project's own still.** A 152 px tile cannot mount a
project, so every project that ships `preview.png|jpg|…` now carries that file
name on the skin background (`preview`, a bare name validated against
`[\w.-]{1,64}`), and `SkinPreview` paints it from
`wallpaper://project/<id>/<preview>`. The name is persisted because the
alternative — guessing between five extensions per tile — turns a gallery into
five 404s per card. Bundled presets ship a 640 px still (205 KB for five); an
imported project without one keeps the palette gradient.

**20. Photo and project swaps are different verbs with one owner rule.** A
`web`/`scene` skin swaps by copying a folder (`changeWallpaper`), an
`image`/`video` skin by storing one file (`changeMediaWallpaper`), and the menu
decides by `background.kind`. Both funnel through `save`, so the replaced
background is released by the same "still referenced?" test — no separate
cleanup path for the newer verb.

**21. A project with no still is captured, not withheld.** Cards need a
picture, and workshop projects do not always ship one. On import the project is
loaded once in a hidden window — JavaScript off, no preload, destroyed after the
frame — and `capturePage` writes `preview.png` back into the copied project. The
URL is the same `wallpaper://` root the app would mount, so the still cannot
drift from what the engine paints. Scenes often open on a dark frame (the
bundled sample fades in over 18 s), so three frames are sampled and the
brightest kept; a capture failure leaves the import intact, only the card falls
back to the palette.

**22. The gallery paints photographs, not swatches.** Each bundled preset sends
its 640 px still inline as a data URL (~60 KB per card, once) instead of opening
a second protocol that would exist only to serve five images. The tile keeps its
accent colour underneath, so a card is never blank while the still decodes.

## Consequences

- Skins keep working unchanged: the persisted shape only gained an optional
  branch, and older records sanitise to the same values as before.
- A live wallpaper costs one GPU context while selected, and nothing when a
  colour, image, or video skin is active — the renderer chunk is not evaluated
  until a project is actually mounted.
- `scene.pkg` container extraction (the Wallpaper Engine repack format) is not
  part of this decision. Import accepts an extracted project directory, which is
  also the only shape a machine without Wallpaper Engine can supply.
- Chrome over a background is frosted glass, not a cut-out: the sidebar, the
  conversation top bar, and the composer carry `backdrop-filter` with a veil
  whose alpha is themed (0.34 dark, 0.52 light). The light theme needs the
  thicker wash because its secondary ink is authored for a white page, and its
  muted sidebar labels switch to primary ink while a background is active.
- The root canvas must go transparent with the rest of the shell. It previously
  kept the theme surface colour, which painted over the background layer at
  `z-index: -1` — the reason a wallpaper could be mounted correctly and still be
  invisible.
- A live project gets a scrim floor of 0.3 regardless of the skin's setting: a
  bright scene under a dark theme otherwise leaves white labels on a pale wash.
  Still images and video keep the value the skin chose.

## Alternatives considered

- **Serve the project from `file://`** — grants the payload the filesystem
  origin and bypasses the root whitelist.
- **Blob URLs built in the renderer** — requires reading every asset through
  IPC, duplicates the whole project in memory, and breaks relative imports
  inside the payload.
- **One `assetId` per project file** — multiplies the skin asset model and
  cannot express "load `project.json`, then whatever it references".
