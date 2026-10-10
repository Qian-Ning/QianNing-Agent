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
  clearLibrary,
  libraryEntryFrom,
  mediaLibraryDir,
  mediaLibraryThumbDir,
  migrateScratchRenders,
  pruneLibrary,
  readMediaLibrary,
  removeLibraryEntries,
  thumbPathFor,
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

test("library: the provider that ran is recorded beside the model", async (t) => {
  const dataDir = await makeDataDir(t);
  const path = await makeRender(
    dataDir,
    "image",
    "generated-44444444-4444-4444-4444-444444444444.png",
  );

  await appendMediaLibrary(dataDir, [
    libraryEntryFrom({
      capability: "image",
      path,
      status: "succeeded",
      providerId: "openrouter",
      modelId: "black-forest-labs/flux-1.1-pro",
    }),
  ]);

  const [entry] = await readMediaLibrary(dataDir);
  // One model id is served by several providers, so the row that names only the
  // model is ambiguous; the producer is what makes a restored history honest.
  assert.equal(entry.providerId, "openrouter", "the producer survives the round trip");
  assert.equal(entry.modelId, "black-forest-labs/flux-1.1-pro");
});

test("library: an index from a build that recorded no provider still reads", async (t) => {
  const dataDir = await makeDataDir(t);
  const path = await makeRender(
    dataDir,
    "image",
    "generated-55555555-5555-5555-5555-555555555555.png",
  );
  // Exactly what the previous build wrote: a model, no provider. Adding the
  // field is not a migration — an old index keeps working as it stands.
  await writeFile(
    join(mediaLibraryDir(dataDir), "index.json"),
    `${JSON.stringify(
      [
        {
          id: "11111111-aaaa-4aaa-8aaa-111111111111",
          capability: "image",
          path,
          status: "succeeded",
          prompt: "a lantern",
          modelId: "flux-1.1-pro",
          createdAt: "2026-10-01T00:00:00.000Z",
        },
      ],
      null,
      2,
    )}\n`,
    "utf8",
  );

  const entries = await readMediaLibrary(dataDir);
  assert.equal(entries.length, 1, "an entry without the new field is still an entry");
  assert.equal(entries[0].prompt, "a lantern");
  assert.equal(entries[0].modelId, "flux-1.1-pro");
  assert.equal(entries[0].providerId, undefined, "no recorded provider reads as unknown");
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

test("library: a failed entry with no file is written and survives a read", async (t) => {
  const dataDir = await makeDataDir(t);

  await appendMediaLibrary(dataDir, [
    libraryEntryFrom({
      capability: "video",
      status: "failed",
      prompt: "a paper lantern",
      modelId: "video-one",
      errorCode: "VIDEO_TIMEOUT",
    }),
  ]);

  const entries = await readMediaLibrary(dataDir);
  assert.equal(entries.length, 1, "a failure with no file is remembered, not dropped");
  assert.equal(entries[0].status, "failed");
  assert.equal(entries[0].errorCode, "VIDEO_TIMEOUT");
  assert.equal(entries[0].prompt, "a paper lantern");
  assert.equal(entries[0].path, undefined, "a failed run has no file to point at");
});

test("library: a cancelled entry with no file is written and survives a read", async (t) => {
  const dataDir = await makeDataDir(t);

  await appendMediaLibrary(dataDir, [
    libraryEntryFrom({ capability: "image", status: "cancelled", errorCode: "IMAGE_CANCELLED" }),
  ]);

  const entries = await readMediaLibrary(dataDir);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].status, "cancelled");
  assert.equal(entries[0].path, undefined);
});

test("library: containment still drops a failed entry that names a file outside the root", async (t) => {
  const dataDir = await makeDataDir(t);
  const outsider = join(dataDir, "settings.json");
  await writeFile(outsider, "{}", "utf8");

  await appendMediaLibrary(dataDir, [
    libraryEntryFrom({ capability: "image", status: "failed", errorCode: "BOOM", path: outsider }),
    libraryEntryFrom({ capability: "image", status: "failed", errorCode: "NOOP" }),
  ]);

  const entries = await readMediaLibrary(dataDir);
  assert.deepEqual(
    entries.map((entry) => entry.errorCode),
    ["NOOP"],
    "a path that escapes the library is dropped even on a failure; no path is fine",
  );
});

