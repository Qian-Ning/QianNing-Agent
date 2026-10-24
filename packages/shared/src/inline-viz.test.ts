import { describe, expect, it } from "vitest";
import {
  INLINE_VIZ_KINDS,
  MAX_INLINE_VIZ_CONTENT_BYTES,
  MAX_INLINE_VIZ_TITLE_CHARS,
  isInlineVisualizationKind,
} from "./inline-viz.js";

describe("inline visualization contract", () => {
  it("recognizes exactly the five accepted kinds", () => {
    expect(INLINE_VIZ_KINDS).toEqual(["html", "svg", "json", "csv", "text"]);
    for (const kind of INLINE_VIZ_KINDS) {
      expect(isInlineVisualizationKind(kind)).toBe(true);
    }
    for (const value of ["xml", "png", 3, null, undefined, ""]) {
      expect(isInlineVisualizationKind(value)).toBe(false);
    }
  });

  it("bounds content and titles so host-core and the tool schema agree", () => {
    expect(MAX_INLINE_VIZ_CONTENT_BYTES).toBe(512 * 1024);
    expect(MAX_INLINE_VIZ_TITLE_CHARS).toBe(120);
  });
});
