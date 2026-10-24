import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  inlineVizMetaOf,
  srcDocFor,
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

test("html content is handed to srcDoc verbatim", () => {
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

test("the card renders a title, a kind badge, and a sandboxed iframe without scripts", () => {
  // Title and kind badge come from the shared primitives.
  assert.match(cardSource, /<span className="inline-viz-title" title=\{meta\.title\}>/);
  assert.match(cardSource, /<Badge tone="neutral">\{t\(`inlineViz\.kind\.\$\{meta\.kind\}`\)\}<\/Badge>/);
  // The iframe is the strictest possible sandbox: an empty sandbox attribute,
  // which grants no scripts and no same-origin access (ADR 0327).
  assert.match(cardSource, /\bsandbox=""\s*<\/iframe>|sandbox=""\n/);
  assert.doesNotMatch(cardSource, /allow-scripts/);
  assert.doesNotMatch(cardSource, /allow-same-origin/);
  // Content reaches the frame only through srcDoc, never through a host path.
  assert.match(cardSource, /srcDoc=\{srcDocFor\(meta\.kind, content\)\}/);
  // The preview is opt-in: without the persisted switch the card does not render.
  assert.match(cardSource, /settings\?\.inlineVisualizations === true/);
  // Reads are the only IPC: content is fetched on expand, never inlined from args.
  assert.match(cardSource, /readInlineVisualization\(meta\.sessionId, meta\.id\)/);
});