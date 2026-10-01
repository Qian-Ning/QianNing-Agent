import assert from "node:assert/strict";
import test from "node:test";

import {
  COMPOSER_PROMPT_CARDS_EXPORT_FILENAME,
  COMPOSER_PROMPT_CARDS_EXPORT_KIND,
  COMPOSER_PROMPT_CARDS_MAX,
  COMPOSER_PROMPT_CARDS_STORAGE_KEY,
  exportPromptCards,
  importPromptCards,
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

test("export wraps the cards in a recognizable, id-free payload", () => {
  savePromptCard("alpha prompt");
  savePromptCard("beta prompt");
  const json = exportPromptCards(loadPromptCards());
  const parsed = JSON.parse(json);
  assert.equal(parsed.kind, COMPOSER_PROMPT_CARDS_EXPORT_KIND);
  assert.equal(parsed.version, 1);
  assert.deepEqual(
    parsed.cards.map((card) => card.text),
    ["beta prompt", "alpha prompt"],
  );
  // Ids are local keys and must not travel in a shared file.
  assert.ok(parsed.cards.every((card) => !("id" in card)));
  // The filename constant is a stable, shareable default.
  assert.match(COMPOSER_PROMPT_CARDS_EXPORT_FILENAME, /\.json$/);
});

test("import merges new cards, keeps existing ahead, and regenerates ids", () => {
  const [kept] = savePromptCard("existing");
  const json = exportPromptCards([
    { id: "foreign-1", text: "existing", label: "existing" },
    { id: "foreign-2", text: "fresh one", label: "fresh one" },
  ]);
  const result = importPromptCards(json);
  assert.equal(result.ok, true);
  assert.equal(result.added, 1);
  // The duplicate of an existing card is skipped.
  assert.equal(result.skipped, 1);
  assert.deepEqual(
    result.cards.map((card) => card.text),
    ["existing", "fresh one"],
  );
  // The kept card retains its original local id; the import did not collide.
  assert.equal(result.cards[0].id, kept.id);
  assert.notEqual(result.cards[1].id, "foreign-2");
  assert.deepEqual(loadPromptCards(), result.cards);
});

test("import accepts a bare array as well as the wrapped export", () => {
  const result = importPromptCards(JSON.stringify([{ text: "bare entry" }]));
  assert.equal(result.ok, true);
  assert.equal(result.added, 1);
  assert.equal(result.cards[0].text, "bare entry");
  assert.equal(result.cards[0].label, "bare entry");
});

test("import is bounded to the cap and counts the overflow as skipped", () => {
  const incoming = Array.from({ length: COMPOSER_PROMPT_CARDS_MAX + 3 }, (_, i) => ({
    text: `imported ${i}`,
  }));
  const result = importPromptCards(JSON.stringify(incoming));
  assert.equal(result.ok, true);
  assert.equal(result.cards.length, COMPOSER_PROMPT_CARDS_MAX);
  assert.equal(result.added, COMPOSER_PROMPT_CARDS_MAX);
  assert.equal(result.skipped, 3);
});

test("unparseable or wrong-shape import leaves storage untouched", () => {
  savePromptCard("safe");
  const before = loadPromptCards();
  const bad = importPromptCards("{not json");
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.cards, before);
  const wrong = importPromptCards(JSON.stringify({ nope: true }));
  assert.equal(wrong.ok, false);
  assert.deepEqual(loadPromptCards(), before);
});
