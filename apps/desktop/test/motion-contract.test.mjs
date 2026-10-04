/**
 * Motion contract (design-system §8, D649).
 *
 * The guard in scripts/check-motion.mjs is the mechanical sweep; these tests
 * pin the user-visible outcomes it exists to protect, so a regression names
 * itself instead of pointing at a line in a script.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { buildContext, checkDirectory, checkSource, STYLES_DIR } from "../../../scripts/check-motion.mjs";

const styles = (name) => readFileSync(join(STYLES_DIR, name), "utf8");

test("the motion guard is clean over the shipped stylesheets", () => {
  const violations = checkDirectory();
  assert.deepEqual(
    violations.map((v) => `${v.file}:${v.line} ${v.message}`),
    [],
  );
});

test("reduced motion has a global net at the tail, not only per-component blocks", () => {
  const base = styles("responsive.css");
  const block = base.match(
    /@media \(prefers-reduced-motion: reduce\) \{\s*\*,\s*\*::before,\s*\*::after \{[^}]*\}/s,
  )?.[0];
  assert.ok(block, "responsive.css must carry the design-system §8.5 global net");
  assert.match(block, /animation-duration: 0\.01ms !important;/);
  assert.match(block, /transition-duration: 0\.01ms !important;/);
  // Near-zero, never `none`: exit unmounts listen for `animationend`.
  assert.doesNotMatch(block, /animation: none/);
});

/**
 * A loop that keeps running under `prefers-reduced-motion` is the failure this
 * whole change started from: `animation-duration: 0.01ms` on an `infinite`
 * animation still repaints every frame, so the loop has to be switched off.
 */
const LOOPS = [
  ["pet.css", ".pet-glow.on"],
  ["voice.css", ".voice-recording-dot"],
  ["voice.css", ".voice-spinner"],
  ["overlays.css", ".backend-banner.warn .backend-dot"],
  ["providers.css", ".provider-model-spinner"],
  ["settings.css", ".settings-toggle.is-busy .settings-toggle-thumb"],
];

for (const [file, selector] of LOOPS) {
  test(`${selector} is switched off under reduced motion`, () => {
    const source = styles(file);
    const blocks = source.match(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}/g) ?? [];
    const guarded = blocks.some((block) => block.includes(selector) && /animation:\s*none/.test(block));
    assert.ok(guarded, `${file} must switch ${selector} off under reduced motion`);
  });
}

