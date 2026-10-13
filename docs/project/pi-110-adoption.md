# Pi 1.1.0 adoption

## Scope

The three direct Pi dependencies of Agent Runtime, and the pi-ai dependency of
Electron Main, are pinned exactly to `1.1.0`. The three repository patches are
the upstream set rebased onto the published 1.1.0 packages, and the lockfile
records their patch hashes.

| Workspace entry | Direct dependencies |
| --- | --- |
| `packages/agent-runtime` | `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent` |
| `apps/desktop` | `@earendil-works/pi-ai` |

Two behaviours follow from the upgrade:

- Every token-budget conversion uses pi-ai's text estimate through
  `ESTIMATED_TEXT_CHARS_PER_TOKEN` (3.5 characters per token), replacing the
  local four-characters-per-token heuristic in compaction sizing, summary-input
  truncation, delegate context budgets and checkpoint truncation.
- A completed response takes its duration from pi-ai's monotonic
  `AssistantMessage.durationMs`. Stopped or older streams without a final
  message keep the sidecar stopwatch, and interrupted streams keep the existing
  fallback.

Both feed the existing `responseDurationMs` transcript field, so no IPC or
storage schema changes are needed.

The satellite release group is pinned whole in `pnpm-workspace.yaml`. The
`^1.1.0` ranges declared by pi-coding-agent otherwise resolve
`@earendil-works/pi-codemode@1.2.0`, whose declarations renamed
`MCP_TYPESCRIPT_PREAMBLE` and `mcpStructuredContentSchema` — two symbols
pi-coding-agent 1.1.0 imports, so the extension bundler fails. Upstream is
protected by a frozen lockfile; this tree regenerates it, so the versions are
pinned explicitly.

## Patch identity

| Package | Patch SHA-256 |
| --- | --- |
| `@earendil-works/pi-agent-core@1.1.0` | `a2c96619d0f9a1d643a6c6a555ba6a7fb533147336c181f7d3b7f847be33a6eb` |
| `@earendil-works/pi-ai@1.1.0` | `2aa7a30fca930a08ebdff65f82d2fc47aeb1cd941d34aae2e50e13b309ef2705` |
| `@earendil-works/pi-coding-agent@1.1.0` | `a2878f6aa1d66afa239d6be4252403a73df48b702b3e582aaae04bd90bf3d354` |

The pi-ai patch is one published revision newer than the 1.1.0 adoption commit:
upstream's `351d242e8` ("send pi User-Agent on Anthropic token requests") adds
the header to the authorization-code and refresh requests. Electron's
`net.fetch` otherwise sends Chromium's browser User-Agent, which the token
endpoint answers with a permanent 429. The rebased patch alone lacks that fix,
so this tree takes the later revision and records it here.

`check:pi-dependencies` and `check:pi-patches` verify exact direct pins,
installed package instances, patch mappings and lockfile identities, and the
patched source and declaration contracts.

## Fresh-release policy

The Pi 1.1.0 release group may fall inside the configured supply-chain age
window, so `pnpm-workspace.yaml` carries exact-version `minimumReleaseAgeExclude`
entries for the eight published release-group packages. The dependency check
rejects missing, additional, wildcard, or non-1.1.0 entries. Remove them once
the release group clears the window, and regenerate the lockfile; do not widen
them.

## Validation

- Task candidate base: `origin/main` at the branch point.
- `pnpm build:js` clean (0 TypeScript errors); `pnpm --filter
  @pi-desktop/desktop typecheck`, `pnpm lint`, `node
  scripts/check-architecture.mjs`, `pnpm check:agent-policy` and
  `pnpm check:pr-base` all clean.
- `pnpm check:pi-dependencies` and `pnpm check:pi-patches` pass against the
  installed 1.1.0 packages.
- `pnpm --filter @pi-desktop/agent-runtime test` passes (73 files, 1,086 tests),
  including the response-duration coverage ported with the upgrade. Under this
  machine's parallel full-suite load, timing-sensitive cases
  (`streaming-benchmark`, `subagent-fallback`, `subagent`) exceed their
  wall-clock ceilings — a different subset trips per run and each file passes on
  its own, so module-load contention is the cause. CI is the arbiter.
- `node --test scripts/*.test.mjs` passed (17 tests).
- PR integration candidate validation runs in CI.

## Rollback

Roll back the dependency manifests, lockfile, release-age entries, satellite
pins, patch files and version references together. Do not roll an individual
patched Pi package back while the others stay at 1.1.0.
