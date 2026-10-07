import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadStyles } from "./helpers/styles.mjs";

/*
 * D673 + D675: a command summoned with `/name` must not look like something the
 * writer typed by hand, whatever kind of command it is — app, plugin, extension,
 * skill or template. The draft paints the token, the transcript labels the sent
 * turn, the "/" menu badges the row, and all three read the same kind labels
 * from i18n. This file pins that contract across the four sources plus the
 * stylesheet, because none of it is reachable from a DOM-less unit test.
 */

const editorSource = await readFile(
  new URL("../src/features/chat/composer/editor.ts", import.meta.url),
  "utf8",
);
const draftSource = await readFile(
  new URL("../src/features/chat/composer/hooks/useComposerDraft.ts", import.meta.url),
  "utf8",
);
const catalogSource = await readFile(
  new URL("../src/hooks/use-composer-command-catalog.ts", import.meta.url),
  "utf8",
);
const labelsSource = await readFile(
  new URL("../src/features/chat/composer/command-labels.ts", import.meta.url),
  "utf8",
);
const messageRowSource = await readFile(
  new URL("../src/features/chat/transcript/MessageRow.tsx", import.meta.url),
  "utf8",
);
const menuSource = await readFile(
  new URL("../src/components/ComposerAutocomplete.tsx", import.meta.url),
  "utf8",
);
const englishCatalog = await readFile(
  new URL("../../../packages/i18n/src/locales/en/index.ts", import.meta.url),
  "utf8",
);
const styles = await loadStyles();

function ruleBlock(source, selector) {
  const start = source.indexOf(`${selector} {`);
  assert.notEqual(start, -1, `missing ${selector} rule`);
  const close = source.indexOf("}", start);
  return source.slice(start, close + 1);
}

