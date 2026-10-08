# Video generation

The desktop exposes `AppSettings.videoGeneration` as the current default video-generation binding and `AppSettings.videoGenerationModels` as the optional list of models marked for video generation. A null or empty current binding means no default; host-core validates and persists both fields through the existing settings store. No schema bump is needed, and the image-generation fields keep their own meaning: marking a model for video does not mark it for images, and the two candidate lists are independent. A reference that no longer matches an existing provider row is not persisted: host-core drops the current binding and the matching candidate on every settings read and write, mirroring the reference rule config sync applies when it applies a bundle, so a deleted provider cannot leave behind a default the runtime must reject. Each candidate references an existing enabled API-key or no-auth provider and one of its configured models; at most 64 candidates are stored. A model whose id names an image or video family is marked automatically the first time the app sees it, so the workbench has something to offer without the user finding the capability checkboxes first: the detection table lives in `packages/shared/src/generation-capability.ts` and matches whole segments for short or ambiguous tokens, so `imagen-4.0-generate` is an image model rather than a Runway `gen-4`. Only a capability whose list has never been written is seeded — an existing list, including an empty one, is never overwritten — and disabled providers and OAuth accounts are skipped because neither can render.

## Configuration

`videoGeneration` accepts one binding of `{providerId, modelId}` with non-empty values (provider up to 128 characters, model up to 256). `videoGenerationModels` accepts up to 64 such bindings and must be an array when present; a malformed binding, a non-array list, or an oversized list is rejected with `INVALID_PARAMS` before anything is stored, so a rejected save leaves the previous settings intact. Config sync validates both keys against existing provider rows when it applies a bundle and lists them in the video domain, so an imported bundle cannot reference a provider the device does not have.

Selecting, changing and clearing the binding is a settings write like any other; the runtime reads the binding per call instead of caching it, so a change takes effect on the next `GenerateVideos` call without a restart. A binding whose provider exists but is disabled, belongs to an OAuth account, or carries no credential is not repaired silently: the call fails with the matching `VIDEO_*` code below and the stored binding stays, because only the user can decide whether to re-enable the provider, add a key or pick another model.

## Agent contract

`GenerateVideos({items: [{prompt, image?, lastFrame?, count?, durationSeconds?, size?}]})` is an Agent-mode tool. `items` takes 1–8 entries; `count` defaults to 1 and accepts 1–8, and the expanded batch is capped at 8 videos in total, so `count` and entry count cannot multiply past the cap. `prompt` is trimmed and bounded at 32,000 characters. `durationSeconds` accepts an integer from 1 to 15 and is sent only when present, because the provider bills per second. `size` accepts a `WIDTHxHEIGHT` string of two to five digits per side and is sent only when present; the model's own default applies otherwise. `image` is one local path used as the clip's first frame, and `lastFrame` is one local path used as its last. A last frame requires a first frame and is refused without one, because the compatible adapter sends the pair as a bracketed transition; both are resolved through the same containment rule. Unsupported shapes, empty prompts, out-of-range numbers and excess entries are rejected with `INVALID_ARGUMENT` rather than truncated or silently dropped, and a prompt is never fanned out into extra clips beyond the requested count.

The bundled `qianning/videogen` skill is discoverable in ordinary sessions and loads through the existing Skill tool. It teaches when to call the tool, how to write prompts for motion, how a first frame changes the result, that rendering takes minutes and is billed per second, to generate only what was asked, to report partial failures instead of retrying, and to report each returned local path. It does not grant permission and carries no credentials.

The trusted desktop bridge first calls host-core `tools.execute` with the same identity, arguments and permission scope. Host-core classifies `GenerateVideos` as high risk, never auto-approves it in `ask` or `accept-edits`, denies it outright in `plan` and `goal`, and answers the authorization call with `authorized: true` only for the trusted bridge; the bridge then runs the video service. The approval card names the model, the number of clips and the requested duration, since a batch can incur per-second cost. Runtime cancellation is registered for the same tool path as Bash and image generation: it reaches the pending approval, stops queued items and aborts the in-flight HTTP request. Cancellation cannot promise the upstream provider stopped processing or billing; finished files survive. Host loss or sidecar disposal aborts local work the same way.

