# Mobile layout standard

The phone build is the desktop's design language at a smaller width — not a
second design. These are the numbers and the checks that keep it that way. They
are enforced by `scripts/layout-audit.mjs`, not by review.

## Where the values come from

| Fact | Authority |
| --- | --- |
| colours, skin palettes | `packages/shared/src/skins.ts` (read by both apps) |
| radii, type ramp, focus ring | `apps/desktop/src/styles/tokens.css` (mirrored in `src/scales.css`, compared by `mobile-token-guard.test.ts`) |
| spacing, hit targets, screen rules | this document |

`src/styles.css` may only use `var(--ds-*)`, `var(--radius-*)`, `var(--text-*)`.
A raw hex value or a hand-picked font size fails the token guard.

## Spacing

One scale: **4 / 8 / 12 / 16 / 24**. Screen padding is 14–16, card padding
12–14, gaps inside a group 8–12, between groups 16–24. Anything else is a
mistake, not a decision.

## Type

Body 15 (`--text-base`), secondary 13 (`--text-sm`), metadata never below 12
(`--text-2xs`). Text scales with `--font-scale` (1 / 1.06 / 1.12 today; the audit
also runs 1.3 to prove the layout survives a system-wide enlargement).

## Touch

Every interactive element is at least **44×44 CSS px**, including icon-only
buttons. A row is at least 44 tall. Nothing important sits under
`env(safe-area-inset-bottom)`.

## Composition

- One primary action per screen or sheet; secondary actions are quiet, and
  destructive ones live in their own group below.
- Lists are one line per row: title left, metadata right, fixed chevron slot.
  A long value truncates; it never widens the page.
- A screen is organised by task (model / appearance / connection), never by
  control type.
- Empty, busy and error states are part of the layout, not an afterthought:
  each gets a line of its own and never a blank canvas.

## Verification matrix

`node scripts/layout-audit.mjs` renders the shipped bundle at

```
widths:   320 / 360 / 392 / 430
font:     1.0 / 1.3
screens:  connect → sessions → chat → drawer → settings (root, general, model,
          appearance, connection, remote, usage, about)
```

and fails when, on any combination:

1. the document scrolls horizontally (`scrollWidth > clientWidth + 1`);
2. an element inside a screen overflows its parent horizontally without an
   ellipsis or wrap;
3. an interactive element is smaller than 40×40 (44 is the target; 40 is the
   failure line so a one-pixel rounding difference does not fail the build);
4. a screen renders nothing (`innerText` shorter than 10 characters) — the
   blank-screen failure mode, caught in CI instead of on a phone.

Screenshots land in `$TMPDIR/mobile-layout-audit/` for eyeballing; the numbers
are what gate the change.
