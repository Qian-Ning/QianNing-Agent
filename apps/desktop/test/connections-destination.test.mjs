import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * The Connections destination is the human half of the outbound connection
 * layer: the agent only ever gets the `Connection` tool, so every way a target
 * comes into being runs through these files. What is pinned here is the wiring
 * (the destination is reachable) and the two boundaries that must not erode —
 * a probe cannot dial while the switch is off, and a stored secret never
 * travels back into the interface.
 */

const read = (path) =>
  readFile(new URL(path, import.meta.url), "utf8");

const [
  appState,
  appShell,
  runtime,
  sidebar,
  searchDialog,
  settingsPage,
  page,
  api,
  protocol,
  connectionIpc,
  enLocale,
] = await Promise.all([
  read("../src/stores/app-state.ts"),
  read("../src/features/app/AppShell.tsx"),
  read("../src/features/app/useAppShellRuntime.tsx"),
  read("../src/components/Sidebar.tsx"),
  read("../src/components/SearchDialog.tsx"),
  read("../src/features/settings/SettingsPage.tsx"),
  read("../src/pages/ConnectionsPage.tsx"),
  read("../src/lib/api.ts"),
  read("../../../packages/shared/src/protocol.ts"),
  read("../electron/main/ipc/connection-ipc.ts"),
  read("../../../packages/i18n/src/locales/en/index.ts"),
]);

const CATALOG_LOCALES = [
  "de",
  "en",
  "es",
  "fr",
  "ko",
  "pt-BR",
  "tr",
  "zh-CN",
  "zh-TW",
];

const LOCALE_QUOTES = new Set(["de", "es", "fr"]);

test("the destination is a routed page, not a dialog", () => {
  assert.match(
    appState,
    /page:\s*\n?\s*"chat"[\s\S]*?"connections"[\s\S]*?"settings";/,
  );
  assert.match(
    appShell,
    /const ConnectionsPage = lazy\(\(\) =>\s*\n\s*import\("\.\.\/\.\.\/pages\/ConnectionsPage"\)/,
  );
  assert.match(appShell, /page === "connections" \? \(/);
  // A destination that is not part of the work-panel set would render over the
  // chat surface instead of beside it.
  assert.equal(
    runtime.match(/p(?:age)? !== "connections"/g)?.length,
    1,
    "the work-panel predicate must exclude connections exactly once",
  );
  assert.match(runtime, /page === "connections";/);
});

test("the destination is reachable from the footer and from global search", () => {
  assert.match(sidebar, /data-nav="connections"/);
  assert.match(sidebar, /<IconServer size=\{14\} aria-hidden \/>/);
  const searchEntry = searchDialog.match(
    /\{ page: "connections",[^}]*\}/,
  )?.[0] ?? "";
  assert.match(searchEntry, /labelKey: "connections\.title"/);
});

test("the switch lives in settings and the page never flips it", () => {
  assert.match(settingsPage, /title=\{t\("settings\.connectionControl"\)\}/);
  assert.match(settingsPage, /remoteControlEnabled: settings\.remoteControlEnabled !== true/);
  // The agent cannot create a profile, and neither can the destination's data
  // layer imply it can: creating a target is a person's decision, made here.
  assert.doesNotMatch(page, /remoteControlEnabled:\s*true/);
  assert.doesNotMatch(page, /setConnectionSwitch|toggleConnectionControl/);
});

test("a probe cannot dial while the switch is off", () => {
  assert.match(page, /const switchOn = settings\?\.remoteControlEnabled === true;/);
  // Both probe affordances — the list row and the detail pane — carry the gate.
  assert.equal(
    page.match(/disabled=\{busy \|\| !switchOn \|\| !selected\.enabled\}/g)?.length,
    2,
    "both probe buttons must be disabled without the switch",
  );
  assert.match(page, /t\("connections\.probeBlocked"\)/);
  assert.match(page, /\{!switchOn \? \(/);
});

test("a stored secret never comes back through the interface", () => {
  // The renderer's own contract carries a boolean, never a value.
  const shared = readFile(
    new URL("../../../packages/shared/src/types/connections.ts", import.meta.url),
    "utf8",
  );
  return shared.then((source) => {
    const view = source.match(/export type ConnectionProfileView = \{[\s\S]*?\n\};/)?.[0] ?? "";
    assert.match(view, /credentialConfigured: boolean;/);
    assert.doesNotMatch(view, /credential:\s*string/);
    assert.doesNotMatch(view, /password/i);
  });
});

test("the credential field is a masked input with no default value", () => {
  assert.match(page, /<PasswordInput/);
  assert.match(page, /const \[credential, setCredential\] = useState\(""\);/);
  // After a write the field is cleared, so a secret never sits in component
  // state longer than the request that used it.
  assert.match(page, /setCredential\(""\)/);
});

test("an accepted host key comes from the refusal that asked for it", () => {
  // A probe against an unknown or changed key fails on purpose, so the
  // fingerprint to accept is read from that failure's payload.
  assert.match(page, /ConnectionProbeErrorDetails/);
  assert.match(page, /details\?\.fingerprint/);
  assert.match(page, /await api\.acceptConnectionHostKey\(profile\.id, fingerprint\)/);
});

test("the destination reaches the host through the preload bridge only", () => {
  assert.match(protocol, /connectionProbe: "pi-desktop\/connection\/probe"/);
  assert.match(
    connectionIpc,
    /handle\(IPC\.invoke\.connectionProbe, \(profileId: string\) =>\s*\n\s*host!\.call\("connection\.probe", \{ profileId \}\),/,
  );
  for (const method of [
    "listConnectionProfiles",
    "createConnectionProfile",
    "updateConnectionProfile",
    "deleteConnectionProfile",
    "setConnectionEnabled",
    "setConnectionCredential",
    "clearConnectionCredential",
    "acceptConnectionHostKey",
    "getConnectionActivity",
    "probeConnectionProfile",
  ]) {
    assert.match(api, new RegExp(`\\b${method}:`), `${method} is missing from api.ts`);
  }
  // The renderer must not reach SQLite or the host binary directly.
  assert.doesNotMatch(page, /require\(|child_process|sqlite/i);
});

test("every shipped catalog carries the destination's strings", async () => {
  const sources = await Promise.all(
    CATALOG_LOCALES.map((locale) =>
      read(`../../../packages/i18n/src/locales/${locale}/index.ts`),
    ),
  );
  // Read the key set out of English’s own `connections` block,
  // not out of every six-space-indented object in the file.
  const catalog = enLocale;
  const from = catalog.search(/connections: \{/);
  const body = catalog.slice(from).split("\n");
  const stop = body.findIndex((line) => line === "  },");
  const block = body.slice(0, stop).join("\n");
  assert.ok(block.length > 0, "en has no connections block");
  const keys = [...block.matchAll(/^ {4}(\w+):/gm)].map((match) => match[1]);
  assert.ok(keys.length >= 40, `expected the destination's key set, saw ${keys.length}`);
  for (const [index, source] of sources.entries()) {
    const locale = CATALOG_LOCALES[index];
    assert.match(source, /\n {2}connections: \{/, `${locale} has no connections block`);
    const quoted = LOCALE_QUOTES.has(locale);
    for (const key of keys) {
      const pattern = quoted
        ? new RegExp(`^\\s*"${key}":`, "m")
        : new RegExp(`^\\s*${key}:`, "m");
      assert.match(
        source,
        pattern,
        `${locale} is missing connections.${key}`,
      );
    }
  }
});
