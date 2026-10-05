import assert from "node:assert/strict";
import test from "node:test";
import {
  derivePetMood,
  PET_DONE_MS,
  PET_SLEEP_MS,
  PET_MOOD_ANIM,
  THINKING_PHASES,
} from "../src/lib/pet-mood.ts";

const base = {
  isRunning: false,
  hasPendingPermission: false,
  activityPhase: undefined,
  hasError: false,
  recentOutcome: undefined,
  outcomeAt: undefined,
  idleSince: undefined,
  now: 1_000_000,
};

test("a pending permission outranks everything, even a running turn", () => {
  assert.equal(
    derivePetMood({ ...base, hasPendingPermission: true, isRunning: true }),
    "permission",
  );
});

test("a running turn with a model-wait phase reads as thinking", () => {
  for (const phase of THINKING_PHASES) {
    assert.equal(
      derivePetMood({ ...base, isRunning: true, activityPhase: phase }),
      "thinking",
      phase,
    );
  }
});

test("a running turn doing visible work (no thinking phase) reads as working", () => {
  assert.equal(derivePetMood({ ...base, isRunning: true }), "working");
  assert.equal(
    derivePetMood({ ...base, isRunning: true, activityPhase: "waiting-subagents" }),
    "working",
  );
});

test("a shown error reads as error only while nothing is running", () => {
  assert.equal(derivePetMood({ ...base, hasError: true }), "error");
  // A new run supersedes the stale error face.
  assert.equal(derivePetMood({ ...base, hasError: true, isRunning: true }), "working");
});

test("a just-finished turn celebrates, then falls back to idle", () => {
  const now = 5_000_000;
  assert.equal(
    derivePetMood({ ...base, now, recentOutcome: "completed", outcomeAt: now - 100 }),
    "done",
  );
  assert.equal(
    derivePetMood({
      ...base,
      now,
      recentOutcome: "completed",
      outcomeAt: now - PET_DONE_MS - 1,
    }),
    "idle",
  );
});

test("a failed outcome does not celebrate", () => {
  const now = 5_000_000;
  assert.equal(
    derivePetMood({ ...base, now, recentOutcome: "failed", outcomeAt: now - 100 }),
    "idle",
  );
});

test("long idle with no activity falls asleep", () => {
  const now = 9_000_000;
  assert.equal(
    derivePetMood({ ...base, now, idleSince: now - PET_SLEEP_MS - 1 }),
    "sleep",
  );
  assert.equal(
    derivePetMood({ ...base, now, idleSince: now - PET_SLEEP_MS + 1000 }),
    "idle",
  );
});

test("every mood maps to a known animation clip", () => {
  const clips = new Set([
    "idle",
    "thinking",
    "working",
    "success",
    "error",
    "sleep",
    "searching",
  ]);
  for (const [mood, clip] of Object.entries(PET_MOOD_ANIM)) {
    assert.ok(clips.has(clip), `${mood} → ${clip}`);
  }
});