## OpenAI Videos adapter

Only OpenAI-compatible Videos is supported. A root base URL acquires `/v1`; an explicit path prefix is retained. A job is submitted with `POST videos` and polled with `GET videos/{id}` at a 5-second interval. The create request carries `model` and `prompt`, plus `seconds` and `size` when the caller set them; with a frame the same request is sent as multipart and without one it is JSON. The frame parts take their names from `frames: {first?, last?}` when the caller sets them and fall back to `input_reference` and `last_frame` otherwise; a name is accepted only when it matches the form-field pattern, so a caller can never inject extra headers or fields through it. The provider credential is sent as a `Bearer` header on provider calls only. Provider calls never follow redirects (`redirect: "error"`). A provider that submits and returns a final URL without an id is accepted; a job that reports a terminal failure status fails that item; a job whose id cannot be found fails with `VIDEO_JOB_NOT_FOUND` instead of polling forever.

Each item has a 10-minute budget and the batch has a 40-minute ceiling; the poll loop checks the deadline before sleeping, so a provider that never finishes ends as `VIDEO_TIMEOUT` rather than hanging the turn. The batch runs two items at a time and returns results in input order with the index of each item, so a partial failure keeps its place in the report. Requests are never automatically retried. An authenticated failure stops queued work and reports the remaining items as stopped; a non-authentication failure fails only that item and leaves the rest of the batch running.

JSON bodies are bounded at 256 KiB and a declared `Content-Length` above the bound is rejected before reading. The finished file is downloaded to the session's scratch directory as `generated-<uuid>.mp4` (or `.webm`, `.mov`), is capped at 256 MiB, and must carry a recognised container signature for the extension it is stored under. Downloads use checked, pinned public DNS addresses, reject redirects and private destinations, and never receive provider headers. When Settings > General > Network explicitly enables proxy fake-IP support, a benchmark-range fake-IP answer uses the app's proxy-aware transport; real private, loopback, link-local and metadata addresses remain blocked.

A frame is read from the session project, that session's scratch directory, or the attachment store, after realpath containment; anything outside those roots, a path that does not exist, or a file that is not a recognised image is refused with `VIDEO_FRAME_UNAVAILABLE` and that item alone fails. Credentials remain outside the renderer and tool results.

## Errors

| Code | Raised when | Scope |
| --- | --- | --- |
| `INVALID_ARGUMENT` | the tool payload fails the shape and bound checks | the call |
| `VIDEO_NOT_CONFIGURED` | no usable default binding is stored | the call |
| `VIDEO_MODEL_UNAVAILABLE` | the provider is disabled, missing, or does not list the model | the call |
| `VIDEO_AUTH_UNSUPPORTED` | the provider authenticates through OAuth | the call |
| `VIDEO_AUTH_FAILED` | no credential, or the provider answered 401/403 | the batch |
| `VIDEO_INVALID_ENDPOINT` | the provider base URL cannot form a request | the call |
| `VIDEO_HTTP_<status>` | the provider answered any other non-success status | the item |
| `VIDEO_INVALID_RESPONSE` | a response body is oversized, unreadable, or missing its job id and URL | the item |
| `VIDEO_JOB_FAILED` | the job reported a terminal failure status | the item |
| `VIDEO_JOB_NOT_FOUND` | the polled job id is gone | the item |
| `VIDEO_TIMEOUT` | the item budget or the batch ceiling elapsed | the item |
| `VIDEO_CANCELLED` | the turn was cancelled before or during the request | the item |
| `VIDEO_REQUEST_FAILED` | a transport failure without a more specific code | the item |
| `VIDEO_FRAME_UNAVAILABLE` | a frame is outside the allowed roots or is not an image | the item |
| `VIDEO_TOO_LARGE` | the finished file exceeds the download bound | the item |

A failed item never discards the batch: successful clips keep their local paths, and the report names every failure with its code and prompt index. Nothing is regenerated automatically, including a failed clip, because every retry is a new billed render.
