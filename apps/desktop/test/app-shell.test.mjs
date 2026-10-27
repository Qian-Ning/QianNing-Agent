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

test("the login page offers the certificate it must be trusted with", () => {
  // A phone cannot reach this listener until its certificate is installed, so the
  // page has to offer that certificate rather than only describe the problem.
  assert.ok(html.includes('href="/cert"'), "the login page must link to the certificate");
  assert.ok(html.includes("download=") || html.includes("/cert.crt"), "the link must save a file");
});

test("a tool call is shown as its own step, not folded into prose", () => {
  // "the agent changed something" is not the same as knowing which file it
  // touched, so a tool item gets its own renderer rather than a text bubble.
  assert.ok(html.includes("function renderTool"), "tool items need their own renderer");
  assert.ok(html.includes('class="msg tool'), "tool items need their own class");
  assert.ok(html.includes('if (message.itemType === "tool") return true;'),
    "a tool step must survive even when nothing about it is readable");
});

test("a session can be started from the phone", () => {
  assert.ok(html.includes('call("/v1/sessions"'), "the phone must be able to create a session");
  assert.ok(html.includes("function newSession"));
});

test("a running turn can be stopped from the phone", () => {
  assert.ok(html.includes(":interrupt"), "the stop action must call turn/interrupt");
  assert.ok(html.includes("state.activeTurnId"), "the stop button is gated on a live turn");
});

test("the working-tree diff can be read from the phone", () => {
  // The route has to exist first: RACP exposes 40 operations but only the ones
  // in RACP_HTTP_ROUTES are reachable over HTTP.
  assert.ok(html.includes("/diff"), "the page must call the diff route");
  assert.ok(html.includes("function renderDiffFile"), "each changed file gets its own row");
  // A binary file or one over the cap has no hunks; the row still has to show up.
  assert.ok(html.includes("file.binary") && html.includes("file.tooLarge"));
});

test("a session can be deleted from the phone", () => {
  // The route has to exist: session/delete was a working operation with no HTTP
  // entry, so the page could not reach it.
  assert.ok(html.includes('":delete"'), "the page must call the delete route");
  assert.ok(html.includes("function forgetSession"));
  // Deleting a conversation is not reversible, so the row asks first.
  assert.ok(html.includes("armedSessionId"), "the delete action must be two-step");
  assert.ok(html.includes('state.editing'), "rows stay tap-to-open until edit mode");
});
