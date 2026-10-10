# Media workbench

The media workbench is where the person, not the model, writes the prompt, sets the parameters and watches the output land. It is a first-class page in the sidebar footer (`workbench`, icon `IconImage`), not a settings panel: Settings owns which models are eligible, the workbench owns a single generation. Both routes run the same implementation — the Agent tools `GenerateImages` / `GenerateVideos` and the workbench call the same shared request builders — so a workbench run cannot drift from what the tools produce.

## Information architecture

The page is two columns: **compose** on the left (fixed width, scrollable) and **results** on the right.

Compose, top to bottom: **Model**, **Prompt**, then the parameters that apply to the active capability, optionally **Frames** (video, never required), an **Advanced** disclosure (video), an estimate line, and the submit row. The Image / Video switch is the first decision the page asks for, so it sits in its own row directly under the page title rather than in the title bar: there it read as part of the window controls and was easy to miss. The compose column is the only place a run is configured; switching tabs clears the previous run's results and the frames, because a first frame is not a parameter of an image request and a stale slot would silently attach to the next one.

Results, top to bottom: a status row (elapsed timer, `ok/total` summary, Cancel while running), the error banner when the call itself failed, the output grid, the saved-path list, then **History** for this session.

## Model selection

`Model` opens the same anchored menu the rest of the app uses, with rows grouped by provider, a search field, and a first row meaning **follow the default from Settings**. A row exists only for an enabled, non-OAuth provider that carries a credential or needs none, and models already marked for that capability are badged, so the menu shows what can actually render rather than every model in the catalog. The menu is also scoped to the active capability: the image tab offers models that render images and the video tab models that render video, because a mixed list is how a video model ends up in an image request. A model the user marked is trusted as-is; anything else has to declare the capability in its own name, the same detection the automatic marking uses. Choosing a model sets it for the current run only; it is never written back to Settings, which keeps "the model I use" and "the model I am trying right now" separate decisions. With no candidates configured the menu degrades to a single **Open settings** action and the submit row stays disabled. The line under the control names the model that will actually run — provider and model id — so the two decisions above are never ambiguous on screen.

Candidates come from Settings, and a model that names an image or video family is marked automatically the first time the app sees it (`packages/shared/src/generation-capability.ts`), because a user who has just added a provider should not have to find the capability checkboxes before the workbench can offer anything. Only a capability whose stored list has never been written is seeded; an existing list, including an empty one the user cleared, is left exactly as it is, so the automatic pass can never overrule a decision. Disabled providers and OAuth accounts are skipped, since neither can render.

## Parameters

Parameters are bounded by the same constants the contract validates, imported from `@pi-desktop/shared`, so the UI can never offer a value the runtime refuses.

| Parameter | Image | Video |
|---|---|---|
| Count | 1–4, typed as digits and validated | 1–4, typed as digits and validated |
| Aspect ratio | 1:1 · 4:3 · 3:4 · 3:2 · 2:3 · 16:9 · 9:16 · 21:9 · 9:21, plus **Provider default** | 16:9 · 9:16 · 1:1 · 4:3 · 3:4 · 21:9, plus **Provider default** |
| Resolution | **Smart** (no size sent) · long side 512 · 768 · 1024 · 1280 · 1536 · 1792 · 2048 · 2560 · 4096 (up to 4K), plus a custom `WIDTHxHEIGHT` field | **Smart** (no size sent) · 480p · 720p · 1080p · 2K · 4K, plus a custom `WIDTHxHEIGHT` field |
| Duration | — | preset chips 2–15s, 1–`MAX_VIDEO_DURATION_SECONDS` |
| Reference images | up to 4, edited via the multipart edits endpoint | — |
| Frames | — | first frame, last frame (last requires first) |

