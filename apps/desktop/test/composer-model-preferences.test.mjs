import assert from "node:assert/strict";
import test from "node:test";

import {
  COMPOSER_MODEL_RECENTS_MAX,
  composerModelKey,
  loadFavoriteModelKeys,
  loadRecentModelKeys,
  parseComposerModelKey,
  rememberRecentModelKey,
  toggleFavoriteModelKey,
} from "../src/lib/composer-model-preferences.ts";

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

test("a composite key round-trips through parse", () => {
  const key = composerModelKey("amd", "deepseek/v4-flash");
  assert.deepEqual(parseComposerModelKey(key), {
    providerId: "amd",
    modelId: "deepseek/v4-flash",
  });
});

test("parse rejects malformed keys", () => {
  assert.equal(parseComposerModelKey("no-separator"), null);
  assert.equal(parseComposerModelKey("\u0000model"), null);
  assert.equal(parseComposerModelKey("provider\u0000"), null);
});

test("toggling a favorite adds then removes it, preserving order", () => {
  toggleFavoriteModelKey("kira", "a");
  toggleFavoriteModelKey("amd", "b");
  assert.deepEqual(loadFavoriteModelKeys(), [
    composerModelKey("kira", "a"),
    composerModelKey("amd", "b"),
  ]);
  toggleFavoriteModelKey("kira", "a");
  assert.deepEqual(loadFavoriteModelKeys(), [composerModelKey("amd", "b")]);
});

test("recents are newest-first, deduped, and bounded", () => {
  for (let i = 0; i < COMPOSER_MODEL_RECENTS_MAX + 3; i += 1) {
    rememberRecentModelKey("p", `m${i}`);
  }
  const recents = loadRecentModelKeys();
  assert.equal(recents.length, COMPOSER_MODEL_RECENTS_MAX);
  // Newest first: the last remembered model leads.
  assert.equal(recents[0], composerModelKey("p", `m${COMPOSER_MODEL_RECENTS_MAX + 2}`));
});

test("re-using a recent model moves it to the front without duplicating", () => {
  rememberRecentModelKey("p", "a");
  rememberRecentModelKey("p", "b");
  rememberRecentModelKey("p", "a");
  assert.deepEqual(loadRecentModelKeys(), [
    composerModelKey("p", "a"),
    composerModelKey("p", "b"),
  ]);
});

test("a corrupt payload reads back as empty, not a throw", () => {
  globalThis.localStorage.setItem("pi.desktop.composerModelFavorites", "{not json");
  assert.deepEqual(loadFavoriteModelKeys(), []);
});
