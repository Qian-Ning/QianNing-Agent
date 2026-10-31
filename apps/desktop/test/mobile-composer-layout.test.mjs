import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const mobile = await read("../src/styles/mobile-composer.css");
const responsive = await read("../src/styles/responsive.css");
const modelConfig = await read("../src/styles/model-config.css");
const picker = await read("../src/features/chat/composer/ComposerModelPicker.tsx");
const audit = await read("../../mobile/scripts/audit-shell.cjs");

test("phone composer has one layout owner with independent model and reasoning slots", () => {
  assert.match(picker, /composer-model-thinking composer-model-anchor/);
  assert.match(picker, /composer-model-thinking composer-reasoning-anchor/);
  assert.doesNotMatch(picker, /composer-model-level-inline/);
  assert.doesNotMatch(responsive, /:has\(\.composer-reasoning-chip\)/);
  assert.doesNotMatch(responsive, /\.composer-toolbar\s*\{/);
  // The model name takes the leftover width, so every pair of controls keeps
  // the same gap: an elastic name ate the slack and left one wide gap in the
  // middle of the row.
  assert.match(mobile, /\.composer-model-anchor\s*\{[\s\S]*?flex: 1 1 auto/);
  assert.match(mobile, /min-width: 70px/);
  // One fixed gap and no free space between the controls.
  assert.match(mobile, /justify-content: flex-start/);
  assert.match(mobile, /gap: 6px/);
  assert.doesNotMatch(mobile, /margin-left: auto/);
  for (const marker of ["model-text-center", "model-reasoning-gap", "composer-edge-inset", "glyph-ink"]) assert.ok(audit.includes(marker), marker);
  assert.match(mobile, /\.composer-reasoning-anchor/);
  for (const selector of ["composer-plus", "composer-mode-chip", "composer-permission", "composer-model-anchor", "composer-reasoning-anchor", "context-inspector", "send-btn"]) {
    assert.ok(mobile.includes(selector), selector);
  }
});

test("the phone model-service sheet shows both model panes inside the viewport", () => {
  // A phone sheet is a full-height screen: the credential band stays on top and
  // the two model panes share what is left, so "模型设置" is never below the
  // fold with no way to reach it.
  assert.match(responsive, /:root\[data-surface="mobile"\] \.provider-setup-dialog[\s\S]*?height: 100dvh/);
  assert.match(responsive, /:root\[data-surface="mobile"\] \.provider-setup-body[\s\S]*?overflow-y: auto/);
  // Each list gets a real share of the sheet instead of a collapsed two-row box.
  assert.match(responsive, /:root\[data-surface="mobile"\] \.provider-models-list[\s\S]*?min-height: 34vh/);
  // The narrow-window desktop rule must not cap the phone sheet's height.
  assert.match(modelConfig, /:root\[data-surface="mobile"\] \.provider-setup-dialog[\s\S]*?height: 100dvh/);
});

test("built phone audit counts all seven controls and includes fixed chrome", () => {
  assert.match(audit, /controls.length !== 7/);
  assert.match(audit, /\.ct-actions > \*, \.app-work-panel-toggle/);
  assert.match(audit, /voice: \{ enabled: true \}/);
  assert.match(audit, /control-overlap/);
  assert.match(audit, /model-unreadable/);
  assert.match(audit, /show: true/);
  assert.doesNotMatch(audit, /filter\(\(element\) => !element.classList.contains\("context-inspector-trigger"\)\)/);
});
