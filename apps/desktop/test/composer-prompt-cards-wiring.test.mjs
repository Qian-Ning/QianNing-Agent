import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadStyles } from "./helpers/styles.mjs";

/**
 * Quick-prompt strip wiring (QianNing feature, D638).
 *
 * The persistence contract is covered by composer-prompt-cards.test.mjs; this
 * file proves the strip is actually mounted in the composer stack, inserts into
 * the live draft, and carries the styles and i18n the component asks for — the
 * seam a store/DOM refactor would otherwise break silently.
 */
const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

const [composerSource, stripSource, hookSource, styles] = await Promise.all([
  read("../src/components/Composer.tsx"),
  read("../src/features/chat/composer/ComposerPromptCards.tsx"),
  read("../src/features/chat/composer/hooks/useComposerPromptCards.ts"),
  loadStyles(),
]);

test("the composer mounts the quick-prompt strip above the input", () => {
  assert.match(composerSource, /import \{ ComposerPromptCards \}/);
  assert.match(composerSource, /useComposerPromptCards\(\)/);
  assert.match(composerSource, /<ComposerPromptCards/);
  // The strip renders before the shell so it sits above the editor, after the
  // image attachments row.
  const stripAt = composerSource.indexOf("<ComposerPromptCards");
  const shellAt = composerSource.indexOf('className={`composer-shell');
  assert.ok(stripAt > 0 && shellAt > 0 && stripAt < shellAt);
});

test("inserting a card edits the live draft, not the store", () => {
  // Insert appends on its own line when a draft exists, else starts it.
  assert.match(composerSource, /const insertPromptCard = \(text: string\) => \{/);
  assert.match(composerSource, /applyEditorDraft\(next, fileReferencesRef\.current, next\.length\)/);
  // Saving reads the live draft and reports the outcome through a toast.
  assert.match(composerSource, /promptCards\.save\(readLiveDraft\(\)\)/);
  assert.match(composerSource, /chat\.promptCardSaved/);
  assert.match(composerSource, /chat\.promptCardSaveEmpty/);
});

test("the strip is a mutually exclusive insert/save surface", () => {
  // Empty draft lists saved cards; a substantial draft offers to save it.
  assert.match(stripSource, /if \(trimmed\.length === 0\)/);
  assert.match(stripSource, /if \(cards\.length === 0\) return null;/);
  assert.match(stripSource, /if \(trimmed\.length < MIN_SAVE_LENGTH\) return null;/);
  assert.match(stripSource, /t\("chat\.promptCardInsert", \{ label: card\.label \}\)/);
  assert.match(stripSource, /t\("chat\.promptCardSave"\)/);
});

test("the hook owns the persisted card list", () => {
  assert.match(hookSource, /loadPromptCards/);
  assert.match(hookSource, /savePromptCard/);
  assert.match(hookSource, /removePromptCard/);
});

test("the quick-prompt strip ships its own styles", () => {
  assert.match(styles, /\.composer-prompt-cards\s*\{/);
  assert.match(styles, /\.composer-prompt-card-insert\s*\{/);
  assert.match(styles, /\.composer-prompt-card-save\s*\{/);
});
