/**
 * The media workbench draft's persistence, as pure logic.
 *
 * The renderer has no DOM test harness, so everything decision-bearing — the
 * serialization, the validation on read, and the debounce scheduling — lives in
 * `lib/workbench-draft.ts` and is exercised here without a page. The same
 * module is what `WorkbenchPage` wires to `localStorage`.
 */
import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const {
  WORKBENCH_DRAFT_KEY,
  createDebouncedWriter,
  emptyWorkbenchDraft,
  loadWorkbenchDrafts,
  sanitizeWorkbenchDraft,
  saveWorkbenchDrafts,
} = await import("../src/lib/workbench-draft.ts");

/** A minimal in-memory localStorage so the module's storage() resolves. */
class MemoryStorage {
  #map = new Map();
  getItem(key) {
    return this.#map.has(key) ? this.#map.get(key) : null;
  }
  setItem(key, value) {
    this.#map.set(key, String(value));
  }
  removeItem(key) {
    this.#map.delete(key);
  }
  clear() {
    this.#map.clear();
  }
}

test.beforeEach(() => {
  globalThis.localStorage = new MemoryStorage();
});

test.after(() => {
  delete globalThis.localStorage;
});

const sample = {
  image: {
    prompt: "a paper lantern at dusk",
    model: { providerId: "p1", modelId: "img-a" },
    countDraft: "3",
    ratio: "3:2",
    resolution: "1536",
    customValue: "",
    duration: 8,
    frameFieldFirst: "",
    frameFieldLast: "",
  },
  video: {
    prompt: "a slow pan across a harbour",
    model: null,
    countDraft: "2",
    ratio: "16:9",
    resolution: "__custom__",
    customValue: "1280x720",
    duration: 6,
    frameFieldFirst: "start_image",
    frameFieldLast: "end_image",
  },
};

test("a saved draft reads back unchanged", () => {
  saveWorkbenchDrafts(sample);
  assert.deepEqual(loadWorkbenchDrafts(), sample);
});

test("image and video drafts never bleed into each other", () => {
  saveWorkbenchDrafts(sample);
  const drafts = loadWorkbenchDrafts();
  assert.equal(drafts.image.prompt, "a paper lantern at dusk");
  assert.equal(drafts.video.prompt, "a slow pan across a harbour");
  assert.equal(drafts.image.ratio, "3:2");
  assert.equal(drafts.video.ratio, "16:9");
  assert.deepEqual(drafts.image.model, { providerId: "p1", modelId: "img-a" });
  assert.equal(drafts.video.model, null);
});

test("a missing store reads back as the two defaults, not a throw", () => {
  assert.deepEqual(loadWorkbenchDrafts(), {
    image: emptyWorkbenchDraft("image"),
    video: emptyWorkbenchDraft("video"),
  });
});

test("a corrupt payload reads back as defaults, not a throw", () => {
  globalThis.localStorage.setItem(WORKBENCH_DRAFT_KEY, "{not json");
  assert.deepEqual(loadWorkbenchDrafts(), {
    image: emptyWorkbenchDraft("image"),
    video: emptyWorkbenchDraft("video"),
  });
  globalThis.localStorage.setItem(WORKBENCH_DRAFT_KEY, "42");
  assert.deepEqual(loadWorkbenchDrafts().image, emptyWorkbenchDraft("image"));
});

test("a half-written record degrades per field instead of reaching a control", () => {
  const image = sanitizeWorkbenchDraft(
    {
      prompt: 42,
      model: { providerId: "p", modelId: "" },
      countDraft: 5,
      ratio: "99:1",
      resolution: "999",
      customValue: null,
      duration: 999,
      frameFieldFirst: "input_reference",
    },
    "image",
  );
  assert.equal(image.prompt, "");
  assert.equal(image.model, null, "a model without both halves is dropped");
  assert.equal(image.countDraft, "1");
  assert.equal(image.ratio, "", "a ratio the capability does not offer is dropped");
  assert.equal(image.resolution, "", "a tier the capability does not offer is dropped");
  assert.equal(image.customValue, "");
  assert.equal(image.duration, 8, "an out-of-table duration settles to the default");
  assert.equal(image.frameFieldFirst, "input_reference", "a plain string field survives");
});

test("resolution and ratio are validated against the capability, not globally", () => {
  const video = sanitizeWorkbenchDraft({ ratio: "3:2", resolution: "__custom__" }, "video");
  assert.equal(video.ratio, "", "3:2 renders images, not video");
  assert.equal(video.resolution, "__custom__");
  const image = sanitizeWorkbenchDraft({ resolution: "2160" }, "image");
  assert.equal(image.resolution, "", "2160 is a video tier, not an image long side");
  assert.equal(sanitizeWorkbenchDraft(null, "video").resolution, "");
});

/** A fake clock so the debounce schedule is tested without real time. */
function fakeClock() {
  let next = 0;
  const timers = new Map();
  return {
    setTimer(handler, timeout) {
      const id = next++;
      timers.set(id, { handler, timeout });
      return id;
    },
    clearTimer(handle) {
      timers.delete(handle);
    },
    /** Fire every still-scheduled timer, as the event loop eventually would. */
    run() {
      const pending = [...timers.values()];
      timers.clear();
      for (const timer of pending) timer.handler();
    },
    size() {
      return timers.size;
    },
  };
}

test("a burst of edits coalesces into one debounced write", () => {
  const clock = fakeClock();
  const writes = [];
  const writer = createDebouncedWriter((value) => writes.push(value), 400, clock.setTimer, clock.clearTimer);
  writer.schedule("a");
  writer.schedule("b");
  writer.schedule("c");
  assert.equal(writes.length, 0, "nothing is written during the quiet period");
  assert.equal(clock.size(), 1, "only the latest value stays scheduled");
  assert.equal(writer.pending, true);
  clock.run();
  assert.deepEqual(writes, ["c"], "the last value is the one that lands");
  assert.equal(writer.pending, false);
});

test("flush writes the pending value now; cancel drops it", () => {
  const clock = fakeClock();
  const writes = [];
  const writer = createDebouncedWriter((value) => writes.push(value), 400, clock.setTimer, clock.clearTimer);
  writer.schedule("x");
  writer.flush();
  assert.deepEqual(writes, ["x"], "flush does not wait for the timer");
  assert.equal(writer.pending, false);
  writer.flush();
  assert.deepEqual(writes, ["x"], "flushing with nothing pending writes nothing");

  writer.schedule("y");
  writer.cancel();
  clock.run();
  assert.deepEqual(writes, ["x"], "a cancelled write never lands");
  assert.equal(writer.pending, false);
});
