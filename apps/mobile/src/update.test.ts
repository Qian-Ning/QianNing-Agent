import { describe, expect, it } from "vitest";

import { isNewer } from "./update";

describe("isNewer", () => {
  it("compares numbers, not strings", () => {
    expect(isNewer("2.10.0", "2.9.9")).toBe(true);
    expect(isNewer("2.2.4", "2.2.3")).toBe(true);
    expect(isNewer("2.2.3", "2.2.3")).toBe(false);
    expect(isNewer("2.2.2", "2.2.3")).toBe(false);
  });

  it("treats a missing segment as zero", () => {
    expect(isNewer("2.3", "2.3.0")).toBe(false);
    expect(isNewer("2.3.1", "2.3")).toBe(true);
  });
});
