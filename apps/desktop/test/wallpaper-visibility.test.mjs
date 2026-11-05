import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const runtime = await readFile(new URL("../src/lib/wallpaper-runtime.ts", import.meta.url), "utf8");

test("a wallpaper mounted while the window is hidden is rebuilt, not resumed", () => {
  // `webwallgl` pauses a page's CSS animations on mount and its `play()` does
  // not restart them, so an instance mounted behind a minimised window stays
  // frozen forever. It has to be destroyed and mounted again on the next
  // visible frame.
  assert.match(runtime, /pausedAtMount: boolean/);
  assert.match(runtime, /const hidden = document\.hidden;/);
  assert.match(runtime, /pausedAtMount: hidden/);
  assert.match(runtime, /if \(current\.pausedAtMount\) \{/);
  assert.match(runtime, /applyLiveWallpaper\(background, layer\)/);
  // Resume stays the path for an instance that was mounted while visible.
  assert.match(runtime, /current\.instance\?\.play\?\.\(\);/);
});

test("the rebuild keeps the layer and the project", () => {
  assert.match(runtime, /const \{ background, host \} = current;/);
  assert.match(runtime, /const layer = host\.parentElement;/);
  // The listener is bound once, inside the mount path, and is idempotent.
  assert.match(runtime, /if \(visibilityBound\) return;/);
  assert.match(runtime, /bindVisibility\(\);/);
});