test("every press rule names a control whose base rule transitions transform", () => {
  const pressRules = [];
  for (const [file, source] of [["ui-kit.css", styles("ui-kit.css")]]) {
    for (const hit of source.matchAll(/^([^\n{}][^{}]*:active:not\(:disabled\)[^{}]*)\{/gm)) {
      pressRules.push({ file, selector: hit[1].trim() });
    }
  }
  // The shared button primitive keeps its pressed scale and its transform
  // transition in one place — press and release must never snap.
  const button = styles("ui-kit.css").match(/\n\.btn \{[^}]*\}/)?.[0] ?? "";
  assert.match(button, /transform var\(--motion-duration-fast\) var\(--motion-ease-out\)/);
  assert.match(styles("ui-kit.css"), /\.btn:active:not\(:disabled\) \{\s*transform: scale\(0\.98\);/);
  assert.ok(pressRules.length >= 1);
});

test("each press block states its scale once, for every selector at once", () => {
  const files = ["chrome.css", "composer.css", "messages.css", "providers.css", "settings.css"];
  for (const file of files) {
    const source = styles(file);
    const header = source.indexOf("Pressed feedback (design-system §8.7)");
    assert.ok(header > 0, `${file} must carry a press block`);
    const block = source.slice(source.indexOf("\n */\n", header), source.indexOf("\n}\n", header));
    const scales = block.match(/transform: scale\(0\.97\);/g) ?? [];
    assert.equal(scales.length, 1, `${file} must state its pressed scale exactly once`);
    // One rule, many selectors — not one rule per control.
    assert.ok(block.split(",").length >= 1);
    assert.match(block, /:active:not\(:disabled\)/);
  }
});

/**
 * A guard that sits before the loop it switches off loses the tie on source
 * order, which is how a "fixed" infinite animation keeps repainting. Pinning
 * the rule itself keeps that regression from looking like a fix.
 */
test("a loop guard that precedes its declaration is reported", () => {
  const guardAfter = `.spinner { animation: spin 1s linear infinite; }
@media (prefers-reduced-motion: reduce) {
  .spinner { animation: none; }
}`;
  const guardBefore = `@media (prefers-reduced-motion: reduce) {
  .spinner { animation: none; }
}
.spinner { animation: spin 1s linear infinite; }`;
  const run = (text) => {
    const sources = [["probe.css", text]];
    const context = buildContext(sources);
    context.order = new Map([["probe.css", 0]]);
    return checkSource(text, "probe.css", context);
  };
  assert.equal(run(guardAfter).length, 0, "a guard after the declaration wins");
  const late = run(guardBefore);
  assert.equal(late.length, 1, "a guard before the declaration must be reported");
  assert.match(late[0].message, /no later `animation: none`/);
});

/**
 * A touch tap latches `:hover` until the next tap, so a reveal that hides
 * behind hover becomes permanent on a phone. Rules that pair `:hover` with a
 * keyboard state in one list stay whole on purpose — gating them would drop
 * the focus state on touch — so they are asserted to stay paired here instead.
 */
test("pointer-only reveals are gated and keyboard pairings stay paired", () => {
  const gated = styles("chrome.css").match(
    /@media \(hover: hover\) and \(pointer: fine\) \{[\s\S]*?\n\}/,
  )?.[0];
  assert.ok(gated, "chrome.css must gate its hover reveals on a real pointer");
  assert.match(gated, /\.conversation-topbar \.ct-icon-btn:hover:not\(:disabled\)/);

  const paired = styles("sidebar-threads.css") + styles("sessions.css");
  assert.match(
    paired + styles("messages.css") + styles("chat-links.css"),
    /:hover[^{},\n]*,[\s\S]*?:focus-visible/,
    "hover + focus-visible pairings must remain in one rule",
  );
});

/**
 * The first-run checklist is the one surface D652 allows a celebration on —
 * each step completes at most once per machine, so the motion stays rare by
 * construction. Its shapes are pinned here so the guard's silence is not
 * mistaken for correctness: the tick has to settle into place rather than
 * bounce, and the finished card has to leave rather than vanish.
 */
test("the first-run checklist settles its tick and leaves its card", () => {
  const source = styles("chat-shell.css");
  const frames = (name) =>
    source.match(new RegExp("@keyframes " + name + " \\{([\\s\\S]*?)\\n\\}"))?.[1] ?? "";

  for (const name of [
    "onboarding-check-in",
    "onboarding-tick-in",
    "onboarding-ring-out",
    "onboarding-checklist-out",
  ]) {
    assert.ok(frames(name), "chat-shell.css must define @keyframes " + name);
  }

  // §8.6: ease-out to 1 and never past it — a settling tick, not a bounce.
  assert.match(frames("onboarding-check-in"), /scale\(0\.62\)/);
  for (const name of ["onboarding-check-in", "onboarding-tick-in"]) {
    const scales = [...frames(name).matchAll(/scale\(([\d.]+)\)/g)].map((hit) => Number(hit[1]));
    assert.ok(scales.length > 0, name + " must scale");
    assert.ok(
      scales.every((value) => value <= 1),
      name + " must not overshoot 1 (§8.6)",
    );
  }

  // The ring is drawn by the element that is already there: invisible at rest,
  // so it never reads as a second border.
  assert.match(source, /\.onboarding-check::after \{[^}]*opacity: 0/);
  // Durations come from the §8.1 tokens; the ring's one-off 520ms is allowed.
  assert.match(
    source,
    /\.onboarding-check\.is-celebrating \{[\s\S]*?animation: onboarding-check-in var\(--motion-duration-normal\) var\(--motion-ease-out\) both/,
  );
  // The exit runs `ease-in` on purpose: leaving accelerates away.
  assert.match(
    source,
    /\.home-onboarding-checklist\.is-leaving \{[\s\S]*?animation: onboarding-checklist-out var\(--motion-duration-normal\) var\(--motion-ease-in\) both/,
  );
  assert.match(frames("onboarding-checklist-out"), /opacity: 0/);
  assert.match(frames("onboarding-checklist-out"), /translateY\(-5px\)/);
});
