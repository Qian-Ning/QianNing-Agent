import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const MODULE = join(ROOT, "apps/desktop/electron/main/wallpaper-presets.ts");
const GALLERY = join(ROOT, "apps/desktop/resources/wallpapers");

const work = mkdtempSync(join(tmpdir(), "wp-presets-"));
const bundled = join(work, "presets.cjs");
execFileSync(
  process.execPath,
  [
    join(ROOT, "node_modules/esbuild/bin/esbuild"),
    MODULE,
    "--bundle",
    "--platform=node",
    "--format=cjs",
    `--outfile=${bundled}`,
  ],
  { stdio: "pipe" },
);
const presets = await import(`file://${bundled.replace(/\\/g, "/")}`);

test.after(() => rmSync(work, { recursive: true, force: true }));

test("every shipped preset is a servable web project", () => {
  const list = presets.listWallpaperPresets(GALLERY);
  assert.ok(list.length >= 5, `expected the bundled gallery in ${GALLERY}`);

  for (const preset of list) {
    assert.match(preset.id, /^[a-z0-9-]+$/, `${preset.id} must stay a plain slug`);
    assert.ok(preset.title.trim(), `${preset.id} needs a title`);
    assert.match(preset.accent, /^#[0-9a-f]{6}$/i, `${preset.id} needs a tile colour`);
    assert.ok(preset.bytes > 0, `${preset.id} should report its size`);

    const dir = join(GALLERY, preset.id);
    const manifest = JSON.parse(readFileSync(join(dir, "project.json"), "utf8"));
    assert.equal(manifest.type, "web");
    assert.equal(manifest.title, preset.title);
    assert.ok(existsSync(join(dir, manifest.file)), `${preset.id} entry file missing`);
    // The engine mounts web projects with scripts disabled; a preset that needs
    // JavaScript would import fine and then sit perfectly still.
    // Every preset ships a still, because a 152px card cannot mount a project.
    assert.equal(manifest.preview, "preview.jpg", `${preset.id} needs a card still`);
    assert.ok(existsSync(join(dir, manifest.preview)), `${preset.id} preview missing`);

    const html = readFileSync(join(dir, manifest.file), "utf8");
    assert.doesNotMatch(html, /<script/i, `${preset.id} must animate without scripts`);
    assert.match(html, /animation:/, `${preset.id} should carry a CSS animation`);
  }
});

test("the gallery credits its sources", () => {
  const credits = readFileSync(join(GALLERY, "ATTRIBUTION.md"), "utf8");
  assert.match(credits, /CC0/);
  assert.match(credits, /Unsplash/);
});

test("installing copies the project and mints a fresh id", () => {
  const dataDir = mkdtempSync(join(work, "data-"));
  try {
    const id = presets.listWallpaperPresets(GALLERY)[0].id;
    const project = presets.installWallpaperPreset(dataDir, GALLERY, id);

    assert.match(project.projectId, /^[0-9a-f]{16}$/);
    assert.equal(project.hasPreview, true);
    assert.equal(project.preview, "preview.jpg");
    const copied = join(dataDir, "wallpapers", project.projectId);
    assert.ok(existsSync(join(copied, "project.json")));
    assert.ok(existsSync(join(copied, "index.html")));
    assert.ok(existsSync(join(copied, "assets", "bg.jpg")));
    // Two installs of the same preset are two projects; the gallery folder is
    // never handed to the profile by reference.
    const again = presets.installWallpaperPreset(dataDir, GALLERY, id);
    assert.notEqual(again.projectId, project.projectId);
    assert.equal(readdirSync(join(dataDir, "wallpapers")).length, 2);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("an id outside the gallery is refused", () => {
  const dataDir = mkdtempSync(join(work, "data-"));
  try {
    for (const id of ["../wallpaper-demo", "../../package.json", "", "nope"]) {
      assert.throws(() => presets.installWallpaperPreset(dataDir, GALLERY, id), /unknown wallpaper preset/);
    }
    assert.equal(existsSync(join(dataDir, "wallpapers")), false);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("a missing gallery lists empty instead of throwing", () => {
  assert.deepEqual(presets.listWallpaperPresets(join(work, "does-not-exist")), []);
});
