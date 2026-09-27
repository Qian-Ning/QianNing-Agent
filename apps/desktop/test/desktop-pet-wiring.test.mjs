import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import test from "node:test";

const petComponent = await readFile(
  new URL("../src/components/DesktopPet.tsx", import.meta.url),
  "utf8",
);
const petHook = await readFile(
  new URL("../src/hooks/use-pet-mood.ts", import.meta.url),
  "utf8",
);
const appShell = await readFile(
  new URL("../src/features/app/AppShell.tsx", import.meta.url),
  "utf8",
);
const settingsPage = await readFile(
  new URL("../src/features/settings/SettingsPage.tsx", import.meta.url),
  "utf8",
);
const settingsType = await readFile(
  new URL("../../../packages/shared/src/types/settings.ts", import.meta.url),
  "utf8",
);
const enLocale = await readFile(
  new URL("../../../packages/i18n/src/locales/en/index.ts", import.meta.url),
  "utf8",
);

test("the pet is opt-in: hidden unless settings.petEnabled is true", () => {
  assert.match(settingsType, /petEnabled\?: boolean;/);
  // AppShell gates the mount on the flag being explicitly true.
  assert.match(appShell, /petEnabled\s*&&\s*page === "chat"/);
  assert.match(appShell, /settings\?\.petEnabled === true/);
  // Settings exposes a toggle that writes the flag.
  assert.match(settingsPage, /settings\.petEnabled/);
  assert.match(settingsPage, /saveSettings\(\{ petEnabled: settings\.petEnabled !== true \}\)/);
});

test("the pet only reads run state; it never drives the agent", () => {
  // The mood hook reads store slices but must not call any mutating action.
  assert.match(petHook, /runningSessions/);
  assert.match(petHook, /agentStatuses/);
  assert.match(petHook, /sessionOutcomes/);
  assert.match(petHook, /pendingPermissions/);
  // No agent-driving calls leak into the companion.
  for (const forbidden of [
    /sendPrompt/,
    /steerPrompt/,
    /abort\(/,
    /resolvePermission/,
    /configureActiveSession/,
    /api\.\w+\(/,
  ]) {
    assert.doesNotMatch(petHook, forbidden, `hook must not call ${forbidden}`);
    assert.doesNotMatch(petComponent, forbidden, `component must not call ${forbidden}`);
  }
});

test("all seven animation clips exist as bundled assets", async () => {
  const clips = ["idle", "thinking", "working", "success", "error", "sleep", "searching"];
  for (const clip of clips) {
    const url = new URL(`../src/assets/pet/anim/${clip}.webp`, import.meta.url);
    await assert.doesNotReject(access(url), `missing anim/${clip}.webp`);
  }
  // The component imports each one.
  for (const clip of clips) {
    assert.match(petComponent, new RegExp(`assets/pet/anim/${clip}\\.webp`), clip);
  }
});

test("companion strings are present and go through i18n", () => {
  assert.match(enLocale, /companion: "Companion"/);
  assert.match(enLocale, /petEnabled: "Desktop pet"/);
  assert.match(enLocale, /pet: \{/);
  // The component never hard-codes the speech lines.
  assert.match(petComponent, /t\("pet\.ariaLabel"\)/);
  assert.match(petComponent, /pet\.say\./);
});
