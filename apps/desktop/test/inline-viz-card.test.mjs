import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  inlineVizMetaOf,
  sandboxAttrFor,
  scriptedSrcDocFor,
  srcDocFor,
  SCRIPTED_PREVIEW_CSP,
} from "../src/lib/inline-viz.ts";

const cardSource = await readFile(
  new URL("../src/features/chat/transcript/InlineVisualizationCard.tsx", import.meta.url),
  "utf8",
);

const meta = {
  id: "viz-1",
  sessionId: "session-1",
  title: "Usage chart",
  kind: "svg",
  createdAt: "2026-10-25T00:00:00.000Z",
};

test("the payload parser accepts a well-formed visualization reference", () => {
  assert.deepEqual(inlineVizMetaOf({ visualization: meta }), meta);
});

test("the payload parser fails closed on malformed or spoofed references", () => {
  assert.equal(inlineVizMetaOf(null), null);
  assert.equal(inlineVizMetaOf("svg"), null);
  assert.equal(inlineVizMetaOf({ visualization: "x" }), null);
  assert.equal(inlineVizMetaOf({ visualization: { ...meta, kind: "pdf" } }), null);
  assert.equal(inlineVizMetaOf({ visualization: { ...meta, id: "" } }), null);
  assert.equal(inlineVizMetaOf({ visualization: { ...meta, sessionId: "" } }), null);
  assert.equal(inlineVizMetaOf({ visualization: { ...meta, title: "" } }), null);
  assert.equal(inlineVizMetaOf({ visualization: { ...meta, createdAt: 42 } }), null);
  // A payload without the visualization key is not a card.
  assert.equal(inlineVizMetaOf({ somethingElse: true }), null);
});

test("html content is handed to srcDoc verbatim on the static path", () => {
  assert.equal(srcDocFor("html", "<h1>Hello</h1>"), "<h1>Hello</h1>");
});

test("svg content is wrapped in a minimal document so it parses inline", () => {
  const doc = srcDocFor("svg", "<svg><circle/></svg>");
  assert.match(doc, /^<!doctype html>/);
  assert.match(doc, /<svg><circle\/><\/svg>/);
});

test("json/csv/text are escaped so untrusted content is never parsed as markup", () => {
  for (const kind of ["json", "csv", "text"]) {
    const doc = srcDocFor(kind, "<script>alert(1)</script>&");
    assert.match(doc, /<pre>&lt;script&gt;alert\(1\)&lt;\/script&gt;&amp;<\/pre>/);
    assert.doesNotMatch(doc, /<script>/);
  }
});

test("a static preview grants no script and no same-origin access", () => {
  for (const kind of ["html", "svg", "json", "csv", "text"]) {
    assert.equal(sandboxAttrFor({ kind, scriptedAllowed: false }), "");
  }
});

test("only html upgrades when scripted previews are allowed", () => {
  assert.equal(sandboxAttrFor({ kind: "html", scriptedAllowed: true }), "allow-scripts");
  for (const kind of ["svg", "json", "csv", "text"]) {
    assert.equal(sandboxAttrFor({ kind, scriptedAllowed: true }), "");
  }
});

test("scripted previews never carry allow-same-origin", () => {
  // The value that would let agent markup reach the app origin. It must not
  // appear anywhere in the sandbox mapping or the card source.
  assert.doesNotMatch(
    sandboxAttrFor({ kind: "html", scriptedAllowed: true }),
    /allow-same-origin/,
  );
  assert.doesNotMatch(cardSource, /allow-same-origin/);
  // The only sandbox value the card ever computes is the helper's.
  assert.match(cardSource, /sandboxAttrFor\(\{ kind: meta\.kind, scriptedAllowed: scripted \}\)/);
});

test("the scripted document carries a network-closed CSP ahead of the content", () => {
  const doc = scriptedSrcDocFor("<script>draw()</script>");
  assert.match(doc, /^<!doctype html><meta charset="utf-8">/);
  assert.match(doc, /http-equiv="Content-Security-Policy"/);
  assert.match(doc, /script-src 'unsafe-inline'/);
  // Nothing networks out, so a chart cannot exfiltrate through a fetch.
  assert.doesNotMatch(SCRIPTED_PREVIEW_CSP, /https?:/);
  assert.doesNotMatch(SCRIPTED_PREVIEW_CSP, /\bwss?:/);
  // The artifact's own body is preserved untouched after the wrapper.
  assert.match(doc, /<script>draw\(\)<\/script>$/);
});

test("the card streams documents from the scheme and falls back to srcDoc", () => {
  // Documents the frame renders natively stream from the confined scheme.
  assert.match(cardSource, /const STREAMED_KINDS = new Set\(\["html", "svg"\]\)/);
  assert.match(cardSource, /src=\{streaming \? \(schemeUrl \?\? undefined\) : undefined\}/);
  // Textual kinds always take the escaped srcDoc path.
  assert.match(cardSource, /srcDocFor\(meta\.kind, content \?\? ""\)/);
  // The probe is the fallback: a failed request reads through IPC instead.
  assert.match(cardSource, /fetch\(schemeUrl\)/);
  assert.match(cardSource, /readInlineVisualization\(meta\.sessionId, meta\.id\)/);
  // Both switches gate the card and the scripted upgrade respectively.
  assert.match(cardSource, /settings\?\.inlineVisualizations === true/);
  assert.match(cardSource, /settings\?\.inlineVizScriptedPreviews === true/);
  // A scripted preview is always announced in the header.
  assert.match(cardSource, /\{scripted \? \(/);
  assert.match(cardSource, /t\("inlineViz\.scriptedBadge"\)/);
});
