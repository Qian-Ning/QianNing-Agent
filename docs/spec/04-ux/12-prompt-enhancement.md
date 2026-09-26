# Composer Prompt Enhancement

> **Status (D629): UI removed.** QianNing Agent removed both user-facing entry
> points for prompt enhancement — the composer Sparkles action and the
> Settings ▸ AI 「提示词增强」 card — because the persona model was reduced to a
> single editable scope and a separate one-shot draft rewriter competed with it.
> The host bridge, the `pi-desktop/prompt/enhance` invoke channel, the one-shot
> runtime, and the abort/timeout guard described below are **retained** so the
> feature can be restored without backend work; they simply have no UI trigger
> in this build. The sections below describe that retained backend contract.

## 1. Scope

The prompt-enhancement capability supports a one-shot `Enhance prompt` request
for a non-empty draft. When it had a UI, the Composer rendered it as a
standalone Sparkles action beside the model selector. When invoked, the
request rewrites only the draft text with the
model currently displayed in the Composer. Inline file-reference chips,
including pasted image chips, remain unchanged and do not disable the action.

This is a v1 utility action, not an agent turn: it does not append a message,
read session history, run tools, or persist a transcript row.

## 2. Availability and interaction

The Sparkles action is enabled only when all of the following are true:

- the draft is non-empty after trimming;
- the effective displayed provider/model is enabled and authenticated, using
  the same readiness predicate as Send; and
- the trimmed draft does not start with `/`.

While the request is running, the action is disabled and shows the shared
`.tool-spinner` plus the localized `Enhancing…` label. Sending remains allowed.
The Composer sends `providerId`, `modelId`, and `thinkingLevel` from the
currently displayed model selector; main validates those values and falls
back through session, draft, global, and provider defaults when a snapshot is
missing or stale.

On success, the trimmed result replaces the text, the caret moves to the end,
and a single `Undo enhancement` action restores the exact pre-enhancement text.
Any user edit, send, or Composer session switch clears the undo action.
There is no multi-level history, keyboard shortcut, or cancel action.

## 3. Request and provider boundary

Renderer requests use the allowlisted `pi-desktop/prompt/enhance` invoke
channel. Electron main resolves the effective provider/model through the same
runtime launch resolver used for agent turns, reads API credentials only in
main, and invokes agent-runtime's one-shot completion helper. Vendor OAuth
providers receive a short-lived `ModelAuth` through the existing main-owned
resolver; no key or refresh token crosses into the renderer.

The completion context is a built-in system prompt plus one user message built
from a built-in user template. Both live in
`packages/shared/src/prompt-enhancement.ts` and are the product's own: nothing
in Settings can replace them, so there is exactly one possible context shape.
The template carries a `{{draft}}` placeholder and keeps the draft inside
`<draft>` tags so draft text reads as content to improve rather than as
instructions. The system prompt states the role, the rewrite principles, an
explicit do-not list (including leaving code, commands, file paths, identifiers,
and other proper nouns exactly as written), language-following rules that forbid
language meta notes, a length brake (do not expand beyond roughly twice the
draft's length; a long draft may stay long), and the output contract.

No prior conversation, tools, attachments, or session state are included. The
renderer removes its inline file-reference chip tokens before the request and
restores those chips in their original order and relative position after the
text response; the model is not trusted to preserve opaque renderer sentinels.
The selected thinking level is passed to pi-ai, and provider setup retries use
the existing bounded retry controller. When the resolved provider is OpenCode Go
(or another `opencode.ai` host), the one-shot forwards the Composer session id
as `x-opencode-session`; a request with no session gets a per-call id. Model
output is consumed as plain text, has one matching pair of wrapping quotation
marks removed, has a leading rewrite label such as `Enhanced:` stripped, and is
trimmed. Empty or whitespace-only output is a `PROMPT_ENHANCEMENT_EMPTY`
failure.

The handler bounds one request with a 60-second ceiling. On expiry it aborts
the in-flight request (best-effort: the transport consults the signal between
provider retries) and races the promise so the caller is released. The action
fails with `TIMEOUT`. It does not silently retry on the session model: the user
chose the pinned model, and a hidden second attempt would double the wait.

## 4. Failure and race handling

Failures preserve the current draft and render a dismissible Composer error
bar containing the classified error message and code. Existing provider codes
such as `PROVIDER_UNAUTHORIZED`, `NETWORK_ERROR`, and `TIMEOUT` are reused.

The renderer captures the draft key and an edit generation when starting a
request. If the draft changes, is sent/cleared, or the user switches sessions
before the response arrives, the response is discarded and cannot overwrite
the newer draft. File chips are not included in the rewrite and are not
removed by success or failure.


## 5. Model and reasoning

Settings -> AI hosts a Prompt enhancement card. It has no editor and no
template fields: the rewrite instructions are the product's own (§3), and
offering both a persona editor and a rewriter editor on the same surface is what
made the prompt model unreadable. The card carries exactly two rows, the model
and the reasoning level. The model row is titled `Default model` and uses the
same anchored, searchable menu as Settings -> Models' default-model row.

| Field | Effect when empty |
|---|---|
| `promptEnhancementProviderId` + `promptEnhancementModelId` | follow the Composer's current model |
| `promptEnhancementThinkingLevel` | `off` |

Both destinations therefore offer one kind of model picker. Both rows read
`Default model`; the card heading (Prompt enhancement vs Models Defaults) is
what separates the conversation's default from the enhancement's. When
`promptEnhancementProviderId` is set, the row still shows that pin even if the
provider is gone or disabled, with an unavailable hint. Main prefers the pin
and logs a warning plus falls back to the Composer's current model if it cannot
be resolved: a stale pin is a preference that cannot be honoured, never a
failure that disables the action.

The reasoning row lists the levels the selected model actually supports, using
the same resolution the Composer applies to a turn: the model binding's
`thinkingLevels`, then the live catalog, then the provider default. A model
without reasoning therefore offers only `Off (no reasoning)` and disables the
row, rather than presenting a ladder it cannot run. With no model pinned the
request follows the conversation's model, whose ladder is not knowable here, so
every canonical level is offered.

The row defaults to `Off`, with no follow-the-session option: the enhancement
never inherits the conversation's effort, because a rewrite rarely benefits from
reasoning and reasoning is the slow path. Changing the model re-clamps the stored
level onto the new model's ladder, and the value written is the clamped one, so a
stored level is always one the model can run. Round-tripping the displayed value
through the same resolver keeps the row and the store in step.
