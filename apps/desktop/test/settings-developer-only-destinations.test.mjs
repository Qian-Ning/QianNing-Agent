/**
 * Experimental settings destinations are retained in development builds but
 * omitted from packaged builds. Navigation, search, and stale-page handling
 * must all honor the same build visibility.
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
const developerOnlyIds = ["sync", "remoteHosts"];

test("developer mode retains the experimental destinations in development", () => {
  const off = visibleSettingsNav(false).map((entry) => entry.id);
  const on = visibleSettingsNav(true).map((entry) => entry.id);

  assert.equal(off.includes("voice"), true);
  assert.equal(on.includes("voice"), true);
  for (const id of developerOnlyIds) {
    assert.equal(off.includes(id), false);
    assert.equal(on.includes(id), true);
  }
  assert.deepEqual(off, on.filter((id) => !developerOnlyIds.includes(id)));
  assert.deepEqual(
    SETTINGS_NAV.filter((entry) => entry.developerOnly === true).map((entry) => entry.id),
    developerOnlyIds,
  );
  assert.ok(
    SETTINGS_NAV.filter((entry) => entry.developerOnly === true)
      .every((entry) => entry.experimentalBadgeKey),
  );
});

test("packaged builds retain voice while hiding cloud sync and remote hosts", () => {
  const packaged = visibleSettingsNav(true, false).map((entry) => entry.id);
  assert.equal(packaged.includes("voice"), true);
  assert.equal(isSettingsDestinationHidden("voice", false, false), false);
  for (const id of developerOnlyIds) {
    assert.equal(packaged.includes(id), false);
    assert.equal(isSettingsDestinationHidden(id, true, false), true);
  }
  assert.equal(isSettingsDestinationHidden("general", true, false), false);
});

test("settings search mirrors developer and packaged visibility", () => {
  assert.deepEqual(
    searchSettings("configSync.connectionTitle", identity, { developerMode: false }),
    [],
  );
  assert.ok(
    searchSettings("configSync.connectionTitle", identity, { developerMode: true })
      .some((hit) => hit.tab === "sync"),
  );

  assert.ok(
    searchSettings("voiceEnable", identity, {
      developerMode: false,
      includeDevelopmentOnly: false,
    }).some((hit) => hit.tab === "voice"),
  );

  for (const query of ["configSync.connectionTitle", "remotehosts"]) {
    assert.ok(
      searchSettings(query, identity, { developerMode: true })
        .some((hit) => developerOnlyIds.includes(hit.tab)),
    );
    assert.deepEqual(
      searchSettings(query, identity, {
        developerMode: true,
        includeDevelopmentOnly: false,
      }),
      [],
    );
  }
  assert.equal(searchSettings("settings", identity, { limit: 2 }).length, 2);
});

test("settings routes, global search, and composer use build visibility", () => {
  assert.match(settingsPage, /const includeDevelopmentOnly = import\.meta\.env\.DEV/);
  assert.match(settingsPage, /visibleSettingsNav\(developerMode, includeDevelopmentOnly\)/);
  assert.match(settingsPage, /isSettingsDestinationHidden\([\s\S]*includeDevelopmentOnly/);
  assert.match(settingsPage, /setSettingsTab\("general"\)/);
  assert.match(settingsPage, /tab === "sync" && !tabHidden && <ConfigSyncPage \/>/);
  assert.match(settingsPage, /tab === "remoteHosts" && !tabHidden && <RemoteHostsPage \/>/);
  assert.match(searchDialog, /includeDevelopmentOnly: import\.meta\.env\.DEV/);
  assert.match(composer, /const voiceEnabled = !!settings\?\.voice\?\.enabled/);
  assert.match(composer, /<VoiceOverlay t=\{t\} state=\{voice\.state\} onCancel=\{voice\.cancel\} \/>/);
  assert.doesNotMatch(composer, /import\.meta\.env\.DEV && !!settings\?\.voice\?\.enabled/);
});
