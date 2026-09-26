import { readComposerSource, readMainSource } from "./helpers/source-contracts.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { access } from "node:fs/promises";
import test from "node:test";
import {
  PROMPT_ENHANCEMENT_TIMEOUT_MS,
  withPromptEnhancementTimeout,
} from "../electron/main/prompt-enhancement-timeout.ts";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

const [composer, api, main, protocol, runtime, oneShot] = await Promise.all([
  readComposerSource(),
  read("../src/lib/api.ts"),
  readMainSource(),
  read("../../../packages/shared/src/protocol.ts"),
  read("../../../packages/agent-runtime/src/prompt-enhancement.ts"),
  read("../../../packages/agent-runtime/src/one-shot-complete.ts"),
]);

// The prompt-enhancement host/runtime path is intentionally retained (D629):
// QianNing Agent removed only the user-facing entry points — the composer ✦
// button and the Settings ▸ AI card — while the typed bridge, one-shot runtime,
// and abort/timeout guard stay in place so the surface can be restored without
// touching the backend again.
test("the prompt-enhancement host bridge and runtime are retained", () => {
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

test("the composer no longer renders the ✦ enhancement entry point", () => {
  // The button, its loading state, undo affordance, and error surface are gone.
  assert.doesNotMatch(composer, /composer-enhance-btn/);
  assert.doesNotMatch(composer, /composer-enhancement-error/);
  assert.doesNotMatch(composer, /enhancingPrompt/);
  assert.doesNotMatch(composer, /invalidatePromptEnhancement/);
  assert.doesNotMatch(composer, /setEnhancementUndoText/);
  assert.doesNotMatch(composer, /IconUndo2/);
  // IconSparkles is no longer the enhance action: upstream (v0.15.8) reuses it
  // as a decorative reasoning-capability badge in the model list (role="img",
  // aria-hidden), so assert there is no clickable enhance affordance instead of
  // banning the icon outright.
  assert.doesNotMatch(composer, /onEnhance|handleEnhance|enhancePrompt\(/);
});

test("the Settings ▸ AI prompt-enhancement card is removed", async () => {
  const settingsPage = await read("../src/features/settings/SettingsPage.tsx");
  assert.doesNotMatch(settingsPage, /PromptEnhancementCard/);
  assert.doesNotMatch(settingsPage, /prompt-enhancement-card/);
  // The card files themselves are deleted.
  for (const path of [
    "../src/features/settings/prompt-enhancement-card.tsx",
    "../src/components/settings/EnhancementModelCard.tsx",
  ]) {
    await assert.rejects(
      access(new URL(path, import.meta.url)),
      `${path} should be deleted`,
    );
  }
  // Its search-index keys are dropped so Settings search cannot surface a
  // control that no longer exists.
  const search = await read("../src/lib/settings-search.ts");
  assert.doesNotMatch(search, /promptEnhancementTitle/);
  assert.doesNotMatch(search, /promptEnhancementModelTitle/);
  assert.doesNotMatch(search, /promptEnhancementThinking/);
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
