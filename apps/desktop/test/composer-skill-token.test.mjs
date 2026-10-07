import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadStyles } from "./helpers/styles.mjs";

/*
 * D673: a skill summoned with `/name` must not look like something the writer
 * typed by hand. The draft paints the token, the transcript labels the sent
 * turn, and both carry the same badge — this file pins the contract between the
 * three sources plus the stylesheet, because none of it is reachable from a
 * DOM-less unit test.
 */

const editorSource = await readFile(
  new URL("../src/features/chat/composer/editor.ts", import.meta.url),
  "utf8",
);
const draftSource = await readFile(
  new URL(
    "../src/features/chat/composer/hooks/useComposerDraft.ts",
    import.meta.url,
  ),
  "utf8",
);
const catalogSource = await readFile(
  new URL("../src/hooks/use-composer-skill-catalog.ts", import.meta.url),
  "utf8",
);
const messageRowSource = await readFile(
  new URL("../src/features/chat/transcript/MessageRow.tsx", import.meta.url),
  "utf8",
);
const styles = await loadStyles();

function ruleBlock(source, selector) {
  const start = source.indexOf(`${selector} {`);
  assert.notEqual(start, -1, `missing ${selector} rule`);
  const close = source.indexOf("}", start);
  return source.slice(start, close + 1);
}

test("the draft paints a summoned skill as its own token", () => {
  assert.match(editorSource, /token\.className = "composer-skill-token"/);
  // The element's text is exactly the text it replaced, so the draft string
  // send-time parsing sees is unchanged by the styling.
  assert.match(editorSource, /token\.textContent = `\/\$\{entry\.name\}`/);
  // Badge and title ride on data attributes: generated content cannot end up in
  // the draft value or in the model's prompt.
  assert.match(editorSource, /token\.dataset\.badge = badge/);
  assert.match(editorSource, /token\.dataset\.skillTitle = entry\.title/);
  assert.match(editorSource, /token\.dataset\.skillId = entry\.id/);
  assert.match(editorSource, /token\.dataset\.command = entry\.name/);
});

test("a painted skill ends at the boundary the trigger detector uses", () => {
  // Longest match wins, so `/qn-novel-write` is not cut short by `/qn-novel`.
  assert.match(
    editorSource,
    /if \(!name \|\| name\.length <= \(match\?\.length \?\? 0\)\) continue;/,
  );
  // A trailing character that is not whitespace means this is a longer word the
  // send-time resolver would not treat as a skill either.
  assert.match(
    editorSource,
    /if \(next !== undefined && !\/\\s\/\.test\(next\)\) continue;/,
  );
  // The shared rule decides which slashes are commands (D673), evaluated once
  // per draft: no space is needed before a summon, an address keeps its slashes,
  // and the painter cannot drift from the send-time resolver.
  assert.match(editorSource, /const commandSlashes = commandSlashIndices\(chars, value\);/);
  assert.match(editorSource, /if \(!commandSlashes\.has\(slashIndex\)\) return null;/);
  assert.match(editorSource, /isComposerCommandSlash\(value, offset\)/);
});

test("the skill badge is the localized one, never a literal", () => {
  const paint = draftSource.slice(
    draftSource.indexOf("paintEditorValue("),
    draftSource.indexOf("paintEditorValue(") + 500,
  );
  assert.match(paint, /skillCatalogRef\.current\.byName/);
  assert.match(paint, /t\("chat\.slashGroupSkills"\)/);
  // No user-visible copy is hardcoded in the composer or the catalog.
  assert.doesNotMatch(editorSource, /[\u4e00-\u9fff]/);
  assert.doesNotMatch(catalogSource, /[\u4e00-\u9fff]/);
});

test("the transcript labels a sent skill turn with badge, title and name", () => {
  assert.match(messageRowSource, /className="chat-skill-chip"/);
  assert.match(messageRowSource, /className="chat-skill-badge"/);
  assert.match(messageRowSource, /className="chat-skill-title"/);
  assert.match(messageRowSource, /className="chat-skill-name"/);
  assert.match(messageRowSource, /t\("chat\.slashGroupSkills"\)/);
  // The title comes from the catalog by skill id, so the transcript shows the
  // same name the slash menu showed.
  assert.match(messageRowSource, /byId\.get\(mention\.id\)/);
  // The `/name` shown is the exact slice the turn carried.
  assert.match(
    messageRowSource,
    /const name = command\.slice\(mention\.start, mention\.end\)/,
  );
});

test("token and chip styling rides on design tokens, not literal colors", () => {
  const token = ruleBlock(styles, ".composer-skill-token");
  assert.match(token, /color-mix\(in oklab, var\(--ds-accent\)/);
  assert.match(token, /font-family: var\(--font-mono/);
  assert.doesNotMatch(token, /#[0-9a-fA-F]{3,8}\b|rgba?\(/);

  const badge = ruleBlock(styles, ".composer-skill-token::before");
  assert.match(badge, /content: attr\(data-badge\)/);
  assert.match(badge, /background: var\(--ds-accent\)/);
  assert.doesNotMatch(badge, /#[0-9a-fA-F]{3,8}\b|rgba?\(/);

  const title = ruleBlock(styles, ".composer-skill-token::after");
  assert.match(title, /content: attr\(data-skill-title\)/);
  assert.match(title, /text-overflow: ellipsis/);

  for (const selector of [".chat-skill-chip", ".chat-skill-badge", ".chat-skill-name"]) {
    const block = ruleBlock(styles, selector);
    assert.doesNotMatch(block, /#[0-9a-fA-F]{3,8}\b|rgba?\(/);
  }
});
