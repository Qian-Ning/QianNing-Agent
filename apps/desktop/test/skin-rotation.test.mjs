import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(root, rel), "utf8");

test("rotation only walks skins that carry a background", () => {
  const hook = read("src/features/skins/useSkinRotation.ts");
  assert.match(hook, /skin\.background\.kind !== "none"/);
  assert.match(hook, /pool\.length < 2/);
});

test("the rotation timer is cleared and skips a hidden window", () => {
  const hook = read("src/features/skins/useSkinRotation.ts");
  assert.match(hook, /clearInterval\(timer\)/);
  assert.match(hook, /document\.hidden/);
});

test("the shell runs the rotation hook", () => {
  const shell = read("src/features/app/AppShell.tsx");
  assert.match(shell, /useSkinRotation\(\)/);
});

test("skins are written through one queued writer", () => {
  const writer = read("src/features/skins/skin-settings-writer.ts");
  assert.match(writer, /let queue: Promise<unknown>/);
  assert.match(writer, /useAppStore\.getState\(\)\.settings/);
  const library = read("src/features/skins/useSkinLibrary.ts");
  assert.match(library, /writeSkinSettings\(patch\)/);
  assert.doesNotMatch(library, /queue\.current = run/);
});

test("the skin center exposes one rotation switch, not a scheduler", () => {
  const page = read("src/pages/SkinCenterPage.tsx");
  assert.match(page, /library\.rotation\.enabled/);
  assert.match(page, /library\.setRotation/);
});

test("a live wallpaper travels inside the bundle", () => {
  const ipc = read("electron/main/ipc/skin-ipc.ts");
  assert.match(ipc, /exportWallpaperFiles\(dataDir, projectId\)/);
  assert.match(ipc, /restoreWallpaperProject\(dataDir, bundle\.wallpaper\.files\)/);
  assert.match(ipc, /registerWallpaperProject\(dataDir, project\.projectId, wallpaperRoots\)/);
});

test("restored files cannot escape the project root", () => {
  const store = read("electron/main/wallpaper-store.ts");
  assert.match(store, /function safeRelativePath/);
  assert.match(store, /part === "\.\."/);
  assert.match(store, /!isInside\(target, out\)/);
});
