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

test("a stored history item renders as text, not as its object", () => {
  // The transcript used to print [object Object] for every message: the item's
  // "content" field is itself an object, and the renderer passed that inner
  // object to String(). These are the shapes the Host actually returns.
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const start = script.indexOf("function textOf");
  const end = script.indexOf("function roleOf");
  assert.ok(start >= 0 && end > start, "the shell must define textOf before roleOf");

  const textOf = new Function(`${script.slice(start, end)}; return textOf;`)();

  assert.equal(
    textOf({ itemType: "message", content: { content: "你好，世界", role: "user" } }),
    "你好，世界",
  );

  // Assistant messages carry an array of typed blocks.
  assert.equal(
    textOf({ content: { content: [{ text: "第一段" }, { text: "第二段" }] } }),
    "第一段\n第二段",
  );

  // System scaffolding has no text a reader wants.
  assert.equal(textOf({ content: { content: "", modelSystem: { messageJson: "{}" } } }), "");
  assert.equal(textOf({ content: { content: "", role: "system" } }), "");

  // Anything unreadable degrades to an empty bubble, never to "[object Object]".
  assert.equal(textOf({ content: { content: { nested: true } } }), "");
  assert.equal(textOf(undefined), "");
});

test("a pairing link signs the page in without typing", () => {
  // The token rides in the fragment: a browser never sends that part to the
  // server, so it cannot land in a request log or a proxy trace.
  assert.ok(html.includes('hash.indexOf("#t=")'), "the shell must read the token from the fragment");
  assert.ok(html.includes("adoptPairingLink"), "the pairing step must exist");
  assert.equal(/[?&]t=/.test(html), false, "the token must never become a query parameter");

  // A link must not be able to replace the identity of an already paired device.
  assert.ok(html.includes("if (!value || token()) return false;"));
});
