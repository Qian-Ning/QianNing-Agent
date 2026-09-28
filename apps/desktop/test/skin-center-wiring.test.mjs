import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import test from "node:test";

const read = (rel) => readFile(new URL(rel, import.meta.url), "utf8");

const sidebar = await read("../src/components/Sidebar.tsx");
const appShell = await read("../src/features/app/AppShell.tsx");
const appState = await read("../src/stores/app-state.ts");
const runtime = await read("../src/features/app/useAppShellRuntime.tsx");
const skinEngine = await read("../src/lib/skin-engine.ts");
const skinPage = await read("../src/pages/SkinCenterPage.tsx");
const skinEditor = await read("../src/features/skins/SkinEditorDialog.tsx");
const api = await read("../src/lib/api.ts");
const protocol = await read("../../../packages/shared/src/protocol.ts");
const assetProtocol = await read("../electron/main/skin-asset-protocol.ts");
const skinIpc = await read("../electron/main/ipc/skin-ipc.ts");
const register = await read("../electron/main/ipc/register.ts");
const startup = await read("../electron/main/bootstrap/startup.ts");
const settingsType = await read("../../../packages/shared/src/types/settings.ts");
const enLocale = await read("../../../packages/i18n/src/locales/en/index.ts");
const zhLocale = await read("../../../packages/i18n/src/locales/zh-CN/index.ts");
const globals = await read("../src/styles/globals.css");

test("the skin center has its own dedicated sidebar entry, distinct from settings/theme", () => {
  // A footer nav button that routes to the skins page.
  assert.match(sidebar, /data-nav="skins"/);
  assert.match(sidebar, /setPage\("skins"\)/);
  assert.match(sidebar, /nav\.skins/);
  // The page is a first-class route in the shell and app state.
  assert.match(appState, /"skins"/);
  assert.match(appShell, /page === "skins"/);
  assert.match(appShell, /SkinCenterPage/);
});

test("applying a skin persists activeSkinId through settings, not a theme change", () => {
  // The page writes activeSkinId via setSettings and never touches themePreference.
  assert.match(skinPage, /activeSkinId/);
  assert.match(skinPage, /api\.setSettings/);
  assert.doesNotMatch(skinPage, /themePreference/);
  // The runtime applies the active skin on settings change.
  assert.match(runtime, /applySkin/);
  assert.match(runtime, /resolveSkin/);
  // Settings type carries the skin fields.
  assert.match(settingsType, /activeSkinId\?: string;/);
  assert.match(settingsType, /customSkins\?: /);
});

test("the apply engine only ever writes allowlisted --ds-* custom properties", () => {
  // Palette comes from skinCssVariables (allowlist-expanded), applied as scoped
  // custom properties — no raw selector or url() assembled from skin input.
  assert.match(skinEngine, /skinCssVariables/);
  assert.match(skinEngine, /data-skin/);
  // Background media is loaded only over the host scheme, never a raw path.
  assert.match(skinEngine, /skinAssetUrl/);
  assert.match(skinEngine, /skin-asset:/);
  // The video background pauses on blur to save power.
  assert.match(skinEngine, /bindVideoFocusPause|hasFocus/);
});

test("skin background media is served by a confined host scheme", () => {
  // The scheme is reserved pre-ready and installed after ready.
  assert.match(startup, /registerSkinAssetScheme/);
  assert.match(startup, /installSkinAssetProtocol/);
  // Requests are confined to the assets directory and format-checked.
  assert.match(assetProtocol, /isInside\(/);
  assert.match(assetProtocol, /ASSET_ID/);
  assert.match(assetProtocol, /notFound\(\)/);
  // A size cap keeps an import bounded.
  assert.match(assetProtocol, /SKIN_ASSET_MAX_BYTES/);
});

test("the skin IPC surface is registered and whitelisted", () => {
  for (const id of ["skinImportAsset", "skinDeleteAsset", "skinExport", "skinImport"]) {
    assert.match(protocol, new RegExp(id), `protocol must define ${id}`);
    assert.match(api, new RegExp(id), `api must expose ${id}`);
    assert.match(skinIpc, new RegExp(id), `handler must register ${id}`);
  }
  assert.match(register, /registerSkinIpc/);
});

test("import/export re-validate through the shared sanitizer (never trust a file)", () => {
  assert.match(skinIpc, /sanitizeSkin/);
  assert.match(skinIpc, /sanitizeQnskinBundle/);
  // The DIY editor sanitizes before handing a skin up.
  assert.match(skinEditor, /sanitizeSkin/);
});

test("the DIY editor exposes only allowlisted colour tokens", () => {
  // The editor edits a fixed allowlisted set; assert the keys and the exported
  // constant are present in source (the file is TSX, not importable here).
  assert.match(skinEditor, /EDITOR_TOKEN_KEYS/);
  for (const key of ["accent", "bg", "panel", "fg", "focus"]) {
    assert.match(skinEditor, new RegExp(`key: "${key}"`), `editor must expose ${key}`);
  }
  // It must not offer a raw CSS or free-text style field.
  assert.doesNotMatch(skinEditor, /customCss|rawCss|styleSheet/i);
});

test("skin styling is wired and the skins i18n namespace exists in en and zh-CN", () => {
  assert.match(globals, /skins\.css/);
  assert.match(globals, /skin-center\.css/);
  for (const locale of [enLocale, zhLocale]) {
    assert.match(locale, /\bskins:\s*\{/);
    assert.match(locale, /title:/);
  }
  // nav.skins label present.
  assert.match(enLocale, /skins: "Skins"/);
});

test("the skin center page components exist on disk", async () => {
  for (const rel of [
    "../src/pages/SkinCenterPage.tsx",
    "../src/features/skins/SkinCard.tsx",
    "../src/features/skins/SkinEditorDialog.tsx",
    "../src/lib/skin-engine.ts",
    "../src/styles/skins.css",
    "../src/styles/skin-center.css",
    "../electron/main/skin-asset-protocol.ts",
    "../electron/main/ipc/skin-ipc.ts",
  ]) {
    await assert.doesNotReject(access(new URL(rel, import.meta.url)), `${rel} must exist`);
  }
});
