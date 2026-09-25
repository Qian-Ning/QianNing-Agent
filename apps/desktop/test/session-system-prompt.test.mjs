/**
 * Per-conversation system prompt: the scope contract.
 *
 * Exactly two scopes reach the model's persona, ordered and separable:
 *
 *   conversation (sessions.system_prompt)  >  global (settings)  >
 *   built-in default
 *
 * The file-based persona layer (`.pi/SYSTEM.md`) and the AGENTS.md instruction
 * chain were removed: two editable scopes are the whole model, so there is
 * nothing left to keep in step with a file on disk.
 *
 * A blank/whitespace value at either scope means "no override", never
 * "empty persona" — the regression this file exists to catch is a cleared
 * field silently leaving the agent with no product persona at all.
 *
 * The dialog and topbar wiring is asserted from source because the renderer
 * surface is what the user actually meets; the storage half is covered by the
 * host integration test and the Rust unit tests named at the bottom.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { readStoreSource } from "./helpers/source-contracts.mjs";

const storeSource = await readStoreSource();

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const [
  dialogSource,
  topbarSource,
  settingsSource,
  apiSource,
  mainSource,
  launchSource,
  protocolSource,
  sessionTypesSource,
  appSettingsSource,
  hostSource,
  rpcSource,
  migrationSource,
  migrationTestsSource,
  schemaSource,
] = await Promise.all([
  read("../src/components/SessionPromptDialog.tsx"),
  read("../src/components/ConversationTopbar.tsx"),
  read("../src/features/settings/agent-sections.tsx"),
  read("../src/lib/api.ts"),
  read("../electron/main/ipc/session-ipc.ts"),
  read("../electron/main/runtime/session-launch.ts"),
  read("../../../packages/shared/src/protocol.ts"),
  read("../../../packages/shared/src/types/sessions.ts"),
  read("../../../packages/shared/src/types/settings.ts"),
  read("../../../crates/host-core/src/sessions.rs"),
  read("../../../crates/host-core/src/rpc/mod.rs"),
  read("../../../crates/host-core/src/db/migrations.rs"),
  read("../../../crates/host-core/src/db/tests.rs"),
  read("../../../crates/host-core/src/db/schema.rs"),
]);

test("a conversation carries its own prompt through the session contract", () => {
  assert.match(sessionTypesSource, /systemPrompt\?: string;/);
  assert.match(protocolSource, /sessionSetSystemPrompt:\s*"pi-desktop\/session\/setSystemPrompt"/);
  assert.match(apiSource, /setSessionSystemPrompt: \(id: string, systemPrompt: string \| null\)/);
  assert.match(apiSource, /IPC\.invoke\.sessionSetSystemPrompt/);
  assert.match(mainSource, /IPC\.invoke\.sessionSetSystemPrompt/);
  assert.match(mainSource, /host\.call<\{ session\?: RuntimeSession \| null \}>\([\s\S]{0,40}"session\.setSystemPrompt"/);
  // Native Pi sessions belong to their origin app: never write their prompt.
  assert.match(mainSource, /rejectNativeMutation\(id, "system prompt"\)/);
});

test("the host persists the conversation prompt and clears it on blank", () => {
  assert.match(schemaSource, /system_prompt TEXT,/);
  assert.match(hostSource, /pub fn set_session_system_prompt/);
  assert.match(hostSource, /pub fn normalize_session_system_prompt/);
  assert.match(hostSource, /UPDATE sessions SET system_prompt = \?2, updated_at = \?3 WHERE id = \?1/);
  // Blank means "no override", so the built-in persona returns.
  assert.match(hostSource, /let Some\(text\) = value\.map\(str::trim\)\.filter\(\|text\| !text\.is_empty\(\)\) else \{\s*return Ok\(None\);/);
  assert.match(rpcSource, /"session\.setSystemPrompt" => \{/);
  assert.match(rpcSource, /Value::Null => None,/);
});

test("the schema change is a migration, not a rebuild assumption", () => {
  assert.match(migrationSource, /pub\(crate\) fn migrate_v19_to_v20_tx/);
  assert.match(migrationSource, /ALTER TABLE sessions ADD COLUMN system_prompt TEXT;/);
  assert.match(migrationSource, /pragma_table_info\('sessions'\) WHERE name = 'system_prompt'/);
  assert.match(migrationSource, /pub\(crate\) fn migrate_v19_to_v20\(conn: &Connection, path: &Path\)/);
});

test("launch orders the prompt scopes conversation > global > built-in", () => {
  assert.match(launchSource, /const sessionSystemPrompt =\s*typeof session\.systemPrompt === "string" \? session\.systemPrompt\.trim\(\) : "";/);
  assert.match(launchSource, /const globalSystemPrompt =\s*typeof settings\.globalSystemPrompt === "string"/);
  assert.match(launchSource, /const systemPrompt = sessionSystemPrompt \|\| globalSystemPrompt \|\| undefined;/);
  // The file layer is gone, so no launch path may read SYSTEM.md again.
  assert.doesNotMatch(launchSource, /loadCustomSystemPrompt|SYSTEM\.md/);
  assert.match(appSettingsSource, /globalSystemPrompt\?: string;/);
});

test("the settings page edits the app-wide prompt", () => {
  assert.match(settingsSource, /export function GlobalPromptCard/);
  assert.match(settingsSource, /saveSettings\(\{ globalSystemPrompt: draft\.trim\(\) \}\)/);
  assert.match(settingsSource, /t\("settings\.globalPromptTitle"\)/);
  // A blank field means "fall back", so the stored value must be trimmed empty.
  assert.match(settingsSource, /const stored = settings\.globalSystemPrompt \?\? "";/);
});

test("the conversation editor is a modal that states which persona is in effect", () => {
  assert.match(dialogSource, /role="dialog"/);
  assert.match(dialogSource, /aria-modal="true"/);
  assert.match(dialogSource, /event\.key === "Escape"/);
  assert.match(dialogSource, /useBlockingOverlay\(\)/);
  assert.match(dialogSource, /t\("chat\.conversationPromptDesc"\)/);
  assert.match(dialogSource, /t\("chat\.conversationPromptActive"\)/);
  assert.match(dialogSource, /t\("chat\.conversationPromptInherit"\)/);
  // Clearing the editor removes the override rather than storing "".
  assert.match(dialogSource, /await onSave\(trimmed \? trimmed : null\);/);
  assert.match(topbarSource, /<SessionPromptDialog/);
  assert.match(topbarSource, /active=\{Boolean\(activeSession\?\.systemPrompt\)\}/);
});

test("the store writes the conversation prompt and mirrors the result", () => {
  assert.match(storeSource, /setActiveSessionSystemPrompt: \(systemPrompt: string \| null\) => Promise<void>/);
  assert.match(storeSource, /api\.setSessionSystemPrompt\(sessionId, value\)/);
  assert.match(storeSource, /const value = trimmed \? trimmed : null;/);
  assert.match(storeSource, /sessions: state\.sessions\.map\(/);
});

test("host-side behavior is covered by executable Rust tests", () => {
  // Named here so a rename of either test surfaces as a failure in this file
  // rather than silently dropping coverage of the storage contract.
  assert.match(hostSource, /fn session_system_prompt_round_trips_and_clears\(\)/);
  assert.match(hostSource, /fn session_system_prompt_is_scoped_and_survives_reload\(\)/);
  assert.match(hostSource, /fn session_system_prompt_rejects_oversized_text\(\)/);
  assert.match(migrationTestsSource, /fn v19_database_migrates_session_system_prompt_column/);
});