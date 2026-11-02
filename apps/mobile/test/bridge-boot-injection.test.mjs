import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { injectBridgeBoot } from "../scripts/inject-bridge-boot.mjs";

/**
 * The phone runs the desktop renderer through the bridge bundle. When the
 * bootstrap tag lands inside the renderer's module tag, the browser loads the
 * module from its src and never parses the nested script: the phone starts
 * with no `window.piDesktop`, every host call fails, and the settings pages
 * answer with an empty list instead of the service's models.
 */

const renderEntry = '<script type="module" crossorigin src="./assets/index-abc.js"></script>';

test("the bridge bootstrap is placed before the renderer entry", () => {
  const dir = mkdtempSync(join(tmpdir(), "qn-bridge-"));
  const file = join(dir, "index.html");
  writeFileSync(file, `<!doctype html><html><head>${renderEntry}</head><body></body></html>`);

  assert.equal(injectBridgeBoot(file), "injected");

  const html = readFileSync(file, "utf8");
  const bridgeAt = html.indexOf('src="./bridge-boot.js"');
  const entryAt = html.indexOf('src="./assets/index-abc.js"');
  assert.ok(bridgeAt >= 0, "bridge tag missing");
  assert.ok(entryAt >= 0, "renderer entry missing");
  assert.ok(bridgeAt < entryAt, "the bridge must load before the renderer entry");
  // The bootstrap must not be nested inside the module tag: a nested script is
  // never parsed.
  assert.doesNotMatch(html, /<script[^>]*src="[^"]*"[^>]*>\s*<script/);
});

test("the bootstrap is injected once", () => {
  const dir = mkdtempSync(join(tmpdir(), "qn-bridge-"));
  const file = join(dir, "index.html");
  writeFileSync(file, `<!doctype html><html><head>${renderEntry}</head></html>`);

  assert.equal(injectBridgeBoot(file), "injected");
  assert.equal(injectBridgeBoot(file), "already-present");
  const html = readFileSync(file, "utf8");
  assert.equal(html.split("bridge-boot.js").length - 1, 1);
});

test("a paired module script is handled too", () => {
  const dir = mkdtempSync(join(tmpdir(), "qn-bridge-"));
  const file = join(dir, "index.html");
  writeFileSync(
    file,
    '<!doctype html><html><head><script type="module" src="./assets/index.js"></script></head></html>',
  );

  assert.equal(injectBridgeBoot(file), "injected");
  const html = readFileSync(file, "utf8");
  assert.ok(html.indexOf("bridge-boot.js") < html.indexOf("./assets/index.js"));
});
