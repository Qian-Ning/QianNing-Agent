import { readSettingsSource } from "./helpers/source-contracts.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadStyles } from "./helpers/styles.mjs";

const rowSource = await readFile(
  new URL("../src/components/settings/ThemeRow.tsx", import.meta.url),
  "utf8",
);
const settingsPageSource = await readSettingsSource();
const styles = await loadStyles();

function pickerRule(selector, body = "") {
  const grouped = `${selector}[^{]*\\{`;
  return body ? new RegExp(`${grouped}[^}]*${body}`, "s") : new RegExp(grouped);
}

test("theme picker uses an anchored menu so the settings card cannot clip it", () => {
  assert.match(rowSource, /AnchoredMenu/);
  assert.match(rowSource, /menuClassName="settings-theme-menu"/);
  assert.match(styles, pickerRule("\\.settings-theme-menu", "position:\\s*fixed;"));
  assert.match(styles, pickerRule("\\.settings-theme-menu\\.is-open"));
});

test("theme is a searchable picker row, not a card grid", () => {
  // The built-in order comes from the shared theme table, so the picker cannot
  // drift from the ids main and the panel host resolve.
  assert.match(rowSource, /BUILTIN_THEME_PREFERENCES\.map\(/);
  assert.doesNotMatch(rowSource, /BUILTIN_THEMES = \[/);
  assert.match(rowSource, /saveSettings\(\{ theme: id \}\)/);
  assert.match(settingsPageSource, /<ThemeRow /);
  assert.doesNotMatch(settingsPageSource, /settings-theme-grid/);
  assert.doesNotMatch(settingsPageSource, /settings-theme-card/);
  assert.doesNotMatch(styles, /\.settings-theme-grid\s*\{/);
  assert.doesNotMatch(styles, /\.settings-theme-card\s*\{/);
});

test("the retired 千凝 appearance is no longer offered", () => {
  // It was removed from BUILTIN_THEME_PREFERENCES, so the picker must not carry
  // a hard-coded branch for it any more. A stored `fox` row still resolves to
  // dark (theme.test.ts), which is why the runtime keeps the classification.
  assert.doesNotMatch(rowSource, /id === "fox"/);
  assert.doesNotMatch(rowSource, /settings\.themeFox/);
});

test("plugin themes join the same searchable list after the built-ins", () => {
  assert.match(rowSource, /pluginThemes\.map/);
  assert.match(rowSource, /kind: "plugin"/);
  assert.match(rowSource, /settings\.themeFromPlugin/);
  assert.match(rowSource, /showDivider/);
});

test("the theme trigger hugs the current label without a native field chrome", () => {
  assert.match(styles, pickerRule("\\.settings-theme-anchor", "width:\\s*max-content;"));
  assert.match(styles, pickerRule("\\.settings-theme-trigger", "width:\\s*max-content;"));
  assert.match(styles, pickerRule("\\.settings-theme-search input", "outline:\\s*none;"));
  assert.match(styles, pickerRule("\\.settings-theme-search input", "padding:\\s*0;"));
});
