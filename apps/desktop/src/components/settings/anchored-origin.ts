/**
 * Where an anchored surface's entrance scale grows from (design-system §8.9).
 *
 * `transform-origin` is expressed in the surface's own pixels, so the answer is
 * the anchor's near corner as an offset inside the box that has just been
 * placed. The clamp keeps the point on the surface for the case the viewport
 * pushed the anchor and the menu apart — the reason a hard-coded corner is
 * wrong: `bottom right` only holds for the one trigger position it was written
 * against.
 *
 * One expression, not a per-side branch: a surface placed below its anchor
 * resolves to the top edge, and one that had to flip above resolves to the
 * bottom edge, out of the same subtraction.
 */

/** A measured box in viewport coordinates, as `getBoundingClientRect` returns it. */
export type AnchorBox = { left: number; top: number };

/** The surface's placed layout box: where it is and how big it ended up. */
export type SurfaceBox = {
  left: number;
  top: number;
  width: number;
  height: number;
};

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

export function deriveEntranceOrigin(
  anchor: AnchorBox,
  surface: SurfaceBox,
): { x: number; y: number } {
  return {
    x: clamp(anchor.left - surface.left, 0, surface.width),
    y: clamp(anchor.top - surface.top, 0, surface.height),
  };
}
