import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const appSource = await readFile(new URL("./app.ts", import.meta.url), "utf8");

/**
 * The headless stop path must not await the inbound messaging loop unbounded:
 * the loop's own host calls carry no abort signal, so a single in-flight
 * iteration can be waiting on a host RPC whose deadline is far longer than a
 * stop may wait. It aborts the controller and bounds the wait, the same shape
 * the desktop quit uses, and the abort and the bounded wait both run before the
 * host is disposed.
 */
describe("headless stop", () => {
  it("aborts the inbound loop and bounds the wait before disposing the host", () => {
    const stopSource = appSource.slice(appSource.indexOf("async stop()"));
    const abortAt = stopSource.indexOf("messaging.controller.abort()");
    const boundAt = stopSource.indexOf("settleWithinBudget(messaging.done,");
    const hostDisposeAt = stopSource.indexOf("await state.host?.dispose()");

    expect(abortAt).toBeGreaterThanOrEqual(0);
    expect(boundAt).toBeGreaterThanOrEqual(0);
    expect(hostDisposeAt).toBeGreaterThanOrEqual(0);
    expect(abortAt).toBeLessThan(hostDisposeAt);
    expect(boundAt).toBeLessThan(hostDisposeAt);
  });
});
