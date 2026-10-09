/**
 * Saved-prompt shelf: the scope contract.
 *
 * The shelf lets a user name the prompt text they are editing and reuse it
 * later — in this conversation or a new one. It stores prompt *source text*
 * only. Applying a saved prompt copies its text into ONE conversation's editor
 * draft; the persona a model receives is still exactly that conversation's own
 * `sessions.system_prompt` (ADR 0310).
 *
 * The regression this file exists to catch is the shelf quietly becoming a
 * second persona scope: an app-wide default, an auto-apply to new
 * conversations, or a write straight into a session row. Those are exactly the
 * behaviours the single-scope model deleted, so they are asserted absent here
 * as firmly as the shelf itself is asserted present.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const [
  dialogSource,
  protocolSource,
  sessionsTypeSource,
  apiSource,
  mainSource,
  hostMainSource,
  presetSource,
  rpcSource,
] = await Promise.all([
  read("../src/components/SessionPromptDialog.tsx"),
  read("../../../packages/shared/src/protocol.ts"),
  read("../../../packages/shared/src/types/sessions.ts"),
  read("../src/lib/api.ts"),
  read("../electron/main/ipc/session-ipc.ts"),
  read("../../../crates/host-core/src/main.rs"),
  read("../../../crates/host-core/src/prompt_presets.rs"),
  read("../../../crates/host-core/src/rpc/mod.rs"),
]);

test("the dialog carries a saved-prompt shelf that fills the editor draft", () => {
  assert.match(dialogSource, /className="session-prompt-shelf"/);
  assert.match(dialogSource, /t\("chat\.promptPresetShelfTitle"\)/);
  assert.match(dialogSource, /t\("chat\.promptPresetEmpty"\)/);
  assert.match(dialogSource, /t\("chat\.promptPresetSaveAsButton"\)/);
  assert.match(dialogSource, /t\("chat\.promptPresetApplyButton"\)/);
  assert.match(dialogSource, /t\("chat\.promptPresetDeleteButton"\)/);
  assert.match(dialogSource, /t\("chat\.promptPresetNamePlaceholder"\)/);
  // Applying a row fills the draft; it does not write the session.
  assert.match(dialogSource, /const applyPreset = \(preset: PromptPreset\) => \{/);
  assert.match(dialogSource, /setDraft\(preset\.text\)/);
  // A non-empty, different draft is not discarded silently: the overwrite is
  // confirmed inline, never with a native window.confirm.
  assert.match(dialogSource, /setPendingApply\(preset\)/);
  assert.match(dialogSource, /t\("chat\.promptPresetReplaceConfirm"/);
  assert.match(dialogSource, /t\("chat\.promptPresetDeleteConfirm"/);
  assert.match(dialogSource, /t\("chat\.promptPresetDuplicateName", \{ name: clash\.name \}\)/);
  assert.match(dialogSource, /t\("chat\.promptPresetTooLong", \{ limit: PROMPT_PRESET_MAX_CHARS \}\)/);
  assert.doesNotMatch(dialogSource, /window\.confirm/);
});

test("the shelf reaches the host through three named channels", () => {
  assert.match(protocolSource, /promptPresetList:\s*"pi-desktop\/promptPreset\/list"/);
  assert.match(protocolSource, /promptPresetSave:\s*"pi-desktop\/promptPreset\/save"/);
  assert.match(protocolSource, /promptPresetDelete:\s*"pi-desktop\/promptPreset\/delete"/);
  // The IPC allow-list is derived from the channel object, so a new channel is
  // whitelisted by declaring it — nothing else must be listed by hand.
  assert.match(protocolSource, /IPC_WHITELIST = new Set<string>\(\[\s*\.\.\.Object\.values\(IPC\.invoke\),/);

  assert.match(apiSource, /listPromptPresets: \(\) =>/);
  assert.match(apiSource, /savePromptPreset: \(name: string, text: string\) =>/);
  assert.match(apiSource, /deletePromptPreset: \(id: string\) =>/);
  assert.match(apiSource, /IPC\.invoke\.promptPresetList/);
  assert.match(apiSource, /IPC\.invoke\.promptPresetSave/);
  assert.match(apiSource, /IPC\.invoke\.promptPresetDelete/);

  assert.match(mainSource, /IPC\.invoke\.promptPresetList/);
  assert.match(mainSource, /host\.call\("promptPreset\.list"\)/);
  assert.match(mainSource, /host\.call\("promptPreset\.save", \{ name, text \}\)/);
  assert.match(mainSource, /host\.call\("promptPreset\.delete", \{ id \}\)/);

  assert.match(sessionsTypeSource, /export type PromptPreset = \{/);
});

test("the host stores the shelf in the existing kv store, not a new table", () => {
  assert.match(hostMainSource, /mod prompt_presets;/);
  assert.match(presetSource, /pub const PROMPT_PRESETS_NS: &str = "prompt_presets";/);
  assert.match(presetSource, /pub const PROMPT_PRESETS_KEY: &str = "items";/);
  assert.match(presetSource, /db\.kv_get\(PROMPT_PRESETS_NS, PROMPT_PRESETS_KEY\)/);
  assert.match(presetSource, /db\.kv_set\(PROMPT_PRESETS_NS, PROMPT_PRESETS_KEY, &value\)/);
  assert.match(presetSource, /pub fn list\(db: &Database\) -> Result<Vec<PromptPreset>>/);
  assert.match(presetSource, /pub fn save\(db: &Database, name: &str, text: &str\) -> Result<PromptPreset>/);
  assert.match(presetSource, /pub fn delete\(db: &Database, id: &str\) -> Result<bool>/);
  assert.match(rpcSource, /"promptPreset\.list" => \{/);
  assert.match(rpcSource, /"promptPreset\.save" => \{/);
  assert.match(rpcSource, /"promptPreset\.delete" => \{/);
});

test("the shelf is not a second persona scope and never auto-applies", () => {
  // No app-wide or default persona field anywhere on the shelf path.
  for (const source of [dialogSource, apiSource, presetSource, rpcSource, protocolSource]) {
    assert.doesNotMatch(source, /globalSystemPrompt/);
    assert.doesNotMatch(source, /app-wide|appWideDefault|defaultSystemPrompt/i);
  }
  // The shelf's storage layer is source text only: it never writes a session
  // row, so an applied preset only becomes a persona once the user saves the
  // editor as that conversation's own prompt.
  assert.doesNotMatch(
    presetSource,
    /UPDATE sessions|INSERT INTO sessions|DELETE FROM sessions/,
  );
  // Applying a preset stays local to the draft and does not call the session
  // save path itself.
  const applyBlock = dialogSource.slice(
    dialogSource.indexOf("const applyPreset ="),
    dialogSource.indexOf("const confirmApply ="),
  );
  assert.doesNotMatch(applyBlock, /onSave|setSessionSystemPrompt|commit\(/);
});
