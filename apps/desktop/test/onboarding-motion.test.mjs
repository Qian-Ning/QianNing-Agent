/**
 * First-run checklist celebration (design-system §8, D652).
 *
 * The animation itself is CSS, pinned by motion-contract.test.mjs. What is
 * decided in code is *when* it plays, and that decision is the whole point of
 * the change: a tick may only follow a step that just completed, never the
 * steps that were already done when the checklist appeared.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  ONBOARDING_RING_MS,
  doneIds,
  stepsJustCompleted,
} from "../src/components/onboarding-motion.ts";

const step = (id, done) => ({ id, done });

test("doneIds keeps only the steps the host reports as done", () => {
  assert.deepEqual(
    [...doneIds([step("provider", true), step("secret", false), step("project", true)])],
    ["provider", "project"],
  );
  assert.deepEqual([...doneIds([])], []);
});

test("the first render of a mount completes nothing", () => {
  // Already-done steps are not news: animating them would replay the whole
  // celebration every time the user walks back to the empty home.
  assert.deepEqual(
    stepsJustCompleted(null, [step("provider", true), step("secret", true)]),
    [],
  );
});

test("only the step that flipped is reported", () => {
  const previous = new Set(["provider"]);
  assert.deepEqual(
    stepsJustCompleted(previous, [step("provider", true), step("secret", true)]),
    ["secret"],
  );
});

test("a render that changes nothing reports nothing", () => {
  const previous = new Set(["provider", "secret"]);
  assert.deepEqual(
    stepsJustCompleted(previous, [step("provider", true), step("secret", true)]),
    [],
  );
});

test("several steps completing at once are all reported, in host order", () => {
  assert.deepEqual(
    stepsJustCompleted(new Set(), [
      step("provider", true),
      step("secret", true),
      step("project", false),
    ]),
    ["provider", "secret"],
  );
});

test("a step that regresses does not resurrect an earlier tick", () => {
  const previous = new Set(["provider", "secret"]);
  // `secret` went back to not-done; nothing new completed in this render.
  assert.deepEqual(
    stepsJustCompleted(previous, [step("provider", true), step("secret", false)]),
    [],
  );
});

test("the celebration outlasts the longest tick animation", () => {
  // The component clears `is-celebrating` on this timer, so the ring must be
  // the animation that finishes first — otherwise it is cut mid-flight.
  const css = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../src/styles/chat-shell.css"),
    "utf8",
  );
  const ring = css.match(
    /\.onboarding-check\.is-celebrating::after\s*\{[^}]*animation:\s*onboarding-ring-out\s+(\d+)ms/,
  );
  assert.ok(ring, "chat-shell.css must run onboarding-ring-out");
  assert.ok(
    Number(ring[1]) <= ONBOARDING_RING_MS,
    `the ring (${ring[1]}ms) must not outlast ONBOARDING_RING_MS (${ONBOARDING_RING_MS})`,
  );
});

test("the checklist wires the celebration and the exit to its own events", () => {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../src/components/OnboardingChecklist.tsx"),
    "utf8",
  );
  assert.match(source, /stepsJustCompleted\(/, "the tick must follow the change, not the mount");
  assert.match(source, /is-celebrating/, "the celebrating step must carry the animation hook");
  // The exit unmounts on `animationend` of its own animation only: the tick
  // animations bubble through the same handler.
  assert.match(source, /event\.target !== event\.currentTarget/);
  assert.match(source, /event\.animationName\.startsWith\("onboarding-checklist-out"\)/);
});
