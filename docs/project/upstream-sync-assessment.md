# Upstream sync assessment

QianNing Agent is a distribution of [PI-Desktop](https://github.com/vastsa/PI-Desktop).
This page records how far the two trees have drifted, which parts of this tree
are the distribution's own layer, and what that costs.

## Why this cannot be a merge

The two histories share no ancestor: this repository's history was rewritten
when the distribution was cut, so `git merge-base` finds nothing and a
commit-range diff is unavailable. Sync state therefore has to be measured by
comparing trees, and version numbers cannot be used for it at all — the two
release lines are independent, and this tree's numbers run *ahead* of upstream's
while its code runs behind.

```text
apps/desktop/package.json   this tree: 0.20.0        upstream: 0.18.0-beta.7
upstream/main at review     043c71548 (2026-10-13)   feat(settings): present remote host forms in dialogs
upstream newest tag         v0.18.0-beta.7 (2026-10-13)
```

The base this tree was cut from is the upstream release whose tree it has most
in common with:

| Upstream reference | Date | Shared paths | Byte-identical | Differing |
| --- | --- | --- | --- | --- |
| `v0.16.0` | 2026-10-02 | 2,320 | **1,311** | 1,009 |
| `v0.17.0` | 2026-10-07 | 2,332 | 1,163 | 1,169 |
| `v0.18.0` | 2026-10-10 | 2,324 | 1,099 | 1,225 |
| `main` | 2026-10-13 | 2,324 | 1,020 | 1,304 |

Identical-file count peaks at `v0.16.0` and falls on both sides of it, so that
release is the base. Upstream has since moved 702 commits (239 `fix`, 45 `feat`,
8 `perf`) and two releases.

## Who changed what

Measured against that base, every path belongs to exactly one owner:

| Attribution | Paths | Meaning |
| --- | --- | --- |
| `same` | 1,031 | Unchanged on both sides |
| `theirs-new` | 1,048 | Upstream files this tree does not have |
| `ours-new` | 267 | This tree's own files |
| `ours-only-changed` | 557 | Shared files only this tree changed |
| `both-changed` | 449 | Both sides changed — the replay conflict zone |
| `theirs-only` | 292 | Upstream work in files this tree never touched |
| `both-added` | 6 | Added on both sides |

The distribution's own layer is `ours-new` + `ours-only-changed` +
`both-changed` = **1,273 paths**. Its composition:

| Kind | Count |
| --- | --- |
| Explained by the brand rules alone | 186 |
| Code | 748 |
| Documentation | 381 |
| Assets | 128 |
| Other | 16 |

## Brand layer verification

`scripts/upstream-sync-audit.mjs --verify` applies the brand rule set to the
upstream side of every shared file and reports what it explains:

| Result | Files |
| --- | --- |
| Identity rules reproduce this tree byte for byte | 178 |
| Identical once version strings are normalized | 12 |
| Binary | 88 |
| Not explained by the rules | 1,026 |
| Shared paths whose content differs (total) | 1,304 |

The rule set is not a blind string replacement. The npm scope `@pi-desktop/`,
the IPC channel prefix `pi-desktop/`, and the `PI_DESKTOP_` environment
variable prefix are compatibility contracts and must survive branding; the
script refuses to emit a file that loses one. The data directory `.pi-desktop`
is the one form that does change, which is why the guard matches the channel
prefix as a token rather than as a substring.

## What this costs

Only 5 upstream commits in the last eight days touched files the rules explain
completely, and all five are documentation or test adjustments. Everything else
lands in `both-changed` territory. A full upstream import is therefore a
re-implementation, not a merge.

The staged path this assessment supports:

1. **Rule the brand layer.** Keep the identity substitutions in
   `scripts/upstream-sync-audit.mjs` and verify them with `--verify`, so the
   branding of a new upstream file is mechanical instead of hand-edited.
2. **Import the cheap set first.** The 292 `theirs-only` paths are upstream work
   in files this tree has never modified, so they are the lowest-conflict
   candidates for a targeted import.
3. **Replay the own layer last.** The 1,273 paths above — 449 of them in the
   conflict zone — are the real cost of re-basing onto a current upstream
   release, and they only become tractable once steps 1 and 2 have removed the
   mechanical work.

## Reproducing these numbers

The upstream remote must be fetched first
(`git fetch upstream --tags`, see `CONTRIBUTING.md`).

```bash
node scripts/upstream-sync-audit.mjs --verify upstream/main
node scripts/upstream-sync-audit.mjs --inventory up-v0.16.0 --out /tmp/upstream-lists
node scripts/upstream-sync-audit.mjs --apply < upstream-file.ts > branded-file.ts
```

The `--inventory` run is the source of the attribution table; the third command
is the replay primitive a targeted import uses.
