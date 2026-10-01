import assert from "node:assert/strict";
import test from "node:test";

import {
  COMPOSER_PROMPT_CARDS_MAX,
  COMPOSER_PROMPT_CARDS_STORAGE_KEY,
  loadPromptCards,
  promptCardLabel,
  removePromptCard,
  savePromptCard,
} from "../src/lib/composer-prompt-cards.ts";

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

test("a saved prompt leads the list and round-trips its text", () => {
  const next = savePromptCard("Review this diff for security issues");
  assert.equal(next.length, 1);
  assert.equal(next[0].text, "Review this diff for security issues");
  assert.equal(next[0].label, "Review this diff for security issues");
  assert.ok(next[0].id);
  assert.deepEqual(loadPromptCards(), next);
});

test("the label is the first non-empty line, collapsed and clipped", () => {
  assert.equal(promptCardLabel("  \n  Summarize the file \n more"), "Summarize the file");
  const long = "x".repeat(80);
  const label = promptCardLabel(long);
  assert.equal(label.length, 40);
  assert.ok(label.endsWith("\u2026"));
});

test("blank text is never stored", () => {
  assert.deepEqual(savePromptCard("   \n  "), []);
  assert.deepEqual(loadPromptCards(), []);
});

test("saving the same text again moves it to the front without duplicating", () => {
  savePromptCard("alpha");
  savePromptCard("beta");
  const next = savePromptCard("alpha");
  assert.deepEqual(
    next.map((card) => card.text),
    ["alpha", "beta"],
  );
});

test("the list is bounded to the newest COMPOSER_PROMPT_CARDS_MAX entries", () => {
  for (let i = 0; i < COMPOSER_PROMPT_CARDS_MAX + 5; i += 1) {
    savePromptCard(`prompt ${i}`);
  }
  const cards = loadPromptCards();
  assert.equal(cards.length, COMPOSER_PROMPT_CARDS_MAX);
  // Newest first: the last saved prompt leads.
  assert.equal(cards[0].text, `prompt ${COMPOSER_PROMPT_CARDS_MAX + 4}`);
});

test("removing a card drops only that id", () => {
  savePromptCard("keep me");
  const [doomed] = savePromptCard("remove me");
  const next = removePromptCard(doomed.id);
  assert.deepEqual(
    next.map((card) => card.text),
    ["keep me"],
  );
});

test("a corrupt payload reads back as empty, not a throw", () => {
  globalThis.localStorage.setItem(COMPOSER_PROMPT_CARDS_STORAGE_KEY, "{not json");
  assert.deepEqual(loadPromptCards(), []);
});

test("entries missing required fields are skipped on read", () => {
  globalThis.localStorage.setItem(
    COMPOSER_PROMPT_CARDS_STORAGE_KEY,
    JSON.stringify([
      { id: "ok", text: "valid", label: "valid" },
      { id: "bad", label: "no text" },
      { text: "", label: "blank", id: "blank" },
    ]),
  );
  const cards = loadPromptCards();
  assert.equal(cards.length, 1);
  assert.equal(cards[0].text, "valid");
});
