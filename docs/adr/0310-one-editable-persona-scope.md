# ADR 0310: One editable persona scope, the per-conversation prompt

- Status: Accepted
- Date: 2026-09-25
- Supersedes: ADR 0037, ADR 0044
- Amends: ADR 0121
- Related: [Agent runtime](../spec/03-runtime/02-agent-runtime.md) ·
  [Settings IA](../spec/04-ux/06-settings-ia.md) ·
  the former prompt-enhancement surface

## Context

The persona an agent turn received was assembled from layers that no single
surface owned:

- `~/.pi/agent/AGENTS.md` plus a per-directory project chain
  (`AGENTS.override.md`, `AGENTS.md`, `CLAUDE.md`, `.claude/CLAUDE.md`),
  resolved lazily per file tool (ADR 0037, ADR 0044);
- the pi-compatible `.pi/SYSTEM.md` / `APPEND_SYSTEM.md` pair, discovered from
  `<workspace>/.pi/` and `~/.pi/agent/` at launch;
- the system prompt of the "prompt enhancement" card, which in fact only
  configured the one-shot ✨ rewrite and never reached the agent's persona at
  all; and
- a user template for that same rewrite.

Four editable-looking entry points, three of them files, none of them able to
express the simplest intent: "this conversation, and only this one, answers
like X". A file could win the `replace` kind while losing the `append` kind, so
what the user saw in one place and what the model received in another could
diverge without any visible signal. Project rules were also injected on a lazy
per-path schedule, which meant the prompt that produced a given answer depended
on which files the agent had happened to touch.

A first pass reduced this to two editable scopes — the conversation's own
prompt and an app-wide prompt in Settings. In use the owner found even two
scopes more than the product needed: an app-wide prompt is an invisible
influence on every conversation the user never opened, and "why is this new
chat behaving oddly" again required looking somewhere other than the chat. The
requirement settled on one editable persona: the conversation you are in.

## Decision

1. The persona the model receives has exactly one editable scope: the
   conversation's own prompt (`sessions.system_prompt`, schema v20). Below it
   is the built-in product persona. There is no app-wide persona scope.
2. A blank or whitespace-only value means "no override", never "empty persona":
   the built-in persona answers. The value is trimmed before it reaches the
   prompt.
3. No persona is read from disk. The `.pi/SYSTEM.md` / `APPEND_SYSTEM.md`
   layer and the `AGENTS.md` regression chain are removed, together with the
   `project.instructions.resolve` preflight, the resolver registration on the
   sidecar wrapper, the instruction IPC channels, the `AgentInstructionFile`
   type, and the project-group instruction store.
4. The persona is edited where it applies: a conversation's prompt from the
   conversation topbar editor. Settings has no persona destination — the
   Prompts / 提示词 tab and its `globalSystemPrompt` field are removed, and the
   `globalSystemPrompt` setting is no longer accepted, stored, or synced.
5. The former prompt-enhancement card and one-shot rewrite path are removed.
   The editable persona is only the per-conversation system prompt; legacy
   settings are handled by migration compatibility code and are not exposed.
6. There is no config-sync `instructions` domain and no app-wide persona field
   to sync. A conversation's prompt is session state, not portable application
   configuration.

## Consequences

- What the user types in a conversation is the persona the model receives for
  that conversation; there is no file, and no app-wide setting, that can
  outrank it, silently blank it, or change a conversation the user never
  edited.
- The prompt is stable across a conversation: it no longer depends on which
  paths the agent touched earlier in the turn.
- Project context keeps only what is not a persona — project memory and, for a
  multi-root group, the additional-roots guide.
- Removing the instruction sync domain is a portable-format change: a bundle
  written by an older build carries `instructions` entities that this build
  does not select and will not apply. Project memory and projects continue to
  sync as before. Existing `AGENTS.md` files in repositories are untouched —
  they are simply no longer injected, and still readable by the agent as
  ordinary workspace files.
- Storage written for the removed scopes is not read. A project-group
  instruction record, the three enhancement template keys, and the app-wide
  `globalSystemPrompt` value in the app-settings blob are archived to
  `<data-dir>/removed-prompt-storage.json` and dropped during startup
  maintenance (`prune_removed_prompt_storage`). The archive is written first:
  if it cannot be written, the rows stay in place rather than vanish without a
  copy. Nothing a still-supported scope reads is touched.
- Native-pi sessions are unaffected; they keep the upstream loader's own
  resolution.

## Alternatives

### Keep the app-wide prompt as a second, lower-priority scope

Rejected by the owner after using it. An app-wide prompt changes conversations
the user never opened and reintroduces the "look elsewhere to explain this
chat" problem that motivated the whole change. One visible scope per
conversation is the whole model.

### Keep the file layer as a lowest-priority scope

Rejected. It preserves the failure this ADR removes: a persona the UI cannot
show is a persona the user cannot reason about, and the file still changes the
prompt for reasons invisible in the app.

### Keep the project instruction chain and add the conversation scope on top

Rejected. It grows the ambiguity rather than removing it, and the lazy
per-path injection makes an answer's prompt depend on tool history.

### Migrate the removed instruction files or global prompt into the conversation

Rejected. It would silently adopt text the user may never have intended as this
conversation's persona, from a file or a global setting that could hold
unrelated content.

## Amendment: the saved-prompt shelf is not a second scope

A reusable prompt shelf was added so a user can save the text they are editing
under a name and later apply a saved prompt to fill a conversation's editor
draft — in this conversation or a new one. It does not weaken decision 1:

- The shelf stores prompt *source text* only, in the existing key-value store
  (namespace `prompt_presets`, key `items`); it adds no table and no scope.
- Applying a saved prompt copies its text into one conversation's editor draft.
  Nothing is auto-applied to another conversation or to a new one, and saving a
  prompt writes no session row.
- The persona the model receives is still exactly one editable scope: the
  conversation's own `sessions.system_prompt`, and only once the user saves the
  editor. The shelf is a convenience library of text, not a persona layer below
  or above the conversation.

