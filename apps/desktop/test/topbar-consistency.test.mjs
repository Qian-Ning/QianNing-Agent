import assert from "node:assert/strict";
import test from "node:test";
import { loadStyles } from "./helpers/styles.mjs";

const stylesSource = await loadStyles();

function styleBlock(selector) {
  return stylesSource.match(new RegExp(`(?:^|\\n)${selector} \\{[^}]*\\}`))?.[0] ?? "";
}

test("shell titlebar surfaces share the toolbar metric and borderless surface", () => {
  for (const selector of [
    "\\.main-titlebar",
    "\\.conversation-topbar",
    "\\.settings-titlebar",
  ]) {
    const block = styleBlock(selector);
    assert.match(block, /height:\s*var\(--ds-toolbar-height\);/);
    assert.match(block, /background:\s*var\(--ds-bg-primary\);/);
    assert.match(block, /border-bottom:\s*0;/);
  }
});

test("window chrome reserves a compact control capsule inside the titlebar", () => {
  const controls = styleBlock("\\.window-controls");
  assert.match(controls, /top:\s*7px;/);
  assert.match(controls, /right:\s*4px;/);
  assert.match(controls, /height:\s*32px;/);
  assert.match(controls, /width:\s*112px;/);
  assert.match(stylesSource, /--ds-window-controls-width:\s*120px;/);
  assert.match(stylesSource, /--ds-toolbar-height:\s*46px;/);
});

test("window controls match the adjacent topbar action capsule", () => {
  const controls = styleBlock("\\.window-controls");
  assert.doesNotMatch(controls, /border-bottom:/);
  assert.doesNotMatch(controls, /border-left/);
  assert.match(controls, /padding:\s*2px;/);
  assert.match(controls, /border-radius:\s*var\(--radius-md\);/);
  assert.match(controls, /background:\s*var\(--ds-tile\);/);
  assert.doesNotMatch(controls, /background:\s*var\(--ds-bg-primary\);/);

  const actions = styleBlock("\\.conversation-topbar \\.ct-actions");
  assert.match(actions, /padding:\s*2px;/);
  assert.match(actions, /background:\s*var\(--ds-tile\);/);
});

test("sidebar and work-panel headers use the shared toolbar metric", () => {
  assert.match(styleBlock("\\.sidebar-header"), /height:\s*var\(--ds-toolbar-height\);/);
  assert.match(styleBlock("\\.sidebar-header"), /flex:\s*0 0 var\(--ds-toolbar-height\);/);
  assert.match(styleBlock("\\.work-panel-header"), /height:\s*var\(--ds-toolbar-height\);/);
  assert.match(
    styleBlock("\\.settings-content"),
    /padding:\s*calc\(var\(--ds-toolbar-height\) \+ 8px\) 48px 56px 40px;/,
  );
});
