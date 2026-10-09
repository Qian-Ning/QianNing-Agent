---
title: Media workbench
description: Generate images and videos without a chat session — pick a model, set real parameters, and keep the files.
---

# Media workbench

The media workbench is where you — not the agent — write the prompt, set the parameters and watch the output land. It is a first-class page in the sidebar footer, beside Settings, and it is the only place a generation run is configured by hand.

Settings and the workbench divide the work: Settings owns which models are eligible for image or video generation, the workbench owns one run. Picking a model here sets it for that run only and is never written back, so "the model I usually use" and "the model I am trying right now" stay separate decisions.

A run needs no conversation. Open the workbench, describe what you want, generate; the result is a file you own, not a message filed inside a session you have to keep.

[中文版本](/zh-CN/guide/media-workbench)

## Open the workbench

Choose the workbench icon (the image icon) in the sidebar footer. The page is two columns: **Compose** on the left, **Results** on the right. The **Image / Video** switch sits directly under the page title and is the first decision the page asks for.

Image and video are different jobs, so each keeps its own prompt, its own results and its own history. Switching tabs does not carry a prompt or a frame from one to the other.

## Choose a model

**Model** opens a grouped, searchable menu. Its first row follows the default from Settings; the rows below are grouped by provider.

- The menu is scoped to the active tab: the image tab lists models that render images, the video tab models that render video.
- A model you marked in Settings is trusted as-is; any other model has to name an image or video family in its own id to appear.
- A **local** provider is exempt from that name check, because a self-hosted server names its models after files. See **Model compatibility** below.
- With no eligible model configured, the menu collapses to **Open settings** and **Generate** stays disabled.

The line under the control names the provider and the model id that will actually run.

## Parameters

The controls are bounded by the same constants the runtime validates, so the page cannot offer a value the request would refuse.

| Parameter | Image | Video |
|---|---|---|
| Count | 1–4, typed and validated | 1–4, typed and validated |
| Aspect ratio | 1:1 · 4:3 · 3:4 · 3:2 · 2:3 · 16:9 · 9:16 · 21:9 · 9:21, plus **Provider default** | 16:9 · 9:16 · 1:1 · 4:3 · 3:4 · 21:9, plus **Provider default** |
| Resolution | **Smart** · long side 512 to 4096 px, plus a custom `WIDTHxHEIGHT` | **Smart** · 480p · 720p · 1080p · 2K · 4K, plus a custom `WIDTHxHEIGHT` |
| Duration | — | 2–15 s presets; default 8 s |
| Reference images | up to 4, sent to the multipart edits endpoint | — |
| Frames | — | first frame, last frame (last needs a first) |

Aspect ratio and resolution are two independent controls, not one. A 16:9 frame at 720p and the same frame at 1080p are different requests. Choose each, and the page shows the composed size it will send before anything leaves the machine. Image resolutions name the long side (`3:2` + `1536` is `1536x1024`); video tiers name the short side the way `720p` does (`16:9` + `720` is `1280x720`), so a portrait clip and a landscape clip of one tier carry the same amount of picture.

**Smart** is the default resolution, and it sends no size at all. Providers accept different sets, and a provider can bill the nearest tier it does support, so choosing 480p where the model has no 480p tier can be charged as 720p. Smart leaves the size to the model's own default, which is always accepted. **Provider default** for the aspect ratio leaves that choice to the model too. A custom size is reported under the field and blocks submit when it is invalid, rather than being sent.

The count is validated as you type, not clamped: digits only, 1 to 4. Zero, five, a decimal, letters or an empty box are reported inline and block submit instead of being silently rewritten; leaving the field settles it to the nearest allowed value.

## Reference images and frames

**Reference images** (image) take up to four images, which turn a plain prompt into an edit. That run goes to the multipart edits endpoint.

**Frames** (video) take a first frame, a last frame, or both. The last frame stays disabled until a first frame is set, and the reason is stated on the row. A gateway in front of the compatible API may name the two parts differently; **Advanced** exposes the field names, defaulting to `input_reference` and `last_frame`.

## Cost, progress and cancellation

Video is billed per second, so a video run states `clips × duration = total seconds` beside the submit button before anything is sent, and repeats it in the run header. An image run states its request count. Neither figure is a money estimate — the app has no price table — and neither claims to be.

Each requested output gets its own card from the moment the run starts — queued, then rendering, then its result — in request order, because a batch can finish out of order. **Cancel** aborts the run through the same cancellation the agent tools use, but a clip already sent to the provider may still finish and still be billed; cancellation cannot promise otherwise.

## Results, preview and reuse

An image result shows a thumbnail of the file itself and opens a lightbox on click, with previous / next through the batch and Escape to close. A video result is a file card naming the container and the duration; the workbench does not embed a player, so playback belongs to the operating system.

Every finished result carries **Save as…** and **Show in folder**, for images and video alike, because a file that exists only inside the app is not a file you own yet. Any image result can be pushed back into the reference row with **Use as reference** to iterate on it.

## Where renders are written

A workbench run owns its output: images land in `<data directory>/generated/image`, video in `<data directory>/generated/video`. A packaged installation uses `~/.qianning-agent` as its data directory by default.

Each output is recorded once in an `index.json` beside the files — capability, path, outcome, prompt, model, size, error code and time — so the library survives a restart and a render made earlier opens in the results panel like one that just finished. A run that succeeded records the file it wrote; a run that failed or was cancelled records no file but records why, so an empty result still has a row instead of a blank. The record list is bounded; the files are not.

**History** under the results lists this capability's recorded runs, newest first, plus the runs made in the current session.

## Cleaning up and recovering

**History** rows carry their own remove control, and the list can be cleared or opened on disk.

- **Removing** one row asks first: *Remove this entry from the history? Its file is moved to the system recycle bin, so you can still recover it.*
- **Clearing** asks: *Clear all history? Every entry is forgotten and its file is moved to the system recycle bin. This cannot be undone from the app.*
- Both move files to the system **recycle bin** rather than deleting them, so a mistaken removal can be recovered from there; if the recycle bin refuses a file, the removal still goes through.
- The **folder** button opens the library directory itself.

The history header shows how much room is left — *N of 500 kept* — with the note *Only the 500 most recent renders are kept here; older entries drop off the list. Their files stay on disk.*

## Model compatibility

The workbench talks to providers in the OpenAI-compatible shape: images through `POST /v1/images/generations`, video through `POST /v1/videos` and polled by job id. A root base URL gains `/v1`; an explicit path prefix is kept.

- A **local** provider — a loopback address or a private one such as `192.168.*`, `10.*` or `172.16–31.*` — is marked **Local** in the model menu and is exempt from the name-based capability check, because its model names are file names and would otherwise be hidden. Built-in presets include **Ollama**, **LM Studio** and **LocalAI** on their default local addresses.
- **ComfyUI** and **Stable Diffusion WebUI** expose their own native APIs, which are not the OpenAI shape. They need a compatible wrapper or proxy in front; the workbench cannot call them by address alone.

The same request builders back the agent tools `GenerateImages` and `GenerateVideos`, so a workbench run and a tool run produce the same kind of request.

## Go deeper

| Your next task | Read |
|---|---|
| The full on-screen contract | [Media workbench specification](/spec/04-ux/12-media-workbench) |
| The video request contract and error codes | [Video generation](/spec/03-runtime/24-video-generation) |
| Add a provider or a local server | [Your first project session](/guide/first-session) |
| Where files and secrets live | [Data, privacy, and security](/guide/data-and-security) |
