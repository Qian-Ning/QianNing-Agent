---
name: videogen
description: Generate short videos with the configured video model. Supports a first-frame image, variants, batches, and a requested duration and size. Rendering takes minutes and is billed per second by the provider.
---

# Video generation

Use the desktop `GenerateVideos` tool. The user selects its provider and model
under Settings → Models → Video generation model; this is independent of the chat
model. If ToolSearch is available and GenerateVideos is not loaded, discover it
there first. Do not install an SDK, run an API script, ask for a key in chat, or
substitute the conversation model.

## Prepare the request

- Video prompts work best as one continuous shot: name the subject, the action,
  the camera (locked-off, slow push-in), the lighting and the setting. Avoid
  asking for cuts, scene changes, or long dialogue.
- Text in frame, exact logos, and precise legibility are unreliable in generated
  video; say so instead of promising them.
- A clip runs for seconds, not minutes. Choose `durationSeconds` for what the
  shot needs and leave it out for the provider default; shorter clips finish
  sooner and cost less.
- `size` is a `WIDTHxHEIGHT` string such as `1280x720`. Leave it out unless the
  user asked for an aspect ratio.
- For an animated still, pass one local image as `image` and describe the motion
  in the prompt. Inputs must be under the current project, session scratch
  directory, or attachment store. Do not use remote URLs.

## Generate one clip or a batch

Call `GenerateVideos` with `items`, where each item has `prompt` and optional
`count` (default 1), `image`, `durationSeconds` and `size`. Use one item with
`count` for variants of the same prompt; use separate items for distinct shots.
A batch permits at most 4 videos total.

Example: two variants of a title shot and one separate shot:

```json
{"items":[{"prompt":"Slow push-in on a ceramic cup on a quiet desk, warm daylight, steam rising, locked horizon, no text","count":2,"durationSeconds":6,"size":"1280x720"},{"prompt":"A green leaf falling onto still water, close-up, soft overcast light","durationSeconds":4}]}
```

Rendering is minutes long: a single call can take several minutes before it
returns, and the desktop keeps the turn open while it runs. Every clip is billed
per second by the provider, so generate only the quantity the user asked for and
do not add unrequested variants.

Do not retry failed or timed-out items automatically, including after
cancellation: the provider may already have rendered and billed them. Report
partial success and wait for a user request before retrying. If no video model is
configured, direct the user to Settings → Models; do not select one silently.

## Deliver the result

Results are ordered and contain a status and, for successes, a local video path
(mp4, webm, or mov) and its duration. Report each successful path and duration,
and report failed items. The desktop renders playable cards for the successful
clips directly from the tool result; if you reference a path yourself, use a
plain path rather than a Markdown image link, since a video is not an image.

For project deliverables, copy the selected clip into the requested project
location using existing file/shell tools and update the consuming reference. Use
a new filename unless replacement was requested. Preview-only clips may remain in
session storage. Report the final project paths, the prompt used, and any
requested clips that did not complete.
