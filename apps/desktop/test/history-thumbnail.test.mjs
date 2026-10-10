/**
 * `pickRowThumbnail` — which image a history row leads with.
 *
 * The rule is small but it is the whole of the feature's visible behaviour, and
 * it is easy to get subtly wrong: a run holds several outputs, some of them
 * failures, and the row must always show the *first good* one rather than
 * whichever output happens to be first. These tests pin that choice so a later
 * edit to the row markup cannot quietly change which picture the user sees.
 */
import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

const { pickRowThumbnail } = await import("../src/features/workbench/history-thumbnail.ts");

/** A run with only the fields `pickRowThumbnail` reads from, plus a sane rest. */
function run(overrides = {}) {
  return {
    id: "r1",
    capability: "image",
    sessionId: "s1",
    prompt: "a cat",
    model: null,
    startedAt: 0,
    results: null,
    states: {},
    total: 0,
    ok: null,
    ...overrides,
  };
}

test("returns the url of the first succeeded result", () => {
  const entry = run({
    results: [
      { index: 0, status: "succeeded", url: "media-asset://library/image/a.png" },
    ],
  });
  assert.equal(pickRowThumbnail(entry), "media-asset://library/image/a.png");
});

test("the derived small copy is preferred over the full-size file", () => {
  const entry = run({
    results: [
      {
        index: 0,
        status: "succeeded",
        url: "media-asset://library/image/a.png",
        thumbUrl: "media-asset://library/image/thumbs/a.png",
      },
    ],
  });
  // A row decodes whatever it points at, so the copy is what keeps a 32px box
  // from decoding a full-size render on every paint.
  assert.equal(pickRowThumbnail(entry), "media-asset://library/image/thumbs/a.png");
});

test("a clip row leads with its poster frame when it has one", () => {
  const entry = run({
    capability: "video",
    results: [
      {
        index: 0,
        status: "succeeded",
        url: "media-asset://library/video/clip.mp4",
        thumbUrl: "media-asset://library/video/thumbs/clip.png",
      },
    ],
  });
  // A poster is the only picture a clip row can have: the clip itself would
  // decode to nothing inside an <img>.
  assert.equal(pickRowThumbnail(entry), "media-asset://library/video/thumbs/clip.png");
});

test("a result whose copy was never written falls back to the full-size file", () => {
  const entry = run({
    results: [
      { index: 0, status: "succeeded", url: "media-asset://library/image/old.png", thumbUrl: "" },
    ],
  });
  assert.equal(pickRowThumbnail(entry), "media-asset://library/image/old.png");
});

test("a succeeded result without a url yields undefined", () => {
  const entry = run({ results: [{ index: 0, status: "succeeded" }] });
  assert.equal(pickRowThumbnail(entry), undefined);
});

test("failed and cancelled results are skipped, url or not", () => {
  const entry = run({
    results: [
      { index: 0, status: "failed", url: "media-asset://library/image/bad.png" },
      { index: 1, status: "cancelled", url: "media-asset://library/image/gone.png" },
    ],
  });
  assert.equal(pickRowThumbnail(entry), undefined);
});

test("only the first successful result is used, not the first result's url", () => {
  const entry = run({
    results: [
      { index: 0, status: "failed", url: "media-asset://library/image/first.png" },
      { index: 1, status: "succeeded", url: "media-asset://library/image/second.png" },
      { index: 2, status: "succeeded", url: "media-asset://library/image/third.png" },
    ],
  });
  assert.equal(pickRowThumbnail(entry), "media-asset://library/image/second.png");
});

test("an empty result list yields undefined", () => {
  assert.equal(pickRowThumbnail(run({ results: [] })), undefined);
});

test("a null result list yields undefined without throwing", () => {
  assert.equal(pickRowThumbnail(run({ results: null })), undefined);
});

test("a missing result list yields undefined without throwing", () => {
  const entry = run();
  delete entry.results;
  assert.equal(pickRowThumbnail(entry), undefined);
});

test("a video row yields undefined even with a loadable result", () => {
  const entry = run({
    capability: "video",
    results: [
      { index: 0, status: "succeeded", url: "media-asset://library/video/clip.mp4" },
    ],
  });
  assert.equal(pickRowThumbnail(entry), undefined);
});
