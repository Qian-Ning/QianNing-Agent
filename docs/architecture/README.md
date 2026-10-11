# Architecture budgets

The scripts/check-architecture.mjs checker reports the source-file count, total
physical line count, largest source files, and the >500, >1000, and >2000 LOC
threshold counts for tracked source under apps/, packages/, crates/, and
scripts/. Generated output, dependency trees, and build directories are
excluded.

The checker enforces these limits:

- apps/desktop/electron/main/index.ts is at most 1500 LOC.
- apps/desktop/src/stores/app-store.ts is at most 1000 LOC.
- A newly added ordinary TypeScript or TSX source file is at most 800 LOC,
  unless it has a reasoned entry under typescript in allowlist.json.
- Every Rust source file above 1000 LOC has a reasoned entry under rust in
  allowlist.json.

The Rust entries currently document legacy modules that were outside the
follow-up split scope. New Rust domain files are expected to remain below the
limit. An allowlist entry records an explicit debt boundary; it does not raise
the general limit for future files.

## Debt ceilings

An allowlist entry is a bounded exemption, not a permanent one. Each entry
records the size it was exempted at:

```json
{
  "crates/host-core/src/rpc/mod.rs": {
    "reason": "Legacy RPC dispatch module; its extraction is outside this refactor scope.",
    "max": 9260
  }
}
```

`max` is the permitted ceiling in physical lines. The checker fails when an
exempted file grows past its recorded ceiling, and when an entry has a reason
but no `max`. Raising a ceiling is allowed, but it is a deliberate, reviewable
edit in the same change that needs the room — that is what keeps the exemption
visible instead of letting the debt grow silently.

## Facade ceilings

AGENTS.md section 7 names the facade modules that must stay thin over their
domain implementations (ADR 0235). `main/index.ts` and `app-store.ts` carry
standing limits; the remaining facades are recorded in the checker with their
measured size. A facade that grows fails the check: move the logic to the
domain module that owns it rather than widening the facade.
