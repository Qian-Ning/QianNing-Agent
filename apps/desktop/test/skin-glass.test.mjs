import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const css = readFileSync(join(root, "src/styles/skins.css"), "utf8");
const engine = readFileSync(join(root, "src/lib/skin-engine.ts"), "utf8");

test("the canvas goes clear, or a background layer at z-index -1 paints under it", () => {
  assert.match(css, /:root\[data-skin-bg\]\s*\{\s*background-color:\s*transparent;/);
});

test("glass exists on the chrome surfaces over a wallpaper", () => {
  assert.match(css, /backdrop-filter:\s*blur\(var\(--qn-glass-blur/);
  assert.match(css, /-webkit-backdrop-filter:\s*blur\(var\(--qn-glass-blur/);
  assert.match(css, /:root\[data-skin-bg\] \.sidebar-surface,[\s\S]{0,400}backdrop-filter/);
  assert.match(css, /:root\[data-skin-bg\] \.composer-shell\s*\{[\s\S]{0,400}backdrop-filter/);
});

test("the light theme frosted harder than the dark one", () => {
  const dark = css.match(/data-theme="dark"\]\s*\{[^}]*--qn-glass-veil:\s*([\d.]+)/);
  const light = css.match(/data-theme="light"\]\s*\{[^}]*--qn-glass-veil:\s*([\d.]+)/);
  assert.ok(dark && light, "both theme blocks declare a veil");
  assert.ok(Number(light[1]) > Number(dark[1]), "light glass needs the thicker wash");
});

test("reduced transparency falls back to an opaque panel", () => {
  assert.match(css, /prefers-reduced-transparency: reduce/);
});

test("a live wallpaper keeps a scrim floor", () => {
  assert.match(engine, /isLive\s*\?\s*Math\.max\(clampBg\(bg\.scrim, "scrim"\), 0\.3\)/);
});

test("muted sidebar labels borrow primary ink in the light theme", () => {
  assert.match(
    css,
    /data-theme="light"\] \.sidebar-surface \.sidebar-list-label/,
  );
});
