import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

/**
 * The client page is a built bundle now, so what the Host owes the phone is a
 * mapping from URL to file — not a page written here. These tests pin that
 * mapping: the document, its hashed assets, both prefixes, and the fact that a
 * path cannot climb out of the bundle directory.
 */

const fixture = mkdtempSync(join(tmpdir(), "qn-client-"));
mkdirSync(join(fixture, "assets"), { recursive: true });
writeFileSync(join(fixture, "index.html"), "<!doctype html><div id=root></div>");
writeFileSync(join(fixture, "assets", "app-abc123.js"), "console.log(1)");
writeFileSync(join(fixture, "assets", "app-abc123.css"), "body{margin:0}");
writeFileSync(join(fixture, "secret.txt"), "not for the wire");

process.env.PI_DESKTOP_MOBILE_SHELL = fixture;
const { serveClientShell } = await import(
  "../electron/main/remote/app-shell.ts"
);

test("/app serves the document", () => {
  for (const path of ["/app", "/app/", "/", "/index.html"]) {
    const asset = serveClientShell(path);
    assert.ok(asset, path + " must be served");
    assert.equal(asset.contentType, "text/html; charset=utf-8");
    assert.match(String(asset.body), /<div id=root>/);
  }
});

test("a hashed asset is served from either prefix", () => {
  for (const path of ["/assets/app-abc123.js", "/app/assets/app-abc123.js"]) {
    const asset = serveClientShell(path);
    assert.ok(asset, path + " must be served");
    assert.equal(asset.contentType, "text/javascript; charset=utf-8");
    assert.equal(String(asset.body), "console.log(1)");
  }
  const css = serveClientShell("/assets/app-abc123.css");
  assert.equal(css?.contentType, "text/css; charset=utf-8");
});

test("a path outside the bundle is refused", () => {
  assert.equal(serveClientShell("/app/../secret.txt"), null);
  assert.equal(serveClientShell("/../secret.txt"), null);
  // The file exists in the directory; it is the prefix that decides, not the disk.
  assert.equal(serveClientShell("/secret.txt"), null);
});

test("an unknown or missing path falls through to the protocol", () => {
  assert.equal(serveClientShell("/assets/missing.js"), null);
  assert.equal(serveClientShell("/v1/sessions"), null);
  assert.equal(serveClientShell("/cert"), null);
});

test("a directory is not served as a file", () => {
  assert.equal(serveClientShell("/app/assets"), null);
});
