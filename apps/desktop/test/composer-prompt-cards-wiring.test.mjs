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

test("export downloads a blob and import reads the picked file", () => {
  // Export serializes through the lib and saves via a blob + object URL anchor.
  assert.match(composerSource, /serializePromptCards\(promptCards\.cards\)/);
  assert.match(composerSource, /URL\.createObjectURL\(blob\)/);
  assert.match(composerSource, /anchor\.download = COMPOSER_PROMPT_CARDS_EXPORT_FILENAME/);
  assert.match(composerSource, /URL\.revokeObjectURL\(url\)/);
  // Import reads the file as text and merges through the hook.
  assert.match(composerSource, /promptCards\.importText\(String\(reader\.result/);
  assert.match(composerSource, /reader\.readAsText\(file\)/);
  assert.match(composerSource, /chat\.promptCardsImported/);
  assert.match(composerSource, /chat\.promptCardsImportFailed/);
});

test("the strip is a mutually exclusive insert/save surface with a library tray", () => {
  // Empty draft lists saved cards; a substantial draft offers to save it.
  assert.match(stripSource, /if \(trimmed\.length === 0\)/);
  assert.match(stripSource, /if \(trimmed\.length < MIN_SAVE_LENGTH\) return null;/);
  assert.match(stripSource, /t\("chat\.promptCardInsert", \{ label: card\.label \}\)/);
  assert.match(stripSource, /t\("chat\.promptCardSave"\)/);
  // Export/import controls carry their own i18n and a hidden file input.
  assert.match(stripSource, /t\("chat\.promptCardsExport"\)/);
  assert.match(stripSource, /t\("chat\.promptCardsImport"\)/);
  assert.match(stripSource, /type="file"/);
  assert.match(stripSource, /onImportFile\(file\)/);
  // An empty library still shows the import affordance, not nothing.
  assert.match(stripSource, /if \(cards\.length === 0\) \{/);
});

test("the hook owns the persisted card list", () => {
  assert.match(hookSource, /loadPromptCards/);
  assert.match(hookSource, /savePromptCard/);
  assert.match(hookSource, /removePromptCard/);
  assert.match(hookSource, /importPromptCards/);
});

test("the quick-prompt strip ships its own styles", () => {
  assert.match(styles, /\.composer-prompt-cards\s*\{/);
  assert.match(styles, /\.composer-prompt-card-insert\s*\{/);
  assert.match(styles, /\.composer-prompt-card-save\s*\{/);
  assert.match(styles, /\.composer-prompt-card-tool\s*\{/);
  assert.match(styles, /\.composer-prompt-card-import-input\s*\{/);
});
