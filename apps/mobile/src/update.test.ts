import { describe, expect, it } from "vitest";

import { cachedUpdate, isNewer, prefetchUpdate } from "./update";

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

/**
 * The prefetch is an optimisation; the install path owns the failure stories.
 * So a bridge that is missing, or one that throws, must look like "nothing was
 * fetched" rather than escaping into the settings row.
 */
describe("prefetchUpdate", () => {
  it("reports zero bytes when the build cannot download ahead", async () => {
    (globalThis as { window?: unknown }).window = {};
    await expect(prefetchUpdate("https://example.test/app.apk")).resolves.toEqual({ bytes: 0 });
  });

  it("swallows a failed fetch", async () => {
    (globalThis as { window?: unknown }).window = {
      Capacitor: {
        Plugins: {
          AppUpdate: {
            download: () => Promise.reject(new Error("download-failed:timeout")),
          },
        },
      },
    };
    await expect(prefetchUpdate("https://example.test/app.apk")).resolves.toEqual({ bytes: 0 });
  });

  it("reports the bytes when it worked", async () => {
    (globalThis as { window?: unknown }).window = {
      Capacitor: { Plugins: { AppUpdate: { download: () => Promise.resolve({ bytes: 22_000_000 }) } } },
    };
    await expect(prefetchUpdate("https://example.test/app.apk")).resolves.toEqual({ bytes: 22_000_000 });
  });
});

describe("cachedUpdate", () => {
  it("is false without a bridge", async () => {
    (globalThis as { window?: unknown }).window = {};
    await expect(cachedUpdate()).resolves.toBe(false);
  });

  it("believes the native side's ready flag", async () => {
    (globalThis as { window?: unknown }).window = {
      Capacitor: { Plugins: { AppUpdate: { cached: () => Promise.resolve({ ready: true }) } } },
    };
    await expect(cachedUpdate()).resolves.toBe(true);
  });
});
