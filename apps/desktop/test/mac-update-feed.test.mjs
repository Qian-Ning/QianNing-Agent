import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  MacFeedError,
  buildMacUpdateFeed,
  mergeMacUpdateFeeds,
  parseMacFeed,
  renderMacUpdateFeed,
} from "../../../scripts/merge-mac-update-feed.mjs";

const SCRIPT = fileURLToPath(
  new URL("../../../scripts/merge-mac-update-feed.mjs", import.meta.url),
);

/**
 * The lane script renames each lane's feed to `latest-mac-<arch>.yml` before
 * uploading, so this is the shape the publish job actually sees.
 */
function feed({ version, files, releaseDate, path, sha512 }) {
  const lines = [`version: ${version}`, "files:"];
  for (const file of files) {
    lines.push(`  - url: ${file.url}`);
    lines.push(`    sha512: ${file.sha512}`);
    lines.push(`    size: ${file.size}`);
  }
  lines.push(`path: ${path ?? files[0].url}`);
  lines.push(`sha512: ${sha512 ?? files[0].sha512}`);
  if (releaseDate) lines.push(`releaseDate: '${releaseDate}'`);
  return `${lines.join("\n")}\n`;
}

const ARM64_DMG = {
  // Real macOS artifacts keep the product name's space, so the parser has to
  // round-trip a value with an interior space.
  url: "QianNing Agent-0.15.15-arm64.dmg",
  sha512: "AAAABBBBCCCCDDDD/EEEE+FFFF==gggg",
  size: 118592520,
};
const ARM64_ZIP = {
  url: "QianNing Agent-0.15.15-arm64-mac.zip",
  sha512: "ZZZZYYYYXXXXWWWW/VVVV+UUUU==tttt",
  size: 116281344,
};
const X64_DMG = {
  url: "QianNing-Agent-0.15.15-x64.dmg",
  sha512: "1111222233334444/5555+6666==7777",
  size: 120268480,
};
const X64_ZIP = {
  url: "QianNing-Agent-0.15.15-x64-mac.zip",
  sha512: "8888999900001111/2222+3333==4444",
  size: 117964800,
};

async function createFixture(lanes) {
  const dir = await mkdtemp(join(tmpdir(), "qianning-mac-feed-"));
  for (const [name, contents] of Object.entries(lanes)) {
    await writeFile(join(dir, name), contents);
  }
  return dir;
}

test("merges both architecture feeds into the single archive electron-updater asks for", async (t) => {
  const dir = await createFixture({
    "latest-mac-arm64.yml": feed({
      version: "0.15.15",
      files: [ARM64_DMG, ARM64_ZIP],
      releaseDate: "2026-10-03T10:00:00.000Z",
    }),
    "latest-mac-x64.yml": feed({
      version: "0.15.15",
      files: [X64_DMG, X64_ZIP],
      releaseDate: "2026-10-03T10:05:00.000Z",
    }),
  });
  t.after(() => rm(dir, { recursive: true, force: true }));

  const merged = mergeMacUpdateFeeds(dir);
  assert.equal(merged.version, "0.15.15");
  assert.deepEqual(merged.arches, ["arm64", "x64"]);
  assert.equal(merged.releaseDate, "2026-10-03T10:05:00.000Z");

  const written = await readFile(join(dir, "latest-mac.yml"), "utf8");
  // electron-updater derives the macOS channel as `latest` + `-mac`, so this
  // exact filename, without an architecture suffix, is what every Mac requests.
  assert.ok(
    written.includes("version: 0.15.15"),
    "the merged feed carries one version",
  );
  for (const file of [ARM64_DMG, ARM64_ZIP, X64_DMG, X64_ZIP]) {
    assert.ok(written.includes(file.url), `${file.url} survives the merge`);
  }
  assert.equal(
    written.split("\n").filter((line) => line.startsWith("  - url:")).length,
    4,
    "all four file entries are listed exactly once",
  );

  // Round-trip: the merged document parses back to the same feed.
  const reparsed = parseMacFeed(written, "latest-mac.yml");
  assert.equal(reparsed.version, "0.15.15");
  assert.deepEqual(
    reparsed.files.map((file) => file.url),
    [ARM64_DMG.url, ARM64_ZIP.url, X64_DMG.url, X64_ZIP.url],
  );
  assert.equal(reparsed.files[0].sha512, ARM64_DMG.sha512);
  assert.equal(reparsed.files[3].size, X64_ZIP.size);
});

test("electron-updater's architecture filter finds one match per Mac", async (t) => {
  const dir = await createFixture({
    "latest-mac-arm64.yml": feed({
      version: "0.15.15",
      files: [ARM64_DMG, ARM64_ZIP],
    }),
    "latest-mac-x64.yml": feed({ version: "0.15.15", files: [X64_DMG, X64_ZIP] }),
  });
  t.after(() => rm(dir, { recursive: true, force: true }));

  const { files } = buildMacUpdateFeed(dir);
  // MacUpdater.filterFilesForArch keeps entries whose url contains the user's
  // arch and, on x64, falls back to the first entry when nothing matches.
  const forArm64 = files.filter((file) => file.url.includes("arm64"));
  const forX64 = files.filter((file) => file.url.includes("x64"));
  assert.equal(forArm64.length, 2, "both arm64 artifacts are addressable");
  assert.equal(forX64.length, 2, "both x64 artifacts are addressable");
  assert.ok(
    forArm64.every((file) => !file.url.includes("x64")),
    "an arm64 Mac cannot be offered an x64 build",
  );
});