Shape and resolution are two controls, not one: a 16:9 frame at 720p and the same frame at 1080p are different requests. They are chosen separately and composed into the single `WIDTHxHEIGHT` the provider receives, and the composed value is shown under the pair before anything is sent. Ratio and resolution are independent axes: the resolution control is always available, **Smart** is always first and always selectable, and a tier chosen with no ratio composes against that capability's first ratio (1:1 for images, 16:9 for video), which the option text states as the size that will actually be sent. Image resolutions name the long side (`3:2` + `1536` is `1536x1024`); video tiers name the short side the way `720p` does (`16:9` + `720` is `1280x720`, `9:16` + `720` is `720x1280`), so a portrait clip and a landscape clip of one tier carry the same amount of picture. Both sides are snapped to multiples of 8, which is what image models with a VAE accept without a silent rescale. **Provider default** for the ratio means no size is sent at all and the model decides. An invalid custom size is reported inline under the field and blocks submit rather than being sent; a valid one is passed through exactly as typed.

**Smart is the default resolution, and it sends no `size` at all.** Providers accept different sets, and a provider can bill by the nearest tier it does support, so a size the model does not offer can be charged as a larger one — picking 480p and paying for 720p. Smart leaves the choice to the model's own default, which is always accepted and never rounds a price up. The explicit tiers stay available for providers whose sets are known, and both the aspect ratio and the resolution keep a provider-default entry.

The count is validated rather than clamped while typing: digits only, and 1 to 4 inclusive. Anything else — zero, five, a decimal, letters, an empty field — is reported inline under the field and blocks submit instead of being silently rewritten into a different request; leaving the field settles it to the nearest allowed value so the box cannot stay wrong. The workbench cap is its own constant and stays inside the runtime's batch caps, so the same request is still valid when the Agent tools issue it.

## Frames (video)

The frames row carries two slots, first and last, each opening the file picker and accepting one image; picking either returns the file through the attachment store first, so a frame is always a contained path. The last frame stays disabled until a first frame exists, with the reason stated on the row. **Advanced** exposes the multipart field names for the two parts, defaulting to the adapter's `input_reference` / `last_frame`; they exist because gateways in front of the compatible API disagree about the names, and an unusable name falls back rather than being sent.

## Cost visibility

Video is billed per second, so a video run states `clips × duration = total seconds` next to the submit button before anything is sent, and the same figure is echoed in the run header. The image estimate states the request count. Neither is an estimate of money — the app has no price table — and neither claims to be.

## Progress and cancellation

The main process reports one event per state change, carrying the generation id, phase (`submitting` / `running` / `done`), the completed count and, when an item changed, that item's index, status and prompt. The renderer adopts the id from the first event and ignores events for another session or another generation, so a background Agent run cannot repaint the workbench. Each requested output gets a card from the moment the run starts — queued, rendering, then its result — in request order, because a batch of eight clips finishes out of order and the user asked for eight specific things. **Cancel** aborts the run through the same runtime cancellation the tools use; the page states that a clip already sent to the provider may still finish and still be billed.

## Results, preview and reuse

An image result renders a thumbnail from the file itself and opens a lightbox on click (previous / next through the batch, Escape to close). A video result plays in place over the media-library scheme (`media-asset://library/<capability>/<name>`), with a progress bar and drag-to-seek backed by HTTP Range; it is not deferred to the operating system. The scheme maps the library root into the renderer by a library-relative path, never an absolute one, and a clip that cannot be loaded degrades to the file card with an explanatory line rather than a broken element (ADR 0322).

## Where a render is written

A workbench run owns its output: images land in `<data directory>/generated/image`, video in `<data directory>/generated/video`. The run needs no chat session to exist, so opening the workbench and generating is one step, and a render is never filed away inside a conversation the user has to keep. The page reads the index once when it opens, so a restart does not erase what the user paid for; a render recorded earlier opens in the results panel like any run that just finished, and saving or revealing it needs no session either.

