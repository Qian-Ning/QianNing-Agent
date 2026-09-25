# ADR 0307: Two persona scopes instead of a file-based instruction chain

- Status: Accepted
- Date: 2026-09-25
- Supersedes: ADR 0037, ADR 0044
- Amends: ADR 0121
- Related: [Agent runtime](../spec/03-runtime/02-agent-runtime.md) ·
  [Settings IA](../spec/04-ux/06-settings-ia.md) ·
  [Prompt enhancement](../spec/04-ux/12-prompt-enhancement.md)

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

## Decision

1. The persona the model receives has exactly two editable scopes, most
   specific first: the conversation's own prompt (`sessions.system_prompt`,
   schema v20) and the app-wide prompt (`settings.globalSystemPrompt`). Below
   both is the built-in product persona.
2. A blank or whitespace-only value at either scope means "no override", never
   "empty persona": the next scope down answers. Both values are trimmed before
   they reach the prompt.
3. No persona is read from disk. The `.pi/SYSTEM.md` / `APPEND_SYSTEM.md`
   layer and the `AGENTS.md` regression chain are removed, together with the
   `project.instructions.resolve` preflight, the resolver registration on the
   sidecar wrapper, the instruction IPC channels, the `AgentInstructionFile`
   type, and the project-group instruction store.
4. The setting is edited where it applies: the app-wide prompt on
   Settings ▸ Prompts (`instructions` tab id retained as persisted routing
   state), and a conversation's prompt from the conversation topbar editor.
5. The prompt-enhancement card keeps only its model and reasoning rows. Its
   rewrite system prompt and user template become product constants in
   `packages/shared/src/prompt-enhancement.ts`; host-core no longer accepts or
   stores `promptEnhancementCustomTemplate`,
   `promptEnhancementUserTemplate`, or `promptEnhancementSystemPrompt`.
6. The config-sync `instructions` domain is removed. The app-wide persona
   travels inside the application-preferences domain like any other setting, so
   it needs no project mapping and cannot be written outside the approved
   selection.

## Consequences

- What the user types in the app is the persona the model receives; there is no
  file that can outrank or silently blank it.
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
- A project-group instruction record written by an older build is no longer
  read. It is left in the key-value store rather than migrated: the data has no
  destination in the new model, and deleting a user's text to tidy a namespace
  is worse than leaving an unreachable row.
- Native-pi sessions are unaffected; they keep the upstream loader's own
  resolution.

## Alternatives

### Keep the file layer as a third, lowest-priority scope

Rejected. It preserves the failure this ADR removes: a persona the UI cannot
show is a persona the user cannot reason about, and the file still changes the
prompt for reasons invisible in the app.

### Keep the project instruction chain and add the two new scopes on top

Rejected. It grows the ambiguity rather than removing it, and the lazy
per-path injection makes an answer's prompt depend on tool history.

### Migrate the removed instruction files into the app-wide prompt

Rejected. It would silently adopt text the user may never have intended as a
persona, from a file that could hold unrelated repository rules.
