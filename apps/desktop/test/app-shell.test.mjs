/**
 * The client shell is a string, which means nothing type-checks it: a stray
 * quote inside the template would ship a page that renders and then does
 * nothing. These parse it the way a browser would and assert the pieces the
 * protocol calls depend on are present.
 */
import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

const { serveClientShell } = await import("../electron/main/remote/app-shell.ts");

const html = serveClientShell("/app")?.body ?? "";

test("serves the shell at /app and at the root, and nothing else", () => {
  assert.equal(serveClientShell("/app")?.contentType, "text/html; charset=utf-8");
  assert.equal(serveClientShell("/")?.body, html);
  assert.equal(serveClientShell("/v1/sessions"), null);
  assert.equal(serveClientShell("/app/extra"), null);
});

test("the inline script parses", () => {
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(match, "the shell must carry one inline script");
  assert.doesNotThrow(() => new Function(match[1]), "the inline script must parse as JavaScript");
});

test("the page calls the operations it renders", () => {
  for (const fragment of [
    "/v1/sessions",
    "/turns",
    "/history",
    "/events",
    "/v1/approvals/",
    "allow-once",
    "allow-session",
    "deny",
    "authorization",
  ]) {
    assert.ok(html.includes(fragment), `the shell must reference ${fragment}`);
  }
});

test("the token is never put in a URL", () => {
  // A token in a query string is rejected by the Host; the page must not try.
  assert.equal(/[?&](token|auth|key)=/.test(html), false);
});
