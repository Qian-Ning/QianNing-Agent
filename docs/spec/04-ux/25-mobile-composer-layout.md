# Mobile Composer Layout

The shared renderer's phone composer uses `mobile-composer.css` as its single
layout owner, scoped to `:root[data-surface="mobile"]`. Desktop rules and voice
support remain unchanged. Mobile does not render voice controls even when the
stored voice setting is enabled.

For a configured reasoning-capable model the phone shows seven independent
controls: attachment, mode, permission, model, reasoning, context, and send/stop.
The model wrapper is the only flexible column. Reasoning is not merged into the
model selector. Six 28px targets and six 2px gaps consume 180px; the remaining
width belongs to the model name. Controls remain on one baseline at 320, 360,
390 and 400 CSS pixels. Send/stop has a centered 28 by 28 CSS-pixel box, not
the other controls' 28 by 34 box. Mobile mode uses the shared anchored menu;
desktop mode retains cycling. The menu reuses the desktop mode labels and icons.

The topbar retains new task, search and work-panel buttons. The fixed work-panel
button receives its own 52px reservation and cannot overlap search.

## Built-Surface Scenario

1. Build the shared renderer and phone bridge from the task worktree.
2. Run `apps/mobile/scripts/audit-shell.cjs` with the existing Electron binary,
   `ELECTRON_RUN_AS_NODE` unset, and `--disable-gpu` where needed.
3. Set `PI_MOBILE_AUDIT_PROFILE` to a scratch profile and
   `PI_MOBILE_AUDIT_ARTIFACTS` to a scratch screenshot directory.
4. Seed a configured provider, token usage and `voice.enabled=true`. Never use
   real credentials or send prompts to a paid endpoint.
5. At each supported width assert exactly seven controls, no voice, pairwise
   non-overlap, one baseline, no horizontal overflow, and model width >=70px.
6. Include the fixed work-panel toggle in topbar geometry checks. Assert equal
   target heights, aligned centers and the last target at the page edge.
7. Open the seeded existing conversation, including its extra prompt topbar
   control. Open mode, permission, model, reasoning and context menus. Select
   mode, permission and reasoning, assert bridge readback, then reload and reopen.
   Require all five stored selector fields to survive, including provider/model.
8. Capture shown windows and inspect the narrow and regular phone screenshots.

The source-contract regression gate is
`apps/desktop/test/mobile-composer-layout.test.mjs`.

## Configuration and Offline Startup

The bridge and local runtime share a typed session-config reader. Create,
configure, get and list expose the persisted configuration. Partial updates
merge; invalid enum updates fail without overwriting the previous record.
Corrupt persisted enum fields fall back safely. A fresh bridge over the same
store must return the same mode, provider, model, reasoning and permission.

Each runtime turn reads the stored model/provider and reasoning choice. `omit`
and `off` omit explicit provider reasoning. Session permissions override the
global default unless set to `inherit`; grants are isolated per session. Plan
mode denies phone write/network tools. Goal mode uses automatic permission and
goal instructions, not the desktop's planning pipeline or background execution.

Startup model-cache reads must not fetch a provider. The built-surface audit
tracks and blocks non-harness network requests and requires zero attempts.
Explicit model refresh remains remote. Its local timing includes harness waits
and is not a device startup benchmark.
