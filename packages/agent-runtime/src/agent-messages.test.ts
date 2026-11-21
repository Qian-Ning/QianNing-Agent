import { describe, expect, it } from "vitest";
import type { Usage } from "@earendil-works/pi-ai";
import { usageFromPi } from "./agent-messages.js";

describe("prompt cache usage accounting", () => {
  it("keeps cache reads and writes in the usage ledger", () => {
    const usage = usageFromPi({
      input: 100,
      output: 20,
      cacheRead: 80,
      cacheWrite: 10,
      totalTokens: 210,
      cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2, total: 3.3 },
    } as Usage);

    expect(usage).toMatchObject({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 80,
      cacheWriteTokens: 10,
      totalTokens: 210,
      usageOrigin: "pi",
      costStatus: "estimated",
    });
    expect(usage?.cost?.cacheRead).toBe(0.1);
    expect(usage?.cost?.cacheWrite).toBe(0.2);
  });

  it("does not turn an all-zero cost placeholder into a free turn", () => {
    const usage = usageFromPi({
      input: 100,
      output: 20,
      cacheRead: 80,
      cacheWrite: 10,
      totalTokens: 210,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    } as Usage);

    expect(usage).toMatchObject({
      inputTokens: 100,
      cacheReadTokens: 80,
      costStatus: "unknown",
    });
    expect(usage?.cost).toBeUndefined();
  });
});