test("library: a succeeded entry without a path is refused by the reader", async (t) => {
  const dataDir = await makeDataDir(t);
  const dir = mediaLibraryDir(dataDir);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "index.json"),
    `${JSON.stringify([
      { id: "one", capability: "image", status: "succeeded", createdAt: new Date().toISOString() },
    ])}\n`,
    "utf8",
  );

  assert.deepEqual(
    await readMediaLibrary(dataDir),
    [],
    "a succeeded entry must carry a path to be trusted",
  );
});

test("library: removing entries drops only the named ids and returns them", async (t) => {
  const dataDir = await makeDataDir(t);
  const first = await makeRender(dataDir, "image", "generated-aaaaaaa1-1111-1111-1111-111111111111.png");
  const second = await makeRender(dataDir, "image", "generated-aaaaaaa2-2222-2222-2222-222222222222.png");
  const keep = libraryEntryFrom({ capability: "image", path: first, status: "succeeded" });
  const drop = libraryEntryFrom({ capability: "image", path: second, status: "succeeded" });
  const failed = libraryEntryFrom({ capability: "video", status: "failed", errorCode: "VIDEO_TIMEOUT" });
  await appendMediaLibrary(dataDir, [keep, drop, failed]);

  const removed = await removeLibraryEntries(dataDir, [drop.id, "not-there"]);

  assert.deepEqual(removed.map((entry) => entry.id), [drop.id], "only real ids are returned");
  const entries = await readMediaLibrary(dataDir);
  assert.deepEqual(
    entries.map((entry) => entry.id).sort(),
    [keep.id, failed.id].sort(),
    "the other entries are untouched, including a failure with no file",
  );
  assert.deepEqual(await removeLibraryEntries(dataDir, []), [], "an empty request does nothing");
});

test("library: clearing empties the index and returns everything it held", async (t) => {
  const dataDir = await makeDataDir(t);
  const path = await makeRender(dataDir, "image", "generated-bbbbbbb1-1111-1111-1111-111111111111.png");
  await appendMediaLibrary(dataDir, [
    libraryEntryFrom({ capability: "image", path, status: "succeeded" }),
    libraryEntryFrom({ capability: "video", status: "cancelled", errorCode: "VIDEO_CANCELLED" }),
  ]);

  const cleared = await clearLibrary(dataDir);
  assert.equal(cleared.length, 2, "every entry is handed back so its file can be reclaimed");
  assert.deepEqual(await readMediaLibrary(dataDir), [], "the index is empty afterwards");
});

test("library: a render's derived copy is named for it, under thumbs, inside the capability", () => {
  const dataDir = join(tmpdir(), "library-paths");
  const image = join(
    mediaLibraryDir(dataDir, "image"),
    "generated-ccccccc1-1111-1111-1111-111111111111.png",
  );

  // The copy has to live under `image/` or `video/` to be handed to the renderer
  // at all (ADR 0322), so it lives inside the capability directory rather than in
  // a tree of its own — and it keeps the render's name, as a PNG.
  assert.equal(
    thumbPathFor(dataDir, "image", image),
    join(
      mediaLibraryThumbDir(dataDir, "image"),
      "generated-ccccccc1-1111-1111-1111-111111111111.png",
    ),
    "the copy is named for the render it was made from",
  );
  assert.equal(
    thumbPathFor(dataDir, "video", join(mediaLibraryDir(dataDir, "video"), "clip.mp4")),
    join(mediaLibraryThumbDir(dataDir, "video"), "clip.png"),
    "a clip's copy would drop the clip's extension for the picture's",
  );
});

test("library: nothing is asked of a derived copy when there is no render to derive it from", () => {
  assert.equal(thumbPathFor("C:/data", "image", undefined), undefined);
  assert.equal(thumbPathFor("C:/data", "image", ""), undefined);
});
