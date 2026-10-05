import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// Same loader the other source-importing tests use: the modules under test import
// each other extensionless, which the bundler resolves and plain Node does not.
const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const { elapsedBetween, formatElapsed } = await import("../src/lib/subagent-elapsed.ts");
const { runningDelegations } = await import("../src/lib/subagent-running.ts");

/**
 * A delegation card is only useful if it says two things the transcript cannot
 * show at a glance: how long the call has been running, and whether anything is
 * still running at all. Both answers are derived from the `Task` row itself —
 * no second live registry — so these tests pin the derivation, not a copy of it.
 */

const message = (overrides) => ({
  id: overrides.id ?? "m1",
  role: "tool",
  content: "",
  createdAt: "2026-10-05T02:00:00.000Z",
  ...overrides,
});

test("formatElapsed stays inside one chip", () => {
  assert.equal(formatElapsed(0), "0s");
  assert.equal(formatElapsed(4_000), "4s");
  assert.equal(formatElapsed(59_400), "59s");
  assert.equal(formatElapsed(60_000), "1m 00s");
  assert.equal(formatElapsed(67_000), "1m 07s");
  assert.equal(formatElapsed(3_600_000), "1h 00m");
  assert.equal(formatElapsed(7_380_000), "2h 03m");
  // Nonsense in, nothing out: a negative or NaN duration must not render.
  assert.equal(formatElapsed(-1), "");
  assert.equal(formatElapsed(Number.NaN), "");
});

test("elapsedBetween distinguishes unknown from zero", () => {
  const start = "2026-10-05T02:00:00.000Z";
  const now = Date.parse(start) + 5_000;

  // Unknown must not read as "just started".
  assert.equal(elapsedBetween(undefined, undefined, now), undefined);
  assert.equal(elapsedBetween("not a date", undefined, now), undefined);
  assert.equal(elapsedBetween(start, undefined, now), 5_000);
  assert.equal(elapsedBetween(start, "2026-10-05T02:00:02.000Z", now), 2_000);
  // A clock that ran backwards clamps instead of reporting negative time.
  assert.equal(elapsedBetween(start, "2026-10-05T01:59:00.000Z", now), 0);
});

test("runningDelegations counts only what is actually in flight", () => {
  const runs = runningDelegations([
    message({ id: "parent", role: "assistant", content: "working" }),
    message({
      id: "done",
      toolCallId: "done",
      toolName: "Task",
      toolStatus: "complete",
      createdAt: "2026-10-05T02:00:00.000Z",
    }),
    message({
      id: "wait",
      toolCallId: "wait",
      toolName: "TaskWait",
      toolStatus: "running",
      createdAt: "2026-10-05T02:00:10.000Z",
    }),
    message({
      id: "other",
      toolCallId: "other",
      toolName: "Read",
      toolStatus: "running",
      createdAt: "2026-10-05T02:00:15.000Z",
    }),
    message({
      id: "newer",
      toolCallId: "newer",
      toolName: "Task",
      toolStatus: "running",
      agentName: "researcher",
      createdAt: "2026-10-05T02:00:30.000Z",
    }),
    message({
      id: "older",
      toolCallId: "older",
      toolName: "Task",
      toolStatus: "running",
      createdAt: "2026-10-05T02:00:20.000Z",
    }),
    message({
      id: "anonymous",
      toolName: "Task",
      toolStatus: "running",
      createdAt: "2026-10-05T02:00:40.000Z",
    }),
  ]);

  // Oldest first: the strip times the longest run, so ordering is the contract.
  assert.deepEqual(
    runs.map((run) => run.toolCallId),
    ["older", "newer"],
  );
  assert.equal(runs[1].agentName, "researcher");
  // A settled transcript shows nothing at all.
  assert.deepEqual(runningDelegations([]), []);
});

test("the strip and the card are wired to the same call id", async () => {
  const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
  const [composer, toolRow, strip, css] = await Promise.all([
    read("src/components/Composer.tsx"),
    read("src/features/chat/transcript/ToolRow.tsx"),
    read("src/features/chat/composer/SubagentRunStrip.tsx"),
    read("src/styles/messages.css"),
  ]);

  // The bar has to sit above the input, with the other status lines.
  assert.match(composer, /<SubagentRunStrip \/>/);
  // The card owns a clock, and the run head is what a click can find.
  assert.match(toolRow, /useElapsedLabel\(/);
  assert.match(toolRow, /className="tool-row-elapsed"/);
  assert.match(toolRow, /"data-delegation-call": message\.toolCallId/);
  // One attribute, read back by the one place that scrolls to it.
  assert.match(strip, /\[data-delegation-call="\$\{CSS\.escape\(toolCallId\)\}"\]/);
  assert.match(strip, /runningDelegations\(messages\)/);
  // Styling exists for both, and comes from tokens like the chips beside it.
  assert.match(css, /\.tool-row-elapsed \{/);
  assert.match(css, /\.subagent-strip \{/);
});
