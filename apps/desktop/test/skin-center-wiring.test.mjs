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
const skinsShared = await read("../../../packages/shared/src/skins.ts");
const indexHtml = await read("../index.html");
const skinsCss = await read("../src/styles/skins.css");
const enLocale = await read("../../../packages/i18n/src/locales/en/index.ts");
const zhLocale = await read("../../../packages/i18n/src/locales/zh-CN/index.ts");
const globals = await read("../src/styles/globals.css");
const overlays = await read("../src/styles/overlays.css");

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

test("a PURE-COLOUR skin's base scheme drives the foundation, but a WALLPAPER skin defers to the theme", () => {
  // Bug A: 米纸 (a light-based colour skin) rendered near-white text on cream
  // because the shell left data-theme on dark. A pure-colour skin's base scheme
  // must fold into the resolved theme so un-overridden tokens match.
  // Bug B (user: 设置里的主题没有真实生效): a skin carrying an image/video wallpaper
  // must NOT hijack data-theme, or the Settings light/dark/fox picker looks dead.
  // So the base-scheme fold is gated on background.kind === "none".
  assert.match(runtime, /skinBaseScheme/);
  assert.match(runtime, /activeSkin/);
  // The fold happens only for a no-wallpaper skin.
  assert.match(runtime, /activeSkin\.background\.kind === "none"/);
  // The effect re-runs when the active skin or the custom list changes.
  assert.match(runtime, /settings\?\.activeSkinId, settings\?\.customSkins/);
  // The engine injects NO palette override for a wallpaper skin, so the theme
  // owns every colour and the wallpaper is a theme-agnostic layer.
  assert.match(skinEngine, /hasWallpaper/);
  assert.match(skinEngine, /hasWallpaper \? \{\} : skinCssVariables/);
});

test("route pages drop the composer-dock fade mask so the last section is not clipped", () => {
  // Bug: the Skin Center's bottom cards were cut off. `.thread-scroll` carries a
  // fade mask tied to --composer-dock-height (a chat-only affordance); route
  // pages reuse the scroller but have no composer, so the stale dock height
  // faded out the bottom of the page. Route pages must clear the mask.
  assert.match(overlays, /\.route-page > \.thread-scroll\s*\{[^}]*mask-image:\s*none/s);
});

test("the panel token recolours the sidebar, and skin-asset media is allowed by the CSP", () => {
  // The left rail + settings rail must be driven by the skin, not left on the
  // base theme (user report: sidebar not skinned).
  assert.match(skinsShared, /--ds-bg-sidebar/);
  assert.match(skinsShared, /--ds-settings-rail-bg/);
  // The wallpaper scheme must be permitted for <img>/<video>, or the background
  // silently fails to load (user report: image background not showing).
  assert.match(indexHtml, /img-src[^;]*skin-asset:/);
  assert.match(indexHtml, /media-src[^;]*skin-asset:/);
  // The wallpaper layer sits behind the app and the shell goes transparent so
  // it shows through instead of covering content (user report: content hidden).
  assert.match(skinsCss, /z-index: -1/);
  assert.match(skinsCss, /\[data-skin-bg\] #root/);
});

test("a wallpaper covers the WHOLE window: chrome transparent + content still backed", () => {
  // User: 图片或视频要整个页面生效 (cover the whole app, not just the chat pane),
  // and 左边搞成透明但文字清晰 (sidebar fully transparent, text still legible).
  // 1. Every chrome surface — titlebar, topbar, sidebar — goes transparent so the
  //    wallpaper reaches every edge with no seam.
  assert.match(skinsCss, /\[data-skin-bg\] \.main-titlebar/);
  assert.match(skinsCss, /\[data-skin-bg\] \.conversation-topbar/);
  assert.match(skinsCss, /\[data-skin-bg\] \.sidebar-surface/);
  // 2. The sidebar tint defaults to fully transparent (no dimming veil).
  assert.match(skinsShared, /sidebarTint:\s*\{\s*min:\s*0,/);
  // 3. Legibility over the photo comes from a text/icon halo, not a veil.
  assert.match(skinsCss, /\[data-skin-bg\]\[data-theme="dark"\][\s\S]*?text-shadow/);
  assert.match(skinsCss, /\[data-skin-bg\]\[data-theme="light"\][\s\S]*?text-shadow/);
  // 4. Content surfaces do NOT dissolve: the transparent tile tokens are backed
  //    with the skin panel at high opacity (user report: cards vanished).
  assert.match(skinsCss, /\[data-skin-bg\]\s*\{[\s\S]*--ds-tile:/);
  // The engine still publishes/clears the optional sidebar-backing property.
  assert.match(skinEngine, /--qn-skin-sidebar-tint/);
  assert.match(skinEngine, /removeProperty\("--qn-skin-sidebar-tint"\)/);
});

test("the DIY editor has no base-theme picker (a skin is not a theme)", () => {
  // User: 新建皮肤这边不要有主题，会和设置里面的主题冲突. The editor must not render a
  // dark/light/fox base selector; the base foundation is derived from the bg
  // colour instead.
  assert.doesNotMatch(skinEditor, /skin-editor-base-opt/);
  assert.doesNotMatch(skinEditor, /setBase\(/);
  assert.match(skinEditor, /deriveSkinBase/);
  assert.match(skinsShared, /export function deriveSkinBase/);
  // The sidebar-backing slider is still present and backed by the shared limit.
  assert.match(skinEditor, /sidebarTint/);
  assert.match(skinsShared, /sidebarTint:\s*\{/);
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
