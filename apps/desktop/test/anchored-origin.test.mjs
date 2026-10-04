/**
 * Anchored surface entrance origin (design-system §8.9, D650).
 *
 * The guard in scripts/check-motion.mjs stops a hard-coded corner keyword from
 * coming back. This pins the derivation itself, including the two placements a
 * corner keyword cannot express: a surface flipped above its anchor, and one the
 * viewport pushed away from it.
 *
 * `place` mirrors AnchoredMenu's placement (MARGIN 8, GAP 6, the same
 * preferred/fallback fit test) so each case below reads as a placement someone
 * could see on screen. The origin is the unit under test; the placement is the
 * input that makes it meaningful.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { deriveEntranceOrigin } from "../src/components/settings/anchored-origin.ts";

const MARGIN = 8;
const GAP = 6;

/** A 220x300 menu placed against a 1280x800 viewport, exactly as the component does. */
function place({
  anchor,
  width = 220,
  height = 300,
  align = "start",
  side = "bottom",
  viewport = { w: 1280, h: 800 },
}) {
  const maxLeft = Math.max(MARGIN, viewport.w - width - MARGIN);
  const preferredLeft = align === "end" ? anchor.right - width : anchor.left;
  const left = Math.min(Math.max(MARGIN, preferredLeft), maxLeft);

  const maxTop = Math.max(MARGIN, viewport.h - height - MARGIN);
  const below = anchor.bottom + GAP;
  const above = anchor.top - height - GAP;
  const preferredTop = side === "top" ? above : below;
  const fallbackTop = side === "top" ? below : above;
  const fits = (value) => value >= MARGIN && value <= maxTop;
  const top = fits(preferredTop)
    ? preferredTop
    : fits(fallbackTop)
      ? fallbackTop
      : Math.min(Math.max(MARGIN, preferredTop), maxTop);

  const surface = { left, top, width, height };
  return { surface, origin: deriveEntranceOrigin(anchor, surface) };
}

test("a menu under its anchor grows from its top-left corner", () => {
  const { surface, origin } = place({ anchor: { left: 120, top: 200, right: 176, bottom: 228 } });
  assert.equal(surface.left, 120);
  assert.equal(surface.top, 234);
  assert.deepEqual(origin, { x: 0, y: 0 });
});

test("a right-aligned menu grows from the anchor's left edge, not the surface's", () => {
  // assert="end" puts the surface's right edge on the trigger's right edge, so
  // the trigger sits inset by its own width. A corner keyword would say the
  // surface grows from its right edge; the anchor is 28px wide, so it is not.
  const anchor = { left: 612, top: 200, right: 640, bottom: 228 };
  const { surface, origin } = place({ anchor, align: "end" });
  assert.equal(surface.left + surface.width, 640, "right edges meet");
  assert.equal(origin.x, 612 - 420);
  assert.equal(origin.y, 0);
  assert.ok(origin.x < surface.width, "origin stays on the surface");
});

test("a request to open upward that fits grows from the bottom edge", () => {
  const anchor = { left: 120, top: 406, right: 176, bottom: 434 };
  const { surface, origin } = place({ anchor, side: "top" });
  assert.equal(surface.top, 100, "placed above the anchor, with the gap");
  assert.equal(surface.top + surface.height, anchor.top - GAP, "its bottom edge faces the anchor");
  assert.equal(origin.y, 300, "the bottom edge, derived — not a written `bottom`");
  assert.equal(origin.x, 0);
});

test("a menu the viewport pushed away grows from the nearest point on its edge", () => {
  // The trigger is against the right edge of the window, so the surface is
  // clamped leftwards and no longer sits under it: the placement is 1150 - 1052
  // = 98px in from the surface's left edge, not 0. This is the placement a
  // hard-coded `bottom right` gets wrong, and the reason the clamp is here.
  const anchor = { left: 1150, top: 200, right: 1206, bottom: 228 };
  const { surface, origin } = place({ anchor });
  assert.equal(surface.left, 1052, "clamped to the viewport margin");
  assert.equal(origin.x, anchor.left - surface.left);
  assert.ok(origin.x > 0 && origin.x < surface.width, "an interior point, not an edge");
});

test("the origin never leaves the surface box", () => {
  const width = 220;
  const height = 300;
  for (let left = 0; left <= 1400; left += 7) {
    for (let top = 0; top <= 900; top += 7) {
      for (const align of ["start", "end"]) {
        for (const side of ["bottom", "top"]) {
          const anchor = { left, top, right: left + 56, bottom: top + 28 };
          const { surface, origin } = place({ anchor, width, height, align, side });
          assert.ok(origin.x >= 0 && origin.x <= surface.width, `x ${origin.x} for anchor ${left}`);
          assert.ok(origin.y >= 0 && origin.y <= surface.height, `y ${origin.y} for anchor ${top}`);
          assert.ok(Number.isFinite(origin.x) && Number.isFinite(origin.y));
        }
      }
    }
  }
});

test("a box that already fills the surface keeps the origin at its own corner", () => {
  // matchAnchorWidth: the surface is the anchor's width, so its left edge is the
  // anchor's left edge and the top-left corner is the honest answer.
  const anchor = { left: 300, top: 100, right: 520, bottom: 128 };
  const { origin } = place({ anchor, width: anchor.right - anchor.left });
  assert.deepEqual(origin, { x: 0, y: 0 });
});
