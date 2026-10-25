import assert from "node:assert/strict";
import test from "node:test";
import {
  inlineVizResponseHeaders,
  inlineVizMimeType,
  parseInlineVizUrl,
  inlineVizUrlFor,
  INLINE_VIZ_SCHEME,
} from "../electron/main/inline-viz-scheme.ts";

test("the scheme name is the reserved one", () => {
  assert.equal(INLINE_VIZ_SCHEME, "qn-visuals");
});

test("a well-formed artifact URL parses to its two ids", () => {
  assert.deepEqual(parseInlineVizUrl("qn-visuals://localhost/session-1/viz-1"), {
    sessionId: "session-1",
    visualizationId: "viz-1",
    scripted: false,
  });
  // An authority-less form is accepted too: the handler treats it as local.
  assert.deepEqual(parseInlineVizUrl("qn-visuals:///session-1/viz-1"), {
    sessionId: "session-1",
    visualizationId: "viz-1",
    scripted: false,
  });
});

test("the scripted tier is opt-in by the literal 1 and nothing else", () => {
  assert.equal(
    parseInlineVizUrl("qn-visuals://localhost/s/v?scripted=1")?.scripted,
    true,
  );
  for (const value of ["0", "true", "yes", ""]) {
    assert.equal(
      parseInlineVizUrl(`qn-visuals://localhost/s/v?scripted=${value}`)?.scripted,
      false,
    );
  }
});

test("the parser refuses everything the scheme must not serve", () => {
  const refused = [
    // Foreign schemes.
    "http://localhost/session-1/viz-1",
    "file:///etc/passwd",
    // Remote authority: the scheme is local-only.
    "qn-visuals://evil.example/session-1/viz-1",
    // Wrong segment count.
    "qn-visuals://localhost/session-1",
    "qn-visuals://localhost/session-1/viz-1/extra",
    "qn-visuals://localhost/",
    // Traversal and separator smuggling.
    "qn-visuals://localhost/../viz-1",
    "qn-visuals://localhost/session-1/..%2Fviz",
    "qn-visuals://localhost/session-1/%2e%2e",
    "qn-visuals://localhost/session%201/viz-1",
    // Not a URL at all.
    "not a url",
    "",
  ];
  for (const url of refused) {
    assert.equal(parseInlineVizUrl(url), null, `should refuse: ${url}`);
  }
});

test("the URL builder round-trips through the parser", () => {
  const url = inlineVizUrlFor("session-1", "viz-1");
  assert.equal(url, "qn-visuals://localhost/session-1/viz-1");
  assert.deepEqual(parseInlineVizUrl(url), {
    sessionId: "session-1",
    visualizationId: "viz-1",
    scripted: false,
  });

  const scripted = inlineVizUrlFor("session-1", "viz-1", { scripted: true });
  assert.equal(scripted, "qn-visuals://localhost/session-1/viz-1?scripted=1");
  assert.equal(parseInlineVizUrl(scripted)?.scripted, true);
});

test("the URL builder refuses ids that are not safe path segments", () => {
  for (const bad of ["", "../x", "a/b", "a b", "%2e%2e"]) {
    assert.equal(inlineVizUrlFor(bad, "viz-1"), null, `session: ${bad}`);
    assert.equal(inlineVizUrlFor("session-1", bad), null, `viz: ${bad}`);
  }
});

test("the static tier permits no script at all", () => {
  const csp = inlineVizResponseHeaders("text/html; charset=utf-8", {
    scripted: false,
  })["content-security-policy"];
  assert.doesNotMatch(csp, /script-src/);
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /img-src data:/);
});

test("the scripted tier permits inline script and still no network", () => {
  const csp = inlineVizResponseHeaders("text/html; charset=utf-8", {
    scripted: true,
  })["content-security-policy"];
  assert.match(csp, /script-src 'unsafe-inline'/);
  assert.match(csp, /default-src 'none'/);
  // Nothing may reach the network: no http(s), ws(s), or bare host sources.
  assert.doesNotMatch(csp, /https?:/);
  assert.doesNotMatch(csp, /\bwss?:/);
});

test("every response is sniff-proof and typed from the stored kind", () => {
  const headers = inlineVizResponseHeaders("text/html; charset=utf-8", {
    scripted: false,
  });
  assert.equal(headers["x-content-type-options"], "nosniff");
  assert.equal(headers["content-type"], "text/html; charset=utf-8");
});

test("the MIME type follows the kind and rejects unknown kinds", () => {
  assert.equal(inlineVizMimeType("html"), "text/html; charset=utf-8");
  assert.equal(inlineVizMimeType("svg"), "image/svg+xml");
  assert.equal(inlineVizMimeType("json"), "application/json");
  assert.equal(inlineVizMimeType("csv"), "text/csv; charset=utf-8");
  assert.equal(inlineVizMimeType("text"), "text/plain; charset=utf-8");
  assert.equal(inlineVizMimeType("pdf"), null);
  assert.equal(inlineVizMimeType(""), null);
});