test("a single architecture still produces a complete feed", async (t) => {
  const dir = await createFixture({
    "latest-mac-arm64.yml": feed({
      version: "0.15.15",
      files: [ARM64_DMG, ARM64_ZIP],
    }),
  });
  t.after(() => rm(dir, { recursive: true, force: true }));

  const merged = mergeMacUpdateFeeds(dir);
  assert.deepEqual(merged.arches, ["arm64"]);
  assert.equal(merged.files.length, 2);
  const written = await readFile(join(dir, "latest-mac.yml"), "utf8");
  assert.ok(written.includes(ARM64_DMG.url));
});

test("refuses to publish with no lane feed at all", async (t) => {
  const dir = await createFixture({});
  t.after(() => rm(dir, { recursive: true, force: true }));

  assert.throws(
    () => buildMacUpdateFeed(dir),
    (error) =>
      error instanceof MacFeedError && /no latest-mac-<arch>\.yml/.test(error.message),
  );
});

test("refuses to merge lanes built from different versions", async (t) => {
  const dir = await createFixture({
    "latest-mac-arm64.yml": feed({
      version: "0.15.15",
      files: [ARM64_DMG, ARM64_ZIP],
    }),
    "latest-mac-x64.yml": feed({ version: "0.15.14", files: [X64_DMG, X64_ZIP] }),
  });
  t.after(() => rm(dir, { recursive: true, force: true }));

  assert.throws(
    () => buildMacUpdateFeed(dir),
    (error) =>
      error instanceof MacFeedError &&
      /latest-mac-x64\.yml declares version 0\.15\.14/.test(error.message),
  );
});

test("refuses to publish an artifact listed by two lanes", async (t) => {
  const dir = await createFixture({
    "latest-mac-arm64.yml": feed({
      version: "0.15.15",
      files: [ARM64_DMG, ARM64_ZIP],
    }),
    "latest-mac-x64.yml": feed({ version: "0.15.15", files: [ARM64_DMG, X64_DMG] }),
  });
  t.after(() => rm(dir, { recursive: true, force: true }));

  assert.throws(
    () => buildMacUpdateFeed(dir),
    (error) =>
      error instanceof MacFeedError && /appears in more than one feed/.test(error.message),
  );
});

test("rejects a file entry missing the size electron-updater needs", () => {
  const source = [
    "version: 0.15.15",
    "files:",
    `  - url: ${ARM64_DMG.url}`,
    `    sha512: ${ARM64_DMG.sha512}`,
    "",
  ].join("\n");

  assert.throws(
    () => parseMacFeed(source, "latest-mac-arm64.yml"),
    (error) =>
      error instanceof MacFeedError && /has no size/.test(error.message),
  );
});

test("rejects a file entry whose size is not a positive integer", () => {
  const source = [
    "version: 0.15.15",
    "files:",
    `  - url: ${ARM64_DMG.url}`,
    `    sha512: ${ARM64_DMG.sha512}`,
    "    size: not-a-number",
    "",
  ].join("\n");

  assert.throws(
    () => parseMacFeed(source, "latest-mac-arm64.yml"),
    (error) =>
      error instanceof MacFeedError && /has a non-numeric size/.test(error.message),
  );
});

test("rejects a feed without a version", () => {
  const source = [
    "files:",
    `  - url: ${ARM64_DMG.url}`,
    `    sha512: ${ARM64_DMG.sha512}`,
    `    size: ${ARM64_DMG.size}`,
    "",
  ].join("\n");

  assert.throws(
    () => parseMacFeed(source, "latest-mac-arm64.yml"),
    (error) => error instanceof MacFeedError && /no version/.test(error.message),
  );
});

test("renderMacUpdateFeed keeps path and sha512 self-consistent with files", () => {
  const rendered = renderMacUpdateFeed({
    version: "0.15.15",
    files: [ARM64_DMG, X64_DMG],
    releaseDate: "2026-10-03T10:05:00.000Z",
    arches: ["arm64", "x64"],
  });

  const reparsed = parseMacFeed(rendered, "latest-mac.yml");
  // resolveFiles prefers `files`, but a consumer reading `path`/`sha512` must
  // not be handed a value that contradicts the list.
  assert.equal(reparsed.path, ARM64_DMG.url);
  assert.equal(reparsed.sha512, ARM64_DMG.sha512);
  assert.equal(reparsed.releaseDate, "2026-10-03T10:05:00.000Z");
});

test("the command line writes the feed and reports what it merged", async (t) => {
  const dir = await createFixture({
    "latest-mac-arm64.yml": feed({
      version: "0.15.15",
      files: [ARM64_DMG, ARM64_ZIP],
    }),
    "latest-mac-x64.yml": feed({ version: "0.15.15", files: [X64_DMG, X64_ZIP] }),
  });
  t.after(() => rm(dir, { recursive: true, force: true }));

  const stdout = execFileSync(process.execPath, [SCRIPT, dir], { encoding: "utf8" });
  assert.match(stdout, /wrote latest-mac\.yml from arm64 \+ x64 \(version 0\.15\.15, 4 files\)/);
  const written = await readFile(join(dir, "latest-mac.yml"), "utf8");
  assert.ok(written.includes(X64_ZIP.url));
});

test("the command line fails a release whose directory has no macOS feed", async (t) => {
  const dir = await createFixture({});
  t.after(() => rm(dir, { recursive: true, force: true }));

  assert.throws(
    () => execFileSync(process.execPath, [SCRIPT, dir], { encoding: "utf8", stdio: "pipe" }),
    (error) => {
      assert.equal(error.status, 1, "the release must stop, not publish a partial feed");
      assert.match(String(error.stderr), /refusing to publish without a macOS feed/);
      return true;
    },
  );
});