Each output item is recorded once, in `index.json` beside the renders: capability, path, outcome, prompt, provider, model, size, error code and time. The provider is recorded beside the model because a model id alone is ambiguous — the same id is served by more than one provider — so a row restored after a restart could not otherwise say which one ran. An entry an earlier build wrote carries no provider, and neither does a run that failed before a provider was resolved: both read as unknown, which is the honest answer rather than another provider's name. A `succeeded` item records the file it wrote; a failed or cancelled item records no file but does record its `errorCode`, so a run that produced nothing still leaves a row that says why. `path` is therefore optional, and an index from an earlier build — whose entries all carry one — reads unchanged: there is no migration. The record is bounded (the oldest entries fall off; the files never do), written atomically, and read defensively, but the containment rule that drops an entry now bars only an entry that names a file: a `succeeded` entry whose path no longer resolves inside the library root is dropped rather than handed to the renderer, while a failed or cancelled entry has no file to hand out and is kept exactly as recorded. Recording is best effort: a run that finished is never reported as an error because its index entry could not be written. A run the tool refuses before it starts — no model configured, credentials missing, the model unavailable — and a run that throws both write exactly one `failed` entry, so one run is always one row and a success and a failure never describe the same run. An entry's `url` is derived when the library is read, not stored: it is present only for a `succeeded` entry whose file still resolves inside the library root, so the `index.json` format is unchanged (ADR 0322).

Both roots are validated with the same containment rule the generation path has always applied, so naming a different directory cannot escape the data directory. The Agent tools keep writing into the session scratch, and a run that does have a session keeps that scratch as an input root, so a render from a conversation can still be used as a reference.

Every finished render carries **Save as…** and **Show in folder**, for images and video alike, because a file that only exists inside the session's scratch directory is not a file the user owns yet. Save as opens the OS save dialog with the render's own name, then copies; the result is reported on the card that asked for it, and a dismissed dialog reports nothing. Both channels take a session id and a path, and the main process resolves the file with the same containment rule the generation path applies to its output directory — a path outside the data directory's library root or the session's scratch root, or a path that is not a regular file, is refused — so neither channel can be turned into a general file copier. Every saved path is also listed under the grid, and any image result can be pushed into the reference row to iterate on it.

## Removing, clearing and the library cap

Every history row carries its own remove control, and the list as a whole can be cleared or opened on disk. A row names when it ran, the provider and model that produced it, the size it asked for and, for a failed or cancelled run, why — so after a restart the history still says which provider produced a file rather than only which model id, which several providers serve. Both removals are second-confirmed: removing one row asks *Remove this entry from the history? Its file is moved to the system recycle bin, so you can still recover it.*, and clearing asks *Clear all history? Every entry is forgotten and its file is moved to the system recycle bin. This cannot be undone from the app.*

Removal sends each `succeeded` entry's file to the operating system's recycle bin (`shell.trashItem`) rather than deleting it, because a render cost money and a mistaken removal must be recoverable from the recycle bin. Trashing is best effort by design: a file that is already gone, or an OS that refuses to recycle, never blocks the removal the user asked for. The library service itself only forgets entries — it never touches a file, which is what keeps it free of Electron — so reclaiming the file belongs to the IPC caller. Both remove and clear answer with the surviving list, so the renderer replaces what it shows with what the main process returns rather than editing the list by guesswork.

Opening the library directory resolves the library root, creates it when it is not there yet (`mkdir -p`), and hands it to the OS file manager, so the folder that holds every kept render is one click away.

The history header states the bound the way the record does: `N of 500 kept`, with the note *Only the 500 most recent renders are kept here; older entries drop off the list. Their files stay on disk.* `MAX_LIBRARY_ENTRIES = 500` lives in `packages/shared`, so the main process and the renderer bound the history with the same number: past it the oldest entries drop off the list while their files stay on disk.

## History thumbnails

