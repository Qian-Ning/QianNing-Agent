/**
 * The media library: the app's own record of what it rendered.
 *
 * These tests exist because the index decides what the workbench is willing to
 * show and hand out. Two failures matter most: an entry pointing outside the
 * library (which would turn "show in folder" into a general file reader), and a
 * write that loses the index the user's assets are recorded in.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

const {
  MAX_LIBRARY_ENTRIES,
  appendMediaLibrary,
  libraryEntryFrom,
  mediaLibraryDir,
  migrateScratchRenders,
  pruneLibrary,
  readMediaLibrary,
} = await import("../electron/main/services/media-library.ts");

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9mQAAAAASUVORK5CYII=",
  "base64",
);

async function makeDataDir(t) {
  const dataDir = await mkdtemp(join(tmpdir(), "library-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  return dataDir;
}

async function makeRender(dataDir, capability, name) {
  const dir = mediaLibraryDir(dataDir, capability);
  await mkdir(dir, { recursive: true });
  const path = join(dir, name);
  await writeFile(path, png);
  return path;
}

test("library: a render is recorded and read back in the order it finished", async (t) => {
  const dataDir = await makeDataDir(t);
  const first = await makeRender(dataDir, "image", "generated-11111111-1111-1111-1111-111111111111.png");
  const second = await makeRender(dataDir, "video", "generated-22222222-2222-2222-2222-222222222222.mp4");

  await appendMediaLibrary(dataDir, [
    libraryEntryFrom({ capability: "image", path: first, status: "succeeded", prompt: "a lantern" }),
    libraryEntryFrom({ capability: "video", path: second, status: "failed", errorCode: "VIDEO_TIMEOUT" }),
  ]);

  const entries = await readMediaLibrary(dataDir);
  assert.equal(entries.length, 2);
  assert.deepEqual(
    entries.map((entry) => [entry.capability, entry.status]),
    [
      ["image", "succeeded"],
      ["video", "failed"],
    ],
    "capability and outcome survive the round trip, so history can be split by either",
  );
  assert.equal(entries[0].prompt, "a lantern");
  assert.equal(entries[1].errorCode, "VIDEO_TIMEOUT");
  assert.ok(Date.parse(entries[0].createdAt) > 0, "createdAt is a real timestamp");
});

test("library: the index is bounded, oldest first", () => {
  const entries = Array.from({ length: MAX_LIBRARY_ENTRIES + 25 }, (_, index) => index);
  const pruned = pruneLibrary(entries);
  assert.equal(pruned.length, MAX_LIBRARY_ENTRIES);
  assert.equal(pruned[0], 25, "the oldest entries fall off");
  assert.equal(pruned.at(-1), MAX_LIBRARY_ENTRIES + 24, "the newest is kept");
  assert.deepEqual(pruneLibrary([1, 2]), [1, 2], "a short index is untouched");
});

test("library: a damaged index reads as empty and the next append repairs it", async (t) => {
  const dataDir = await makeDataDir(t);
  const path = await makeRender(dataDir, "image", "generated-33333333-3333-3333-3333-333333333333.png");
  await writeFile(join(mediaLibraryDir(dataDir), "index.json"), "{ not json", "utf8");

  assert.deepEqual(await readMediaLibrary(dataDir), [], "a hand-edited index is not fatal");

  await appendMediaLibrary(dataDir, [
    libraryEntryFrom({ capability: "image", path, status: "succeeded" }),
  ]);
  const entries = await readMediaLibrary(dataDir);
  assert.equal(entries.length, 1, "the index is rewritten from what it could still read");
  assert.equal(entries[0].path, path);
});

test("library: an entry pointing outside the library is dropped, not served", async (t) => {
  const dataDir = await makeDataDir(t);
  const inside = await makeRender(dataDir, "image", "generated-44444444-4444-4444-4444-444444444444.png");
  const outsider = join(dataDir, "settings.json");
  await writeFile(outsider, "{}", "utf8");

  await appendMediaLibrary(dataDir, [
    libraryEntryFrom({ capability: "image", path: inside, status: "succeeded" }),
    libraryEntryFrom({ capability: "image", path: outsider, status: "succeeded" }),
  ]);

  const entries = await readMediaLibrary(dataDir);
  assert.deepEqual(
    entries.map((entry) => entry.path),
    [await realpath(inside)],
    "a file outside the library root never reaches the renderer",
  );
});

test("library: concurrent appends both land", async (t) => {
  const dataDir = await makeDataDir(t);
  const first = await makeRender(dataDir, "image", "generated-55555555-5555-5555-5555-555555555555.png");
  const second = await makeRender(dataDir, "image", "generated-66666666-6666-6666-6666-666666666666.png");

  await Promise.all([
    appendMediaLibrary(dataDir, [libraryEntryFrom({ capability: "image", path: first, status: "succeeded" })]),
    appendMediaLibrary(dataDir, [libraryEntryFrom({ capability: "image", path: second, status: "succeeded" })]),
  ]);

  const entries = await readMediaLibrary(dataDir);
  assert.equal(entries.length, 2, "one write cannot swallow the other");
});

test("library: renders stranded in session scratch are imported once", async (t) => {
  const dataDir = await makeDataDir(t);
  const scratch = join(dataDir, "scratch", "session-one");
  await mkdir(scratch, { recursive: true });
  await writeFile(join(scratch, "generated-77777777-7777-7777-7777-777777777777.png"), png);
  await writeFile(join(scratch, "generated-88888888-8888-8888-8888-888888888888.mp4"), png);
  await writeFile(join(scratch, "notes.txt"), "not a render", "utf8");

  const migrated = await migrateScratchRenders(dataDir);
  assert.deepEqual(
    migrated.map((entry) => entry.capability).sort(),
    ["image", "video"],
    "both renders are imported and filed by kind; other files are left alone",
  );

  const entries = await readMediaLibrary(dataDir);
  assert.equal(entries.length, 2);
  for (const entry of entries) {
    assert.equal(
      dirname(await realpath(entry.path)) === (await realpath(mediaLibraryDir(dataDir, entry.capability))),
      true,
      "an imported render lives in the library, not in the conversation it came from",
    );
    assert.equal((await readFile(entry.path)).length, png.length, "the asset itself is copied");
  }
  assert.deepEqual(await migrateScratchRenders(dataDir), [], "the import never runs twice");
});
