/**
 * Cloud sync is retained in the build but no longer a Settings destination.
 *
 * The directory, settings search, and the stale-selection fallback must all
 * agree that `sync` is gone, while the page component and its render branch stay
 * in place. The build-visibility machinery those destinations used is still
 * honoured by the surfaces that remain.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  SETTINGS_NAV,
  isSettingsDestinationHidden,
  searchSettings,
  visibleSettingsNav,
} from "../src/lib/settings-search.ts";

const settingsPage = readFileSync(
  new URL("../src/features/settings/SettingsPage.tsx", import.meta.url),
  "utf8",
);
const searchDialog = readFileSync(
  new URL("../src/components/SearchDialog.tsx", import.meta.url),
  "utf8",
);
const composer = readFileSync(
  new URL("../src/components/Composer.tsx", import.meta.url),
  "utf8",
);

const identity = (key) => key;

test("cloud sync is absent from the directory in every mode", () => {
  for (const developerMode of [false, true]) {
    for (const includeDevelopmentOnly of [true, false]) {
      const ids = visibleSettingsNav(developerMode, includeDevelopmentOnly).map(
        (entry) => entry.id,
      );
      assert.equal(ids.includes("voice"), true);
      assert.equal(ids.includes("sync"), false);
      assert.equal(ids.includes("remoteHosts"), false);
      assert.equal(isSettingsDestinationHidden("sync", developerMode, includeDevelopmentOnly), true);
      assert.equal(isSettingsDestinationHidden("general", developerMode, includeDevelopmentOnly), false);
    }
  }
  assert.equal(SETTINGS_NAV.some((entry) => entry.id === "sync"), false);
});

test("settings search returns no cloud-sync hit", () => {
  assert.deepEqual(
    searchSettings("configSync.connectionTitle", identity, { developerMode: false }),
    [],
  );
  assert.deepEqual(
    searchSettings("configSync.connectionTitle", identity, { developerMode: true }),
    [],
  );
  assert.deepEqual(searchSettings("Cloud sync", identity, { developerMode: true }), []);
  assert.equal(searchSettings("settings", identity, { limit: 2 }).length, 2);
});

test("build visibility is still wired where it is still used", () => {
  assert.match(settingsPage, /const includeDevelopmentOnly = import\.meta\.env\.DEV/);
  assert.match(
    settingsPage,
    /visibleSettingsNav\(developerMode, includeDevelopmentOnly, surface\)/,
  );
  assert.match(settingsPage, /isSettingsDestinationHidden\([\s\S]*includeDevelopmentOnly/);
  assert.match(settingsPage, /setSettingsTab\("general"\)/);
  assert.match(searchDialog, /includeDevelopmentOnly: import\.meta\.env\.DEV/);
  assert.match(composer, /const voiceEnabled = !!settings\?\.voice\?\.enabled/);
  assert.match(composer, /<VoiceOverlay t=\{t\} state=\{voice\.state\} onCancel=\{voice\.cancel\} \/>/);
  assert.doesNotMatch(composer, /import\.meta\.env\.DEV && !!settings\?\.voice\?\.enabled/);
});

test("the retained cloud-sync page keeps its component and render branch", () => {
  assert.match(settingsPage, /import \{ ConfigSyncPage \} from "\.\.\/\.\.\/components\/settings\/ConfigSyncPage"/);
  assert.match(settingsPage, /tab === "sync" && !tabHidden && <ConfigSyncPage \/>/);
});
