# ADR 0331: First-turn skill preload, local load counts, and a generation group gate

- Status: Accepted
- Date: 2026-10-26
- Related: `packages/agent-runtime/src/skill-relevance.ts`;
  `packages/agent-runtime/src/runtime.ts`;
  `apps/desktop/electron/main/skill-preload.ts`;
  `apps/desktop/electron/main/skill-usage.ts`;
  [ADR 0330](0330-skill-catalog-groups.md);
  [skill authoring](../spec/07-plugins/17-skill-authoring.md)

## Context

ADR 0330 grouped the catalog and capped descriptions, which lowered the cost of
advertising eighty-odd documents. It left two questions open.

The first is selection. A model sees a flat list of `id — name — description`
lines and must decide, from that alone, whether any of them applies. Several
real prompts match a document clearly enough for a deterministic lexical test —
release work, audio inspection, migration safety — yet the model may simply answer
without ever calling `Skill`. The catalog is an advertisement, and an
advertisement the reader ignores is worth nothing.

The second is evidence. Nobody knows which documents are actually loaded. Every
pruning decision therefore rests on reading eighty-three files and guessing. A
description edit is a behavior change that nobody can measure afterwards.

## Decision

Three changes, each independently reversible.

**Preload at most one body, for the first prompt only.** The host scores the first
user message against the advertised catalog with an inverse-document-frequency
matcher (`skill-relevance.ts`): content words of the message against id slug,
name, and description of each skill. A skill is chosen only when its score clears
`SKILL_PRELOAD_MIN_SCORE` and the runner-up stays below
`SKILL_PRELOAD_MARGIN` of the leader. The body arrives as the `skill-preload`
system section, so transcript rebuilding keeps it and it can be revoked like any
other section. The runtime accepts the offer only when the session has no turn
history; a match computed from one sentence is not evidence about a conversation
that already happened. Bodies above `SKILL_PRELOAD_MAX_BODY_CHARS` stay behind the
`Skill` tool.

**Count loads locally.** Each successful `Skill` load of a bundled document
increments `<data dir>/skill-usage.json` — loads and last-load timestamp per id.
Writes are debounced and atomic; a corrupt or unwritable file resets to zero and
never fails a turn. `pnpm skills:usage` prints the ranking. No network call, no
identifier beyond the skill id.

**Gate groups, not just entries.** `BUILTIN_SKILL_GROUP_GATES` drops a whole group
whose members all depend on one unavailable capability. `Generation` disappears
when neither image nor video generation is configured; entry-level gating still
runs underneath, so one unconfigured member never takes its group down.

## Consequences

- A clear first prompt now arrives with its document already in context, without
  a round trip and without depending on the model's judgment about the catalog.
- Ambiguous prompts preload nothing. The matcher is deliberately conservative; a
  wrong body costs context and attention, so silence is the default.
- Preload interacts with `Skill` loading: a model that then calls `Skill` for the
  same id receives the body twice. The `Skill` tool remains unchanged, and the
  duplicate is cheap compared with the cost of a missed document.
- The usage file is per-user evidence, not a shared metric. It dies with the data
  directory and is not exported anywhere.
- The three thresholds are calibrated against the shipped catalog and are
  expected to move as descriptions and bodies change. The counts are what makes
  that calibration reviewable instead of speculative.

## Alternatives considered

- **Embedding-based retrieval.** Better recall on paraphrased requests, but it
  adds a model dependency, a cold-start cost, and non-determinism in a path that
  must be reproducible offline. Rejected for now; the lexical matcher can be
  replaced behind the same interface.
- **Preload on every turn.** Context grows without bound and the model
  re-receives instructions it already has. Rejected.
- **Let the model choose from a shortlist instead of loading a body.** The
  shortlist still costs a round trip and the model can still ignore it.
- **Word-count-based trimming of the remaining catalog.** Measured, not
  estimated: the counts come first, pruning follows.
