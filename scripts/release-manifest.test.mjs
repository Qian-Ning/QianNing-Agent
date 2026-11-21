import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CHECKSUM_FILE,
  MANIFEST_FILE,
  buildReleaseManifest,
  isSafeAssetName,
  parseUpdateFeed,
  verifyReleaseDirectory,
  writeReleaseManifest,
} from "./release-manifest.mjs";

const VERSION = "2.4.2";
const SETUP = `QianNing-Agent-Setup-${VERSION}.exe`;
const PORTABLE = `QianNing-Agent-Portable-${VERSION}.exe`;
const APPIMAGE = `QianNing.Agent-${VERSION}.AppImage`;
const DMG_ARM = `QianNing-Agent-${VERSION}-arm64.dmg`;
const DMG_X64 = `QianNing-Agent-${VERSION}-x64.dmg`;
const MAC_ZIP = `QianNing-Agent-${VERSION}-arm64-mac.zip`;

function digest(text, algorithm, encoding) {
  return createHash(algorithm).update(text).digest(encoding);
}

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "qn-release-manifest-"));
  const files = {
    [SETUP]: "setup-bytes",
    [PORTABLE]: "portable-bytes",
    [`${SETUP}.blockmap`]: "blockmap-bytes",
    [APPIMAGE]: "appimage-bytes",
    [`qianning-agent_${VERSION}_amd64.deb`]: "deb-bytes",
    [DMG_ARM]: "dmg-arm-bytes",
    [DMG_X64]: "dmg-x64-bytes",
    [MAC_ZIP]: "zip-arm-bytes",
  };
  for (const [name, contents] of Object.entries(files)) {
    await writeFile(join(dir, name), contents);
  }

  const entry = (name) => ({
    url: name,
    sha512: digest(files[name], "sha512", "base64"),
    size: Buffer.byteLength(files[name]),
  });
  const feed = (names) => {
    const lines = [`version: ${VERSION}`, "files:"];
    for (const name of names) {
      const item = entry(name);
      lines.push(`  - url: ${item.url}`, `    sha512: ${item.sha512}`, `    size: ${item.size}`);
    }
    lines.push(`path: ${names[0]}`, `sha512: ${digest(files[names[0]], "sha512", "base64")}`, "releaseDate: '2026-11-20T00:00:00.000Z'");
    return `${lines.join("\n")}\n`;
  };
  await writeFile(join(dir, "latest.yml"), feed([SETUP]));
  await writeFile(join(dir, "latest-linux.yml"), feed([APPIMAGE]));
  await writeFile(join(dir, "latest-mac.yml"), feed([DMG_ARM, DMG_X64]));

  const manifest = await buildReleaseManifest(dir, VERSION, {
    generatedAt: "2026-11-20T00:00:00.000Z",
    commit: "0123456789abcdef",
  });
  await writeReleaseManifest(dir, manifest);
  return { dir, files, manifest };
}

async function withFixture(t, run) {
  const { dir, files, manifest } = await fixture();
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  await run({ dir, files, manifest });
}

test("the manifest covers the payload and excludes its own outputs", async (t) => {
  await withFixture(t, async ({ dir, manifest }) => {
    const names = manifest.files.map((file) => file.name);
    assert.ok(names.includes(SETUP));
    assert.ok(names.includes("latest.yml"));
    assert.ok(names.includes("latest-linux.yml"));
    assert.ok(names.includes("latest-mac.yml"));
    assert.ok(!names.includes(MANIFEST_FILE));
    assert.ok(!names.includes(CHECKSUM_FILE));

    for (const file of manifest.files) {
      assert.equal(file.sha256.length, 64);
      assert.equal(Buffer.from(file.sha512, "base64").length, 64);
      assert.ok(file.size > 0);
    }

    const sums = await readFile(join(dir, CHECKSUM_FILE), "utf8");
    assert.match(sums, /release-manifest\.json/);
  });
});

test("a complete staged release verifies", async (t) => {
  await withFixture(t, async ({ dir }) => {
    const result = await verifyReleaseDirectory(dir, { version: VERSION });
    assert.deepEqual(result.errors, []);
    assert.equal(result.ok, true);
    assert.ok(result.checked.includes(SETUP));
  });
});

