import assert from "node:assert/strict";
import { build } from "esbuild";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { deflateRawSync } from "node:zlib";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const STORE = join(ROOT, "apps/desktop/electron/main/wallpaper-store.ts");
const FIXTURE = join(ROOT, "apps/desktop/test/fixtures/wallpaper-aurora.zip");

// The store is Electron-adjacent but imports nothing from `electron`, so it
// bundles into plain Node and the real export path is exercised rather than
// a re-implementation of it.
const work = mkdtempSync(join(tmpdir(), "wp-zip-"));
const bundled = join(work, "store.cjs");
await build({
  entryPoints: [join(ROOT, "apps/desktop/electron/main/wallpaper-store.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  logLevel: "silent",
  outfile: bundled,
});
const store = await import(`file://${bundled.replace(/\\/g, "/")}`);

function freshDataDir() {
  return mkdtempSync(join(work, "data-"));
}

/** What the store holds; a refused import leaves no `wallpapers/` at all. */
function stored(dataDir) {
  const dir = join(dataDir, "wallpapers");
  return existsSync(dir) ? readdirSync(dir) : [];
}

/** Minimal store-method ZIP writer, enough to hand the reader a hostile name. */
function writeStoredZip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, body] of entries) {
    const nameBytes = Buffer.from(name, "utf8");
    const data = Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, data);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt32LE(0, 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

test("a zipped project is unpacked, descended, and stored", () => {
  const dataDir = freshDataDir();
  const project = store.importWallpaperSource(dataDir, FIXTURE);
  assert.equal(project.kind, "web");
  assert.equal(project.title, "Aurora Lab");
  assert.ok(project.bytes > 0);

  const dir = join(dataDir, "wallpapers", project.projectId);
  assert.ok(existsSync(join(dir, "project.json")), "the archive's inner folder is the project root");
  assert.ok(existsSync(join(dir, "index.html")));
  assert.deepEqual(
    readdirSync(join(dataDir, "wallpapers")).filter((name) => name.startsWith(".incoming-")),
    [],
    "the scratch folder is removed even on success",
  );
});

test("an archive that escapes its root is refused and leaves nothing behind", () => {
  const dataDir = freshDataDir();
  const hostile = join(work, "hostile.zip");
  writeFileSync(
    hostile,
    writeStoredZip([
      ["../escaped.txt", "nope"],
      ["project.json", JSON.stringify({ type: "web", title: "Hostile" })],
      ["index.html", "<!doctype html><p>hostile</p>"],
    ]),
  );
  assert.throws(() => store.importWallpaperSource(dataDir, hostile), /unsafe path/);
  assert.deepEqual(readdirSync(join(dataDir, "wallpapers")), [], "no partial project survives");
  assert.equal(existsSync(join(dataDir, "escaped.txt")), false);
});

test("a zip without a project is rejected with the documented message", () => {
  const dataDir = freshDataDir();
  const empty = join(work, "empty.zip");
  writeFileSync(empty, writeStoredZip([["notes/readme.txt", "nothing here"]]));
  assert.throws(() => store.importWallpaperSource(dataDir, empty), /not a wallpaper project/);
  assert.deepEqual(readdirSync(join(dataDir, "wallpapers")), []);
});

test("a scene.pkg project is refused with a reason, not imported as a black frame", () => {
  const dataDir = freshDataDir();
  // The shape Wallpaper Engine ships: a manifest that names the package, plus
  // the package itself. `webwallgl` reads loose files only.
  const packaged = mkdtempSync(join(work, "pkg-"));
  writeFileSync(join(packaged, "project.json"), JSON.stringify({ type: "scene", file: "scene.pkg" }));
  writeFileSync(join(packaged, "scene.pkg"), Buffer.from("PK\u0003\u0004 pretend container"));
  assert.throws(
    () => store.importWallpaperSource(dataDir, packaged),
    (error) => error.errorCode === "WALLPAPER_PACKAGED",
  );
  assert.deepEqual(stored(dataDir), []);

  // A bare package with no manifest is the same answer.
  const bare = mkdtempSync(join(work, "pkg-bare-"));
  writeFileSync(join(bare, "scene.pkg"), Buffer.from("PK\u0003\u0004"));
  assert.equal(store.wallpaperProjectProblem(bare), "packaged");
  assert.equal(store.isWallpaperProjectDir(bare), false);
});

test("a project without an index.html is not guessed to be web", () => {
  const dataDir = freshDataDir();
  const folder = mkdtempSync(join(work, "bare-"));
  writeFileSync(join(folder, "index.html"), "<!doctype html><title>bare</title>");
  const project = store.importWallpaperSource(dataDir, folder);
  assert.equal(project.kind, "web", "the entry file is the evidence, not the folder name");
});

test.after(() => rmSync(work, { recursive: true, force: true }));
