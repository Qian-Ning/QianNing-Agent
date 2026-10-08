# ADR: Video generation as a configured Agent capability

- Status: Accepted
- Date: 2026-10-08
- Related: [image generation capability](image-generation-capability.md);
  [video generation spec](../spec/03-runtime/24-video-generation.md)

## Context

The desktop generates images through one configured binding, an Agent tool and
an OpenAI-compatible adapter. Video is the same shape of problem with different
cost and latency: a render takes minutes rather than seconds, is billed per
second of output, and returns a file the user keeps. A chat model cannot render
video, and a video endpoint cannot be treated as a chat adapter. Users need one
selectable video model, batches with per-item failure reporting, and no change
to their default chat model.

## Decision

Keep a second optional settings binding, `videoGeneration`, next to
`imageGeneration`, referencing the same provider credentials, with its own
candidate list so marking a model for video never marks it for images. Expose
one Agent tool, `GenerateVideos`, plus a bundled lazily loaded `qianning/videogen`
skill. Implement an independent OpenAI Videos adapter and batch scheduler in
agent-runtime: submit, poll, download. The desktop service owns settings,
credentials, the contained first-frame read and the saved output; the renderer
is not involved in execution.

Host-core keeps the whole authorization path: `GenerateVideos` is high risk,
never auto-approved, denied in `plan` and `goal`, authorized only for the
trusted bridge, and validated on the settings channel like image generation,
including dropping a binding whose provider row is gone.

The first version is synchronous for the duration of the turn. A job handle,
background delivery and cross-restart persistence are deliberately deferred
until batches and long clips are common, because they would introduce a task
store the rest of the turn model does not have. Each item carries a ten-minute
budget, the batch a forty-minute ceiling, and cancellation stops local work
without promising that the provider stopped billing.

The download and address rules are shared with image generation in
`agent-runtime/src/media/download.ts` rather than copied, so one security rule
has one implementation.

## Consequences

- A video model is selectable without changing chat behaviour; the two
  capability lists stay independent.
- Cost is user-visible before it is incurred: the approval card names model,
  clip count and duration, and nothing is retried automatically.
- Rendering holds the turn open for minutes. A user who needs long clips or
  many parallel jobs will want the deferred job-handle path; the adapter and
  service boundaries are shaped so that it can be added behind the same tool.
- Only OpenAI-compatible Videos is supported today. A domestic platform or a
  local renderer needs a new adapter mapping, not a change to the tool contract.
- The provider contract is narrower than image generation: `durationSeconds` and
  `size` are sent only when the caller set them, so a provider that requires them
  must be driven through a skill prompt that names them.
