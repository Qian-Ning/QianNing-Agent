import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (rel) => readFileSync(join(ROOT, "apps/desktop", rel), "utf8");

const captureSrc = read("electron/main/wallpaper-thumbnail.ts");
const ipcSrc = read("electron/main/ipc/skin-wallpaper-ipc.ts");

test("a project with no still is captured from its own served URL", () => {
  // The frame must come from the same scheme the app mounts, or the card can
  // show something the engine never paints.
  assert.match(captureSrc, /wallpaper:\/\/project\/\$\{projectId\}/);
  assert.match(captureSrc, /capturePage\(\)/);
  assert.match(captureSrc, /writeFileSync\(join\(projectDir, name\), best\.png\)/);
});

test("the capture rig runs no page code", () => {
  // Projects are mounted with scripts disabled; the capture window must not
  // become the one place a workshop page gets to execute.
  assert.match(captureSrc, /javascript: false/);
  assert.match(captureSrc, /sandbox: true/);
  assert.match(captureSrc, /nodeIntegration: false/);
  assert.doesNotMatch(captureSrc, /executeJavaScript/);
});

test("a dark opening frame is retried before it is stored", () => {
  assert.match(captureSrc, /SAMPLE_AT_MS/);
  assert.match(captureSrc, /score > best\.score/);
  assert.match(captureSrc, /BRIGHT_ENOUGH/);
});

test("every import path fills in a missing still", () => {
  const calls = ipcSrc.match(/withPreview\(dataDir, project\)/g) ?? [];
  assert.equal(calls.length, 3, "import, bundled sample and preset all pass through it");
  assert.match(ipcSrc, /if \(project\.hasPreview\) return project;/);
});

test("the entry file is the one the manifest names", async () => {
  const work = mkdtempSync(join(tmpdir(), "wp-entry-"));
  const bundled = join(work, "store.cjs");
  try {
    await build({
      entryPoints: [join(ROOT, "apps/desktop/electron/main/wallpaper-store.ts")],
      bundle: true,
      platform: "node",
      format: "cjs",
      logLevel: "silent",
      outfile: bundled,
    });
    const store = createRequire(import.meta.url)(bundled);

    const named = join(work, "named");
    mkdirSync(named);
    writeFileSync(join(named, "project.json"), JSON.stringify({ type: "web", file: "scene.html" }));
    writeFileSync(join(named, "scene.html"), "<html></html>");
    assert.equal(store.readWallpaperEntryFile(named), "scene.html");

    const bare = join(work, "bare");
    mkdirSync(bare);
    writeFileSync(join(bare, "index.html"), "<html></html>");
    assert.equal(store.readWallpaperEntryFile(bare), "index.html");

    const empty = join(work, "empty");
    mkdirSync(empty);
    assert.equal(store.readWallpaperEntryFile(empty), null);

    // A manifest that points at a file the copy does not have must not win over
    // a real index.html, or the capture loads a 404.
    const broken = join(work, "broken");
    mkdirSync(broken);
    writeFileSync(join(broken, "project.json"), JSON.stringify({ file: "missing.html" }));
    writeFileSync(join(broken, "index.html"), "<html></html>");
    assert.equal(store.readWallpaperEntryFile(broken), "index.html");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
