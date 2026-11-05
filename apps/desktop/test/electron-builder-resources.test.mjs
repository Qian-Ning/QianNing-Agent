import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const REPOSITORY_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const PACKAGE = join(REPOSITORY_ROOT, "apps/desktop/package.json");
const source = readFileSync(PACKAGE, "utf8");
const pkg = JSON.parse(source);

/**
 * `build.extraResources` is the only way a runtime asset reaches a packaged
 * app. Two arrays under the same key parse to one — the first silently
 * disappears — so the shape itself is part of the contract.
 */
test("the shared extraResources list is declared exactly once", () => {
  // Platform blocks (win/mac/linux) carry their own list six spaces deep and
  // are unioned with this one by electron-builder. Only the four-space key is
  // the shared list, and two of those parse as one — the first disappears.
  const occurrences = source.match(/^ {4}"extraResources":/gm) ?? [];
  assert.equal(occurrences.length, 1, "a duplicate key shadows the earlier array");
});

test("every runtime asset the main process loads is packaged", () => {
  const entries = pkg.build.extraResources.map((entry) => entry.to);
  for (const required of [
    "mobile-shell",
    "wallpaper-demo",
    "wallpapers",
    "skills",
    "plugins",
    "models.dev",
  ]) {
    assert.ok(entries.includes(required), `${required} is not in extraResources`);
  }
});

test("the wallpaper demo is a complete project, not a directory name", () => {
  const entry = pkg.build.extraResources.find((item) => item.to === "wallpaper-demo");
  const root = join(REPOSITORY_ROOT, "apps/desktop", entry.from);
  assert.ok(existsSync(join(root, "project.json")), "project.json is what the store validates");
  assert.ok(existsSync(join(root, "index.html")), "project.json names index.html as its entry");
});
