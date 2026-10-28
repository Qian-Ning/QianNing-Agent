import { describe, expect, it, vi, beforeEach } from "vitest";

const start = vi.fn(async () => {});
const stop = vi.fn(async () => {});
let native = false;

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => native },
  registerPlugin: () => ({ start, stop, isRunning: async () => ({ running: false }) }),
}));

const keepalive = await import("./keepalive");

describe("keepalive", () => {
  beforeEach(() => {
    keepalive.resetKeepAliveForTests();
    start.mockClear();
    stop.mockClear();
    native = true;
  });

  it("starts once for overlapping turns and stops only at zero", async () => {
    await keepalive.acquireKeepAlive("working");
    await keepalive.acquireKeepAlive("working");
    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith({ text: "working" });

    await keepalive.releaseKeepAlive();
    expect(stop).not.toHaveBeenCalled();

    await keepalive.releaseKeepAlive();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("ignores an extra release instead of going negative", async () => {
    await keepalive.releaseKeepAlive();
    await keepalive.releaseKeepAlive();
    expect(stop).not.toHaveBeenCalled();
    expect(keepalive.keepAliveDepth()).toBe(0);
  });

  it("survives a refused start so the turn still runs", async () => {
    start.mockRejectedValueOnce(new Error("refused"));
    await expect(keepalive.acquireKeepAlive()).resolves.toBeUndefined();
    await keepalive.releaseKeepAlive();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("does nothing on the web build", async () => {
    native = false;
    await keepalive.acquireKeepAlive();
    await keepalive.releaseKeepAlive();
    expect(start).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
  });
});
