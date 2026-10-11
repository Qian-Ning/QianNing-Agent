# ADR 0324: Bound the Architecture Budget Exemptions

- Status: Accepted
- Date: 2026-10-11
- Deciders: QianNing Agent maintainers

## Context

ADR 0235 introduced the source-size budgets enforced by
`scripts/check-architecture.mjs` and an allowlist of entries that record a
reason for an oversized file (`docs/architecture/allowlist.json`). That
decision made debt explicit, but left two gaps.

First, an exemption was open-ended. An entry recorded why a file is large; it
recorded nothing about how large the file may become. `crates/host-core/src/
rpc/mod.rs` was exempted at roughly 9,260 lines, and the checker would have
accepted any future size, because the general limit is not re-applied to an
exempted file. A reason without a ceiling documents debt once and then lets it
grow silently.

Second, the facade paths AGENTS.md section 7 names were only partly enforced.
`apps/desktop/electron/main/index.ts` and `apps/desktop/src/stores/app-store.ts`
carry standing limits, but the remaining facades — `Composer.tsx`,
`ChatTranscript.tsx`, and the host-core `plugins`, `db`, `providers`, `plans`
module roots — had no ceiling at all. ADR 0235 requires those modules to remain
thin facades over their domain implementations; nothing stopped one from
becoming a second implementation.

## Decision

1. Every entry in `docs/architecture/allowlist.json` records a `max` field: the
   permitted ceiling in physical lines, set to the file's measured size when the
   exemption is recorded. The legacy string form stays readable for
   compatibility, but an entry without `max` now fails the check.
2. `scripts/check-architecture.mjs` fails when an exempted file grows past its
   recorded ceiling. The failure names the file, its size, and its ceiling.
3. The remaining AGENTS.md section 7 facades are recorded in the checker with
   their measured ceilings and are checked the same way; a facade that grows
   fails the check.
4. Raising a ceiling is permitted, but only as a deliberate edit in the same
   change that needs the room. The diff is the review: an exemption cannot grow
   without a human writing the new number.

## Consequences

- An exemption is now a bounded debt boundary rather than a permanent permit.
- Refactor progress is visible: a file that shrinks stays under its ceiling, and
  the ceiling can be lowered in the same change.
- A change that legitimately needs more room carries one extra, explicit line of
  review rather than passing silently.
- The checker's report lists the facade ceilings and the count of recorded debt
  ceilings, so the state of the ratchet is readable from CI output.

## Alternatives considered

- **Re-apply the general limit to exempted files.** Rejected: the exempted files
  are already far above it, so this would fail immediately and force either a
  blanket re-exemption or an unrelated refactor.
- **Record a percentage headroom instead of a line ceiling.** Rejected: a
  percentage of 9,260 lines permits hundreds of new lines, which is the silent
  growth this ADR exists to stop.
- **Drop the exemptions and split every file now.** Rejected: ADR 0235 already
  recorded why each extraction is its own change with its own risk; this ADR
  bounds the debt without pretending the extractions are free.
