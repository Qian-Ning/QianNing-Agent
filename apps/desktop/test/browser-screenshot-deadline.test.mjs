import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import {
  BROWSER_SCREENSHOT_TIMEOUT_MS,
  withScreenshotDeadline,
} from "../electron/main/browser-screenshot-deadline.ts";

const hostSource = readFileSync(
  resolve("electron/main/browser-host.ts"),
  "utf8",
);

test("a capture that settles keeps its own result and cancels the deadline", async () => {
  let detached = 0;
  const result = await withScreenshotDeadline(
    async () => ({ data: "ok" }),
    () => { detached += 1; },
    50,
  );

  assert.deepEqual(result, { data: "ok" });
  assert.equal(detached, 0, "a settled capture must not detach the session");
});

test("a capture that never settles fails with TIMEOUT and detaches the session", async () => {
  let detached = 0;
  const pending = withScreenshotDeadline(
    () => new Promise(() => {}),
    () => { detached += 1; },
    20,
  );

  await assert.rejects(
    pending,
    (error) => {
      assert.equal(error.code, "TIMEOUT");
      assert.match(error.message, /browser screenshot timed out after 20ms/);
      return true;
    },
  );
  assert.equal(detached, 1, "the timeout must detach the stuck CDP session");
});

test("a failing detach still surfaces the timeout", async () => {
  await assert.rejects(
    withScreenshotDeadline(
      () => new Promise(() => {}),
      () => { throw new Error("guest already gone"); },
      20,
    ),
    (error) => error.code === "TIMEOUT",
  );
});

test("the default deadline is the shipped 30s bound", () => {
  assert.equal(BROWSER_SCREENSHOT_TIMEOUT_MS, 30_000);
});

test("the screenshot path runs through the deadline and detaches on timeout", () => {
  const lines = hostSource.split("\n");
  const deadline = lines.findIndex((line) => line.includes("withScreenshotDeadline("));

  assert.notEqual(deadline, -1, "screenshot must not call the CDP capture bare");
  assert.match(
    hostSource,
    /withScreenshotDeadline\(\s*\n\s*\(\) => page\.cdp\.screenshot\(this\.requireWebContents\(\), input\),/,
    "the capture must be the CDP screenshot call",
  );
  assert.match(
    hostSource,
    /\(\) => page\.cdp\.detach\(page\.pane\.getWebContents\(\) \?\? undefined\),/,
    "the timeout must detach this tree's CDP session",
  );
  assert.doesNotMatch(
    hostSource,
    /await page\.cdp\.screenshot\(this\.requireWebContents\(\), input\);/,
    "no capture site may bypass the deadline",
  );
});
