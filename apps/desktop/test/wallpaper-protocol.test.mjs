import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const repo = join(root, "..", "..");
const read = (rel) => readFileSync(join(root, rel), "utf8");

const protocolSrc = read("electron/main/wallpaper-protocol.ts");
const storeSrc = read("electron/main/wallpaper-store.ts");
const runtimeSrc = read("src/lib/wallpaper-runtime.ts");
const engineSrc = read("src/lib/skin-engine.ts");
const skinIpcSrc = read("electron/main/ipc/skin-ipc.ts");
const startupSrc = read("electron/main/bootstrap/startup.ts");
const htmlSrc = read("index.html");

test("the wallpaper scheme is privileged through the single startup flush", () => {
  assert.match(protocolSrc, /queuePrivilegedScheme\(/);
  assert.match(protocolSrc, /supportFetchAPI: true/);
  // A wallpaper renderer streams scene packages and loads module scripts, so
  // the scheme needs the standard + stream privileges, not just a handler.
  assert.match(protocolSrc, /stream: true/);
  assert.match(startupSrc, /registerWallpaperScheme\(\);/);
  assert.match(startupSrc, /flushPrivilegedSchemes\(\);/);
});

test("the protocol only serves registered roots and refuses traversal", () => {
  assert.match(protocolSrc, /export const wallpaperRoots/);
  assert.match(startupSrc, /registerStoredWallpapers\(dataDir, wallpaperRoots\)/);
  assert.match(startupSrc, /installWallpaperProtocol\(wallpaperRoots\)/);
  // Host must be the literal `project`; a name the renderer invents is not a
  // root lookup, and `..` never reaches the filesystem join.
  assert.match(protocolSrc, /url\.host !== "project"/);
  assert.match(protocolSrc, /part === "\.\."/);
  assert.match(protocolSrc, /isInside\(root, filePath\)/);
});

test("wallpaper documents are pinned to their own origin and stream ranges", () => {
  // The document is untrusted code from a workshop scene: it may not frame the
  // app or call out to a remote host.
  assert.match(protocolSrc, /content-security-policy/);
  assert.match(protocolSrc, /frame-ancestors 'none'/);
  assert.match(protocolSrc, /x-content-type-options/);
  // Range requests are what a scene package and a video need to stream.
  assert.match(protocolSrc, /content-range/);
  assert.match(protocolSrc, /status: 206/);
});

test("importing a project copies it, refuses symlinks, and caps the payload", () => {
  assert.match(storeSrc, /copyFileSync\(from, to\)/);
  assert.match(storeSrc, /lstatSync\(from\)/);
  assert.match(storeSrc, /isSymbolicLink\(\)\) continue/);
  assert.match(storeSrc, /WALLPAPER_MAX_BYTES/);
  assert.match(storeSrc, /WALLPAPER_MAX_FILES/);
  // A half-copied project must not survive into the store.
  assert.match(storeSrc, /rmSync\(target, \{ recursive: true, force: true \}\)/);
  // Deleting a skin's project never deletes a folder outside the store.
  assert.match(storeSrc, /isInside\(root, dir\)/);
});

test("the skin center exposes import, sample, and delete channels", () => {
  assert.match(skinIpcSrc, /IPC\.invoke\.skinImportWallpaper/);
  assert.match(skinIpcSrc, /IPC\.invoke\.skinSeedWallpaper/);
  assert.match(skinIpcSrc, /IPC\.invoke\.skinDeleteWallpaper/);
  assert.match(skinIpcSrc, /registerWallpaperProject\(dataDir, project\.projectId, wallpaperRoots\)/);
  // The picker accepts a `.zip` download as well as a file inside an unpacked
  // project, so it opens as a file dialog with an extension filter.
  assert.match(skinIpcSrc, /properties: \["openFile"\]/);
  assert.match(skinIpcSrc, /extensions: \["zip", "json", "pkg", "html"\]/);
  assert.match(skinIpcSrc, /importWallpaperSource\(dataDir, sourcePath\)/);
});

