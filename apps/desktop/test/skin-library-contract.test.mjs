import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (rel) => readFile(new URL(rel, import.meta.url), "utf8");

const library = await read("../src/features/skins/useSkinLibrary.ts");
const writer = await read("../src/features/skins/skin-settings-writer.ts");
const session = await read("../src/features/skins/asset-session.ts");
const model = await read("../src/features/skins/model.ts");
const editor = await read("../src/features/skins/SkinEditorDialog.tsx");
const page = await read("../src/pages/SkinCenterPage.tsx");

/*
  The skin center rebuild moved three rules that used to be implicit (and buggy)
  into named places. These tests pin the rules, not the pixels: a regression here
  means a user can lose a wallpaper, lose an edit, or lose a skin.
*/

test("library writes are serialized and re-read current settings", () => {
  // Two edits in flight must not write each other's stale snapshot back. The
  // queue lives in the one writer both the library and the rotation share.
  assert.match(library, /writeSkinSettings\(patch\)/);
  assert.match(writer, /queue\.then/);
  assert.match(writer, /useAppStore\.getState\(\)\.settings/);
  assert.match(writer, /useAppStore\.setState\(\{ settings: current \}\)/);
});

test("background media is transactional: commit keeps, cancel discards", () => {
  assert.match(session, /commit\(\)/);
  assert.match(session, /discard\(\)/);
  assert.match(session, /deleteAsset/);
  // The editor adopts on import and discards when the sheet is closed dirty.
  assert.match(editor, /session\.adopt/);
  assert.match(editor, /sessionRef\.current\.discard/);
  // The library commits only after the save landed.
  assert.match(library, /session\?\.commit\(\)/);
});

test("a media file is deleted only when no surviving skin references it", () => {
  assert.match(library, /deleteIfUnreferenced/);
  assert.match(library, /some\(\s*\(entry\) => entry\.background\.assetId === assetId/s);
  // Duplicated skins share an asset, so deletion has to ask this question.
  assert.match(library, /replaced\.assetId !== safe\.background\.assetId/);
});

test("unsaved edits are never dropped silently", () => {
  assert.match(model, /export function isDraftDirty/);
  assert.match(editor, /isDraftDirty\(draft\)/);
  assert.match(editor, /window\.confirm\(t\("skins\.discardBody"\)\)/);
});

test("the page is layout only and the editor owns no persistence", () => {
  assert.match(page, /useSkinLibrary\(\)/);
  assert.doesNotMatch(page, /api\.setSettings/);
  assert.doesNotMatch(editor, /api\.setSettings/);
});

test("a draft sanitizes through the shared validator before it can be saved", () => {
  assert.match(model, /export function draftToSkin[\s\S]*sanitizeSkin/);
  assert.match(editor, /draftToSkin\(draft\)/);
});

test("duplicating keeps a fresh id and never applies the copy", () => {
  assert.match(model, /export function duplicateOf/);
  assert.match(model, /createSkinId\(\)/);
  // duplicate() persists the list without touching activeSkinId.
  const duplicateBlock = library.slice(library.indexOf("const duplicate ="), library.indexOf("const importFromFile"));
  assert.match(duplicateBlock, /customSkins:/);
  assert.doesNotMatch(duplicateBlock, /activeSkinId/);
});

test("a packaged wallpaper import explains itself in the user's language", () => {
  // The host refuses a scene.pkg project with WALLPAPER_PACKAGED; the renderer
  // picks the specific sentence instead of the generic failure.
  assert.match(library, /WALLPAPER_PACKAGED/);
  assert.match(library, /skins\.wallpaperPackaged/);
});

test("changing a wallpaper keeps the skin and releases the old project", () => {
  // The swap goes through `save`, so the replaced project follows the same
  // ownership rule as a replaced media file: deleted only when unreferenced.
  assert.match(library, /changeWallpaper:/);
  assert.match(library, /deleteProjectIfUnreferenced\(replaced\.projectId\)/);
  assert.match(library, /wallpaperChanged/);
});

test("a photo or clip swap rides the same save path and session", () => {
  // The media swap must not write settings itself: it adopts the new file in an
  // asset session and lets `save` commit it, so a failed save deletes the file
  // instead of leaving it orphaned.
  assert.match(library, /changeMediaWallpaper:/);
  const block = library.slice(library.indexOf("const changeMediaWallpaper"));
  const body = block.slice(0, block.indexOf("\n  );"));
  assert.match(body, /createAssetSession\(/);
  assert.match(body, /session\.adopt\(result\)/);
  assert.match(body, /await save\(next, session, base\)/);
  assert.match(body, /projectId: undefined/);
});

test("the export and import round trip can run without a native dialog", async () => {
  // A save/open dialog cannot be scripted, which left the .qnskin path with no
  // end-to-end coverage. Both handlers accept an explicit path for automation;
  // the window never passes one.
  const ipc = await readFile(new URL("../electron/main/ipc/skin-ipc.ts", import.meta.url), "utf8");
  assert.match(ipc, /const target = request\.path\?\.trim\(\);/);
  assert.match(ipc, /const given = request\?\.path\?\.trim\(\);/);
  assert.match(ipc, /\{ canceled: false, filePath: target \}/);
  assert.match(ipc, /\{ canceled: false, filePaths: \[given\] \}/);
});