test("a payload size change fails before hashing", async (t) => {
  await withFixture(t, async ({ dir }) => {
    await writeFile(join(dir, SETUP), "setup-bytes-plus");
    const result = await verifyReleaseDirectory(dir, { version: VERSION });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.includes(`${SETUP}: size`)));
  });
});

test("a same-size payload mutation fails sha256 and sha512", async (t) => {
  await withFixture(t, async ({ dir }) => {
    await writeFile(join(dir, SETUP), "setup-byteS");
    const result = await verifyReleaseDirectory(dir, { version: VERSION });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.includes(`${SETUP}: sha256 mismatch`)));
    assert.ok(result.errors.some((error) => error.includes(`${SETUP}: sha512 mismatch`)));
  });
});

test("a feed declaring another version fails", async (t) => {
  await withFixture(t, async ({ dir }) => {
    const text = await readFile(join(dir, "latest.yml"), "utf8");
    await writeFile(join(dir, "latest.yml"), text.replace(`version: ${VERSION}`, "version: 9.9.9"));
    const result = await verifyReleaseDirectory(dir, { version: VERSION });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.includes("latest.yml: declares version 9.9.9")));
  });
});

test("a feed referencing a file outside the manifest fails", async (t) => {
  await withFixture(t, async ({ dir }) => {
    const text = await readFile(join(dir, "latest.yml"), "utf8");
    await writeFile(join(dir, "latest.yml"), text.replace(SETUP, "ghost-Setup.exe"));
    const result = await verifyReleaseDirectory(dir, { version: VERSION });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.includes("references ghost-Setup.exe")));
  });
});

test("an unexpected asset in the release directory fails", async (t) => {
  await withFixture(t, async ({ dir }) => {
    await writeFile(join(dir, "stray.txt"), "not in the manifest");
    const result = await verifyReleaseDirectory(dir, { version: VERSION });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.includes("unexpected asset stray.txt")));
  });
});

test("a stale checksum line fails", async (t) => {
  await withFixture(t, async ({ dir }) => {
    const sums = await readFile(join(dir, CHECKSUM_FILE), "utf8");
    const lines = sums.split("\n");
    const index = lines.findIndex((line) => line.endsWith(`  ${SETUP}`));
    assert.ok(index >= 0);
    lines[index] = `${"0".repeat(64)}  ${SETUP}`;
    await writeFile(join(dir, CHECKSUM_FILE), lines.join("\n"));
    const result = await verifyReleaseDirectory(dir, { version: VERSION });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.includes(`${CHECKSUM_FILE}: sha256 mismatch for ${SETUP}`)));
  });
});

test("an unexpected checksum line fails", async (t) => {
  await withFixture(t, async ({ dir }) => {
    const sums = await readFile(join(dir, CHECKSUM_FILE), "utf8");
    await writeFile(join(dir, CHECKSUM_FILE), `${sums}${"0".repeat(64)}  stray.bin\n`);
    const result = await verifyReleaseDirectory(dir, { version: VERSION });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.includes("checksum for unexpected file stray.bin")));
  });
});

test("a manifest version mismatch fails", async (t) => {
  await withFixture(t, async ({ dir }) => {
    const result = await verifyReleaseDirectory(dir, { version: "9.9.9" });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.includes("manifest declares version 2.4.2, expected 9.9.9")));
  });
});

test("parseUpdateFeed rejects an unsafe url and a short digest", () => {
  assert.throws(
    () => parseUpdateFeed(`version: ${VERSION}\nfiles:\n  - url: ../escape.exe\n    sha512: ${"A".repeat(88)}\n    size: 1\n`, "bad"),
    /unsafe asset url/,
  );
  assert.throws(
    () => parseUpdateFeed(`version: ${VERSION}\nfiles:\n  - url: x.exe\n    sha512: abc\n    size: 0\n`, "bad"),
    /non-sha512 digest|non-numeric size/,
  );
});

test("safe asset names are single, non-hidden basenames", () => {
  assert.equal(isSafeAssetName(SETUP), true);
  assert.equal(isSafeAssetName("../escape.exe"), false);
  assert.equal(isSafeAssetName("nested/file.exe"), false);
  assert.equal(isSafeAssetName("nested\\file.exe"), false);
  assert.equal(isSafeAssetName(".hidden"), false);
  assert.equal(isSafeAssetName(""), false);
});