test("the renderer mounts the project lazily and tears it down", () => {
  assert.match(runtimeSrc, /await import\("webwallgl"\)/);
  assert.match(runtimeSrc, /scripts: false/);
  assert.match(runtimeSrc, /instance\?\.destroy\?\.\(\)/);
  // A slow dynamic import must not resurrect a project the user already left.
  assert.match(runtimeSrc, /generation \+= 1/);
  assert.match(runtimeSrc, /wallpaper:\/\/project\/\$\{id\}\//);
  // A scene is stopped when the window is hidden, like a video background.
  assert.match(runtimeSrc, /visibilitychange/);
});

test("the skin engine treats a scene like a background, keyed by project id", () => {
  assert.match(engineSrc, /safe\.background\.kind === "scene" \|\| safe\.background\.kind === "web"/);
  assert.match(engineSrc, /isLive \? !!safe\.background\.projectId/);
  assert.match(engineSrc, /applyLiveWallpaper\(bg, layer\)/);
  assert.match(engineSrc, /clearLiveWallpaper\(\)/);
  // The live node is owned by the runtime, so the engine must not delete it.
  assert.match(engineSrc, /qn-live-wallpaper/);
});

test("the renderer CSP admits the wallpaper scheme and its worker", () => {
  assert.match(htmlSrc, /frame-src 'self' blob: wallpaper:/);
  assert.match(htmlSrc, /worker-src 'self' blob:/);
  assert.match(htmlSrc, /connect-src[^;]*wallpaper:/);
  assert.match(htmlSrc, /media-src[^;]*wallpaper:/);
});

test("the new strings exist in every shipped locale", () => {
  for (const locale of ["zh-CN", "zh-TW", "en", "de", "es", "fr"]) {
    const file = join(repo, "packages/i18n/src/locales", locale, "index.ts");
    const src = readFileSync(file, "utf8");
    assert.match(src, /"?importWallpaper"?:/, `importWallpaper missing in ${locale}`);
    assert.match(src, /"?tryDemoWallpaper"?:/, `tryDemoWallpaper missing in ${locale}`);
    assert.match(src, /"?typeScene"?:/, `typeScene missing in ${locale}`);
    assert.match(src, /"?wallpaperImported"?:/, `wallpaperImported missing in ${locale}`);
    assert.match(src, /"?wallpaperImportFailed"?:/, `wallpaperImportFailed missing in ${locale}`);
    assert.match(src, /"?wallpaperPackaged"?:/, `wallpaperPackaged missing in ${locale}`);
    assert.match(src, /"?changeWallpaper"?:/, `changeWallpaper missing in ${locale}`);
    assert.match(src, /"?wallpaperChanged"?:/, `wallpaperChanged missing in ${locale}`);
  }
});

test("the bundled demo animates without scripts", () => {
  const demo = readFileSync(join(repo, "apps/desktop/resources/wallpaper-demo/index.html"), "utf8");
  // `webwallgl` mounts web projects with scripts disabled. A demo that needs a
  // script would show one frozen frame, so its motion has to come from CSS.
  assert.doesNotMatch(demo, /<script/i, "the demo must not rely on scripts");
  assert.match(demo, /@keyframes/);
  assert.match(demo, /animation:/);
  const project = JSON.parse(
    readFileSync(join(repo, "apps/desktop/resources/wallpaper-demo/project.json"), "utf8"),
  );
  assert.equal(project.type, "web");
  assert.equal(project.file, "index.html");
});

test("the production CSP keeps the wallpaper scheme reachable", async () => {
  // `electron.vite.config.ts` rewrites connect-src for release builds. A bare
  // 'self' there blocks every project.json fetch and no wallpaper renders in
  // the packaged app, so the scheme has to survive the rewrite.
  const config = readFileSync(join(root, "electron.vite.config.ts"), "utf8");
  assert.match(config, /connect-src 'self' wallpaper:;/);
});