test("the draft paints a summoned command as its own token", () => {
  assert.match(editorSource, /token\.className = "composer-command-token"/);
  // The element's text is exactly the text it replaced, so the draft string
  // send-time parsing sees is unchanged by the styling.
  assert.match(editorSource, /token\.textContent = `\/\$\{entry\.name\}`/);
  // Badge, title and kind ride on data attributes: generated content cannot end
  // up in the draft value or in the model's prompt.
  assert.match(editorSource, /token\.dataset\.badge = badge/);
  // A title that only repeats the command name is dropped, so a skill token is
  // not labelled "skill /qianning/imagegen imagegen".
  assert.match(
    editorSource,
    /if \(entry\.title && !commandTitleRepeatsName\(entry\.name, entry\.title\)\) \{/,
  );
  assert.match(editorSource, /token\.dataset\.commandTitle = entry\.title;/);
  assert.match(editorSource, /token\.dataset\.commandId = entry\.id/);
  assert.match(editorSource, /token\.dataset\.kind = entry\.kind/);
  assert.match(editorSource, /token\.dataset\.command = entry\.name/);
});

test("a painted command ends at the boundary the trigger detector uses", () => {
  // Longest match wins, so `/qn-novel-write` is not cut short by `/qn-novel`.
  assert.match(
    editorSource,
    /if \(!name \|\| name\.length <= \(match\?\.length \?\? 0\)\) continue;/,
  );
  // A trailing character that is not whitespace means this is a longer word the
  // send-time resolver would not treat as a command either.
  assert.match(editorSource, /if \(next !== undefined && !\/\\s\/\.test\(next\)\) continue;/);
  // The shared rule decides which slashes are commands (D673), evaluated once
  // per draft: no space is needed before a summon, an address keeps its slashes,
  // and the painter cannot drift from the send-time resolver.
  assert.match(editorSource, /const commandSlashes = commandSlashIndices\(chars, value\);/);
  assert.match(editorSource, /if \(!commandSlashes\.has\(slashIndex\)\) return null;/);
  assert.match(editorSource, /isComposerCommandSlash\(value, offset\)/);
});

test("every kind badge is the localized one, never a literal", () => {
  // One table decides the badge for all five kinds, so the draft token, the
  // transcript chip and the menu row cannot label the same command differently.
  for (const key of [
    "chat.kindApp",
    "chat.kindPlugin",
    "chat.kindExtension",
    "chat.kindSkill",
    "chat.kindTemplate",
  ]) {
    assert.ok(labelsSource.includes(`"${key}"`), `missing badge key ${key}`);
  }
  assert.match(labelsSource, /export function commandKindBadgeKey/);
  assert.match(labelsSource, /export function commandKindGroupKey/);
  assert.match(labelsSource, /export function builtinCommandTitleKey/);
  assert.match(labelsSource, /export function commandTitleRepeatsName/);
  // The badge reaches the painter as a lookup function, not a fixed string, so
  // the same paint pass labels a plugin command and an app command correctly.
  assert.match(draftSource, /commandCatalogRef\.current\.byName/);
  assert.match(draftSource, /t\(commandKindBadgeKey\(/);
  // No user-visible copy is hardcoded in the composer, the catalog or the menu.
  assert.doesNotMatch(editorSource, /[\u4e00-\u9fff]/);
  assert.doesNotMatch(catalogSource, /[\u4e00-\u9fff]/);
  assert.doesNotMatch(menuSource, /[\u4e00-\u9fff]/);
});

test("i18n carries a badge, a title and a group label for every kind", () => {
  for (const key of [
    "kindApp",
    "kindPlugin",
    "kindExtension",
    "kindSkill",
    "kindTemplate",
    "slashGroupTemplates",
    "slashGroupApp",
    "slashGroupPlugins",
    "slashGroupExtensions",
    "slashGroupSkills",
  ]) {
    assert.match(englishCatalog, new RegExp(`\\b${key}:`), `missing en chat.${key}`);
  }
  for (const key of ["new", "compact", "agentMode", "planMode", "goalMode", "category"]) {
    assert.match(englishCatalog, new RegExp(`\\b${key}:`), `missing en chat.builtin.${key}`);
  }
});

test("the transcript labels a sent command by kind, badge, title and name", () => {
  assert.match(
    messageRowSource,
    /className="chat-command-chip"[\s\S]{0,80}?data-kind=\{entry\.kind\}/,
  );
  assert.match(messageRowSource, /className="chat-command-badge"/);
  assert.match(messageRowSource, /className="chat-command-title"/);
  assert.match(messageRowSource, /className="chat-command-name"/);
  assert.match(messageRowSource, /t\(commandKindBadgeKey\(entry\.kind\)\)/);
  // The title comes from the catalog by skill id, so the transcript shows the
  // same name the slash menu showed.
  assert.match(messageRowSource, /byId\.get\(mention\.id\)/);
  // A whole-invocation command is labelled from the catalog by slash name, and
  // an expanded template body keeps the plain, wrapping chip.
  assert.match(messageRowSource, /byName\.get\(message\.command\.replace/);
  // The `/name` shown is the exact slice the turn carried.
  assert.match(messageRowSource, /const name = command\.slice\(mention\.start, mention\.end\)/);
});

test("the menu badges every command row with its kind", () => {
  assert.match(menuSource, /composer-ac-kind composer-ac-kind-\$\{command\.kind\}/);
  assert.match(menuSource, /t\(commandKindBadgeKey\(command\.kind\)\)/);
  // Built-in rows read in the interface language rather than the host's English
  // strings, and the category label is localized too.
  assert.match(menuSource, /builtinCommandTitleKey\(command\.id\)/);
  assert.match(menuSource, /builtinCommandCategoryKey\(command\.id\)/);
  assert.match(menuSource, /t\(commandKindGroupKey\(group\)\)/);
});

test("token and chip styling rides on design tokens, not literal colors", () => {
  const token = ruleBlock(styles, ".composer-command-token");
  assert.match(token, /color-mix\(in oklab, var\(--token-accent\)/);
  assert.match(token, /font-family: var\(--font-mono/);
  assert.doesNotMatch(token, /#[0-9a-fA-F]{3,8}\b|rgba?\(/);

  const badge = ruleBlock(styles, ".composer-command-token::before");
  assert.match(badge, /content: attr\(data-badge\)/);
  assert.match(badge, /background: var\(--token-accent\)/);
  assert.doesNotMatch(badge, /#[0-9a-fA-F]{3,8}\b|rgba?\(/);

  const title = ruleBlock(styles, ".composer-command-token::after");
  assert.match(title, /content: attr\(data-command-title\)/);
  assert.match(title, /text-overflow: ellipsis/);

  // Each kind tints its own accent, and both the draft and the transcript use
  // the same five kinds.
  for (const kind of ["builtin", "plugin", "extension", "template"]) {
    assert.match(
      styles,
      new RegExp(`\\.composer-command-token\\[data-kind="${kind}"\\]`),
      `draft token has no ${kind} accent`,
    );
    assert.match(
      styles,
      new RegExp(`\\.chat-command-chip\\[data-kind="${kind}"\\]`),
      `transcript chip has no ${kind} accent`,
    );
  }

  for (const selector of [
    ".chat-command-chip[data-kind]",
    ".chat-command-badge",
    ".chat-command-name",
    ".composer-ac-kind",
  ]) {
    const block = ruleBlock(styles, selector);
    assert.doesNotMatch(block, /#[0-9a-fA-F]{3,8}\b|rgba?\(/);
  }
});

test("the built-in skills carry our own namespace, and old ids still resolve", async () => {
  const host = await readFile(
    new URL("../electron/main/builtin-skills.ts", import.meta.url),
    "utf8",
  );
  assert.match(host, /export const IMAGE_GENERATION_SKILL_ID = "qianning\/imagegen"/);
  assert.match(host, /export const PLUGIN_DEV_SKILL_ID = "qianning\/plugin-development"/);
  assert.match(host, /"pi-desktop\/imagegen": IMAGE_GENERATION_SKILL_ID/);
  assert.match(host, /"pi-desktop\/plugin-development": PLUGIN_DEV_SKILL_ID/);
  assert.match(host, /export function canonicalBuiltinSkillId/);
  // The catalog the model and the menu see advertises only the current ids.
  assert.doesNotMatch(host, /id: "pi-desktop\//);
});