A history row leads with a small picture of the run's first successful image, so an old render can be found by eye rather than by reading prompts. Only image-capability rows get one: a video row's output is a clip, and a still frame for it is a separate problem, so video rows keep their existing shape. The picture a row loads is the **derived small copy** the main process writes beside the render when it lands — `<data dir>/generated/<capability>/thumbs/<render name>.png`, 64px wide (a 32px box at HiDPI), written by Electron's own image decoder so no image dependency joins the tree. It is served by the same `media-asset://` scheme and the same containment as the render it was made from (ADR 0322): the copy lives under `image/`, the only shape the scheme serves, and `thumbUrl` is attached on read by the same mapping that attaches `url`, so the copy is never an index field and needs no new channel. A row shows exactly one output — the first item that succeeded and carries a URL — so it never jumps between outputs, and a run that produced no loadable image renders as it did before: the image is hidden on load error, with no placeholder and no broken-image icon.

Its boundaries are deliberate. A row that has no copy simply has none: an item recorded before copies existed, or one whose copy could not be written (an unreadable file, a full disk, a non-image capability), carries no `thumbUrl` and falls back to the render itself — the same picture, bigger to decode, exactly the behaviour this section had before. Removal takes the copy with the render — `shell.trashItem` on both, best effort, so a removed row leaves no orphan behind — while falling off the library cap reclaims neither, because the files stay on disk by design. Video rows carry no poster frame: the frame itself is extractable in the renderer, but putting one on disk needs a write path the app does not have, and that is a separate item. The picture is decoration only — it carries no label and no click behaviour — so the row's existing layout, controls and interactions are unchanged.

## Draft persistence

The prompt and the parameters are the work the user did, and they must survive leaving the page or restarting the app rather than being described a second time. The compose state is written to the renderer's own `localStorage` preference record (`pi.desktop.workbenchDrafts`), under the same `pi.desktop.*` namespace the sidebar preferences and the composer model favourites use, debounced so typing does not write on every keystroke. It is pure UI state, so it never touches the host database. The page reads it once when it opens and restores the draft; switching to the other capability restores that capability's own draft, and neither tab's fields bleed into the other.

The draft is exactly what the compose panel holds: prompt, model, count, aspect ratio and resolution (including the custom `WIDTHxHEIGHT` field), duration, and the two multipart frame *field names*. Frame and reference-image slots are **not** stored — they are file paths the attachment store owns for one session, and a path read back after a restart would point at nothing — so only the string field names, which mean the same thing on any machine, are persisted. Nothing sensitive is stored: no credential, token, or provider key is ever written to any persistent store.

Every restored field is validated against the same tables the controls use. A record from an older build, a hand-edited store, or a half-written value degrades per field to that field's default instead of reaching a control that would reject it, so a missing, unreadable or corrupt store can never block the page or disable submit on its own.

A successful run **keeps** the draft: the workbench is an iterative surface and the compose panel never clears itself, so retaining the prompt and parameters changes no existing behaviour and leaves the user their prompt to re-roll, while the run itself is already recorded durably in the media library. A failed or cancelled run keeps the draft for the same reason.

## States

| State | Surface |
|---|---|
| No model configured | model menu restricted to **Open settings**, submit disabled |
| No session open | nothing special: a run needs no session at all, and its render still lands in the library |
| Empty prompt / invalid size / last frame without first | submit disabled with the reason on the relevant row |
| Running | status row with elapsed time and Cancel, item cards advancing |
| Partial success | summary reads `ok/total`, failed cards carry their error code and a per-item retry |
| Call-level failure | error banner above the grid, no item cards |
| History | the library's recorded runs for this capability, newest first and bounded, each removable and clearable, plus the runs made in this session; it survives a restart |
| Draft restored | on open, the last prompt and parameters for each capability are back in place, silently |

All copy is translated in the nine shipped locales and the page uses design-system tokens only; hover styles are gated behind `(hover: hover) and (pointer: fine)` like the rest of the renderer.
