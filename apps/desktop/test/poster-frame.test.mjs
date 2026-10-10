/**
 * The decisions behind a poster frame: which clips need one, and how big the frame
 * is drawn.
 *
 * The decoding itself needs a DOM — that is the whole reason the frame is taken in
 * the renderer — so the parts that can be decided without one are kept out here,
 * where a test can pin them. The failure that matters most is a row pointing at a
 * clip: an <img> handed an mp4 decodes nothing, so the row has to lead with the
 * poster or with nothing at all.
 */
import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

const { POSTER_WIDTH, posterFrameSize, posterTargets } = await import(
  "../src/features/workbench/poster-frame.ts"
);

test("only a succeeded clip with a file and a loadable URL is asked for a poster", () => {
  const results = [
    {
      index: 0,
      status: "succeeded",
      path: "C:/lib/video/a.mp4",
      url: "media-asset://library/video/a.mp4",
    },
    {
      index: 1,
      status: "failed",
      path: "C:/lib/video/b.mp4",
      url: "media-asset://library/video/b.mp4",
    },
    { index: 2, status: "cancelled" },
    { index: 3, status: "succeeded", path: "C:/lib/video/d.mp4" },
    { index: 4, status: "succeeded", url: "media-asset://library/video/e.mp4" },
  ];
  assert.deepEqual(
    posterTargets("video", results).map((item) => item.index),
    [0],
    "a failed, cancelled, unloadable or unnamed item has no frame to take",
  );
});

test("an item that already has a poster is not asked again", () => {
  const results = [
    {
      index: 0,
      status: "succeeded",
      path: "C:/lib/video/a.mp4",
      url: "media-asset://library/video/a.mp4",
      thumbUrl: "media-asset://library/video/thumbs/a.png",
    },
  ];
  assert.deepEqual(posterTargets("video", results), [], "a second pass writes nothing");
});

test("an image run is never asked for a poster", () => {
  const results = [
    {
      index: 0,
      status: "succeeded",
      path: "C:/lib/image/a.png",
      url: "media-asset://library/image/a.png",
    },
  ];
  assert.deepEqual(posterTargets("image", results), [], "images get their copy in the main process");
});

test("a missing or empty result list asks for nothing", () => {
  assert.deepEqual(posterTargets("video", null), []);
  assert.deepEqual(posterTargets("video", undefined), []);
  assert.deepEqual(posterTargets("video", []), []);
});

test("a frame keeps the clip's shape at the poster's width", () => {
  assert.deepEqual(posterFrameSize(1024, 512), { width: POSTER_WIDTH, height: 32 });
  assert.deepEqual(posterFrameSize(1080, 1920), { width: POSTER_WIDTH, height: 114 });
  assert.deepEqual(
    posterFrameSize(1, 1000),
    { width: POSTER_WIDTH, height: 64000 },
    "an absurd ratio is still a number, not a crash",
  );
});

test("a clip that reports no dimensions gets no frame", () => {
  assert.equal(posterFrameSize(0, 0), null);
  assert.equal(posterFrameSize(0, 480), null);
  assert.equal(posterFrameSize(640, 0), null);
  assert.equal(posterFrameSize(Number.NaN, 480), null);
  assert.equal(posterFrameSize(640, Number.POSITIVE_INFINITY), null);
});
