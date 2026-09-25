import { readComposerSource, readMainSource } from "./helpers/source-contracts.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  PROMPT_ENHANCEMENT_TIMEOUT_MS,
  withPromptEnhancementTimeout,
} from "../electron/main/prompt-enhancement-timeout.ts";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

const [composer, api, main, protocol, runtime, oneShot, en, zh] = await Promise.all([
  readComposerSource(),
  read("../src/lib/api.ts"),
  readMainSource(),
  read("../../../packages/shared/src/protocol.ts"),
  read("../../../packages/agent-runtime/src/prompt-enhancement.ts"),
  read("../../../packages/agent-runtime/src/one-shot-complete.ts"),
  read("../../../packages/i18n/src/locales/en/index.ts"),
  read("../../../packages/i18n/src/locales/zh-CN/index.ts"),
]);

test("prompt enhancement uses the typed main-process bridge", () => {
  assert.match(protocol, /promptEnhance: "pi-desktop\/prompt\/enhance"/);
  assert.match(api, /enhancePrompt: \(req: PromptEnhancementRequest\)/);
  assert.match(api, /IPC\.invoke\.promptEnhance/);
  assert.match(main, /handle\(IPC\.invoke\.promptEnhance/);
  assert.match(main, /enhancePromptDraft\(/);
  assert.match(main, /withPromptEnhancementTimeout/);
  assert.match(main, /enhancementThinkingLevel \|\| "off"/);
  assert.match(main, /from "\.\.\/prompt-enhancement-timeout"/);
  assert.match(main, /withPromptEnhancementTimeout\(\(signal\) =>/);
  assert.match(main, /signal,/);
  assert.match(main, /sessionId: launchSessionId/);
  assert.match(main, /resolveAuth: \(\) => vendorOAuth\.resolveAuth/);
  assert.match(runtime, /completeOneShot\(/);
  assert.match(oneShot, /createProviderRetryStream/);
  assert.match(oneShot, /models\.streamSimple/);
  assert.match(oneShot, /withOpenCodeSessionHeaders/);
});

test("Composer enables enhancement with inline file references and guards stale results", () => {
  assert.match(composer, /const \[enhancingPrompt, setEnhancingPrompt\]/);
  assert.match(composer, /textToEnhance\.trim\(\)\.startsWith\("\/"\)/);
  assert.match(composer, /stripInlineComposerFileReferenceTokens/);
  assert.match(composer, /restoreInlineComposerFileReferenceTokens/);
  assert.match(composer, /!modelReady/);
  assert.match(
    composer,
    /className=\{`icon-btn icon-btn-square composer-enhance-btn/,
  );
  assert.match(composer, /aria-busy=\{enhancingPrompt\}/);
  assert.match(composer, /className="tool-spinner"/);
  assert.match(composer, /IconUndo2/);
  assert.match(composer, /setEnhancementUndoText\(sourceText\)/);
  assert.match(composer, /enhancementVersionRef\.current !== sourceVersion/);
  assert.match(composer, /currentKey !== sourceKey/);
  assert.match(composer, /invalidatePromptEnhancement\(\);/);
  assert.match(composer, /className="composer-enhancement-error"/);
  assert.match(composer, /enhancementError\.code/);
  assert.match(composer, /setEnhancementError\(null\)/);
  assert.doesNotMatch(composer, /activeInlineFileReferences\.length > 0/);
});

test("prompt enhancement has complete English-first locale coverage", () => {
  for (const source of [en, zh]) {
    assert.match(source, /enhancePrompt:/);
    assert.match(source, /enhancingPrompt:/);
    assert.match(source, /undoEnhancement:/);
    assert.match(source, /enhancementFailed:/);
    assert.match(source, /enhancementTimeout:/);
    assert.match(source, /dismissEnhancementError:/);
  }
});

test("the prompt-enhancement card is model-and-reasoning only", async () => {
  const card = await read("../src/features/settings/prompt-enhancement-card.tsx");
  const settingsPage = await read("../src/features/settings/SettingsPage.tsx");
  const shared = await read("../../../packages/shared/src/prompt-enhancement.ts");
  const hostCore = await read("../../../crates/host-core/src/rpc/mod.rs");

  // The card is reachable from the AI settings tab and no longer carries an
  // editor: the rewrite instructions are the product's, so there is nothing for
  // a user to override and nothing that can compete with the persona scopes.
  assert.match(settingsPage, /PromptEnhancementCard/);
  assert.match(card, /EnhancementModelCard/);
  assert.doesNotMatch(card, /promptEnhancementUserTemplate/);
  assert.doesNotMatch(card, /promptEnhancementSystemPrompt/);
  assert.doesNotMatch(card, /promptEnhancementCustomTemplate/);
  assert.doesNotMatch(card, /ext-sheet-overlay/);
  assert.doesNotMatch(card, /Textarea/);

  // The defaults still live in shared so the runtime and its tests agree on the
  // exact text, and the placeholder is substituted literally.
  assert.match(shared, /export const PROMPT_ENHANCEMENT_DRAFT_VARIABLE/);
  assert.match(shared, /renderPromptEnhancementUserPrompt/);
  assert.doesNotMatch(shared, /resolvePromptEnhancementTemplates/);
  assert.doesNotMatch(shared, /\.replace\(PROMPT_ENHANCEMENT_DRAFT_VARIABLE, draft\)/);

  // host-core stores no enhancement template at all: the two removed settings
  // keys are not accepted, and the only bounded persona is the per-conversation
  // prompt.
  assert.doesNotMatch(hostCore, /prompt_enhancement_template_error/);
  assert.doesNotMatch(hostCore, /MAX_PROMPT_ENHANCEMENT_TEMPLATE_CHARS/);
  // The app-wide persona scope is gone, so its bound is gone with it.
  assert.doesNotMatch(hostCore, /MAX_GLOBAL_SYSTEM_PROMPT_CHARS/);
  assert.doesNotMatch(hostCore, /globalSystemPrompt/);

  // The one-shot keeps its boundary: no history, no tools.
  assert.match(runtime, /promptEnhancementContext/);
  assert.match(oneShot, /createProviderRetryStream/);
});

test("the removed template copy no longer ships in the reference locales", () => {
  for (const source of [en, zh]) {
    assert.match(source, /promptEnhancementTitle:/);
    // The deleted editors' copy must not linger: an unused key is a promise the
    // UI no longer keeps.
    for (const key of [
      "promptEnhancementEdit",
      "promptEnhancementUserTemplate",
      "promptEnhancementInsertDraft",
      "promptEnhancementCustomTemplate",
      "promptEnhancementCustomTemplateDesc",
      "promptEnhancementCustomTemplateNeedsTemplate",
      "promptEnhancementSystemPrompt",
      "promptEnhancementTooLong",
      "promptEnhancementSaveError",
    ]) {
      assert.doesNotMatch(source, new RegExp(`${key}:`));
    }
  }
});

test("an enhancement request is released when the provider never answers", async () => {
  const started = Date.now();
  // A promise that never settles is exactly the hang the transport cannot bound
  // on its own: the abort signal is only consulted between provider retries.
  const never = new Promise(() => {});
  let seenSignal;
  await assert.rejects(
    withPromptEnhancementTimeout((signal) => {
      seenSignal = signal;
      return never;
    }, 40),
    (error) => {
      assert.equal(error.errorCode, "TIMEOUT");
      assert.match(error.message, /timed out after/);
      return true;
    },
  );
  assert.equal(seenSignal?.aborted, true, "timeout must abort the in-flight request");
  assert.ok(Date.now() - started < 2000, "the caller must be released promptly");
});

test("a completed enhancement is not turned into a timeout", async () => {
  assert.equal(
    await withPromptEnhancementTimeout(() => Promise.resolve("ok"), 5000),
    "ok",
  );
  await assert.rejects(
    withPromptEnhancementTimeout(() => Promise.reject(new Error("provider 500")), 5000),
    /provider 500/,
  );
});

test("the default ceiling is about a minute", () => {
  assert.equal(PROMPT_ENHANCEMENT_TIMEOUT_MS, 60_000);
});

test("the enhancement model and reasoning are rows on the Prompt enhancement card", async () => {
  const settingsPage = await read("../src/features/settings/SettingsPage.tsx");
  const promptCard = await read("../src/features/settings/prompt-enhancement-card.tsx");
  const modelPage = await read("../src/components/settings/ModelConfigPage.tsx");
  const search = await read("../src/lib/settings-search.ts");
  const card = await read("../src/components/settings/EnhancementModelCard.tsx");

  const aiStart = settingsPage.indexOf('{tab === "ai" && settings && (');
  const shortcutsStart = settingsPage.indexOf('{tab === "shortcuts" && settings && (');
  const aiSource = settingsPage.slice(aiStart, shortcutsStart);
  assert.match(aiSource, /PromptEnhancementCard/);
  assert.doesNotMatch(aiSource, /EnhancementModelCard/);
  assert.match(promptCard, /EnhancementModelCard/);
  assert.doesNotMatch(modelPage, /EnhancementModelCard/);
  assert.doesNotMatch(modelPage, /promptEnhancementProviderId/);

  const aiSearch = search.slice(search.indexOf('id: "ai"'), search.indexOf('id: "shortcuts"'));
  const agentSearch = search.slice(search.indexOf('id: "agent"'), search.indexOf('id: "skills"'));
  assert.match(aiSearch, /promptEnhancementTitle/);
  assert.match(aiSearch, /promptEnhancementModelTitle/);
  assert.match(aiSearch, /promptEnhancementThinking/);
  assert.doesNotMatch(agentSearch, /promptEnhancementModelTitle/);
  assert.doesNotMatch(agentSearch, /promptEnhancementThinking/);

  assert.doesNotMatch(card, /promptEnhancementModelTitle/);
  assert.doesNotMatch(card, /SettingsCard/);
  assert.match(card, /t\("settings\.promptEnhancementModel"\)/);

  // Same control as the default-model row: one anchored menu, one search field.
  assert.match(card, /AnchoredMenu/);
  assert.match(card, /model-default-anchor/);
  assert.match(card, /promptEnhancementProviderId/);
  assert.match(card, /promptEnhancementModelId/);
  assert.match(card, /promptEnhancementModelFollow/);
  assert.match(card, /promptEnhancementModelUnavailable/);
  assert.match(card, /pickModel/);

  assert.match(card, /SettingsRow/);
});

test("the reasoning row follows the selected model's real ladder", async () => {
  const card = await read("../src/components/settings/EnhancementModelCard.tsx");

  // Reuse the Composer's model-aware resolution instead of the canonical list.
  assert.match(card, /thinkingProviderForModel/);
  assert.match(card, /thinkingLevelForProvider/);
  assert.match(card, /reasoningProvider/);
  assert.match(card, /levelOptions/);
  // A pinned model without reasoning still lists `off` and disables the row.
  assert.match(card, /noReasoning/);
  assert.match(card, /disabled=\{noReasoning\}/);
  // Switching model re-clamps the stored level onto the new model.
  const pickModel = card.slice(card.indexOf("const pickModel"), card.indexOf("return ("));
  assert.match(pickModel, /thinkingLevelForProvider\(nextProvider, stored\)/);
  // No follow-the-session option in this row.
  assert.doesNotMatch(card, /promptEnhancementThinkingFollow/);
});

test("the enhancement-model copy exists in both reference locales", () => {
  for (const source of [en, zh]) {
    for (const key of [
      "promptEnhancementModelTitle",
      "promptEnhancementModel",
      "promptEnhancementModelFollow",
      "promptEnhancementModelUnavailable",
      "promptEnhancementThinking",
      "promptEnhancementThinkingDesc",
      "promptEnhancementThinkingOff",
    ]) {
      assert.match(source, new RegExp(`${key}:`));
    }
  }
});
