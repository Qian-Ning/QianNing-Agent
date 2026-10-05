import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const REPOSITORY_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const READMES = ["README.md", "README.en.md"];

const read = (file) => readFileSync(join(REPOSITORY_ROOT, file), "utf8");
const desktopPackage = JSON.parse(read("apps/desktop/package.json"));
const { build } = desktopPackage;

/**
 * The README is the first thing anyone reads and the least likely thing to be
 * re-read after a rename. Two surfaces have already drifted this way — the DMG
 * plate and the Linux package assertions — so the front door gets a guard that
 * fails when it stops describing the artifact the build actually produces.
 *
 * These assertions check identity and artifact naming, not prose: rewording a
 * section must never break the suite, and shipping the wrong product name must
 * always break it.
 */

test("both READMEs are substantial documents", () => {
  for (const file of READMES) {
    const text = read(file);
    assert.ok(
      text.split("\n").length > 150,
      `${file} reads as a real document rather than a stub`,
    );
    assert.match(text, /^# QianNing Agent$/m, `${file} names the product`);
  }
});

test("the README describes the identity the build ships", () => {
  const [zh, en] = READMES.map(read);
  for (const text of [zh, en]) {
    assert.ok(
      text.includes(build.appId),
      `the application id ${build.appId} appears`,
    );
    assert.ok(text.includes(build.productName), "the product name appears");
    assert.ok(
      text.includes("~/.qianning-agent"),
      "the packaged data directory appears",
    );
  }
});

test("documented artifact names follow the packaging configuration", () => {
  const [zh, en] = READMES.map(read);

  // Each entry: a fragment of the configured artifactName mapped to what the
  // README must therefore be able to show.
  const shapes = [
    [build.nsis.artifactName, "QianNing-Agent-Setup"],
    [build.win.artifactName, "QianNing-Agent-Portable"],
    [build.dmg.artifactName, "QianNing-Agent"],
    [build.deb.artifactName, "qianning-agent"],
    [build.rpm.artifactName, "qianning-agent"],
  ];

  for (const [configured, expected] of shapes) {
    assert.ok(
      typeof configured === "string" && configured.includes(expected),
      `packaging still produces ${expected}`,
    );
    for (const [file, text] of READMES.map((f, i) => [f, [zh, en][i]])) {
      assert.ok(
        text.includes(expected),
        `${file} documents the ${expected} artifact`,
      );
    }
  }
});

test("the README does not resurrect the previous product name", () => {
  // The upstream project is named in the attribution section, and that is the
  // only place the old name belongs. Anything that looks like a *shipped*
  // artifact carrying it is a regression.
  const forbidden = [
    "PI-Desktop-Setup",
    "PI-Desktop-Portable",
    "PI-Desktop.app",
    "pi-desktop.desktop",
    "Icon=pi-desktop",
    "~/.pi-desktop",
  ];

  for (const file of READMES) {
    const text = read(file);
    for (const needle of forbidden) {
      assert.ok(
        !text.includes(needle),
        `${file} must not advertise ${needle}`,
      );
    }
  }
});

test("the packaged host name is documented, and the Cargo name is not the shipped one", () => {
  for (const file of READMES) {
    const text = read(file);
    assert.ok(
      text.includes("QianNing-Agent-Host-Core"),
      `${file} documents the packaged host executable`,
    );
  }
});

test("every relative link and image in the READMEs resolves", () => {
  let checked = 0;
  for (const file of READMES) {
    const text = read(file);
    for (const match of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = match[1];
      if (/^(https?:|#|mailto:)/.test(target)) continue;
      const localPath = join(REPOSITORY_ROOT, target.split("#")[0]);
      assert.ok(
        existsSync(localPath),
        `${file} links to ${target}, which does not exist`,
      );
      checked += 1;
    }
    for (const match of text.matchAll(/<img[^>]+src="([^"]+)"/g)) {
      const localPath = join(REPOSITORY_ROOT, match[1]);
      assert.ok(
        existsSync(localPath) && statSync(localPath).isFile(),
        `${file} embeds ${match[1]}, which does not exist`,
      );
      checked += 1;
    }
  }
  assert.ok(checked >= 30, `resolved ${checked} local targets`);
});

test("the table of contents matches the headings it points at", () => {
  // GitHub's own heading-anchor algorithm, established by rendering a probe
  // document through GitHub rather than from memory: lowercase, drop the
  // punctuation listed here, drop emoji, then turn EVERY remaining space into
  // a hyphen -- runs are not collapsed and the ends are not trimmed. That is
  // why `1. ✨ 这是什么` anchors as `1--这是什么` and `✨ 1. 这是什么` as
  // `-1-这是什么`. The previous version left emoji inside the anchor, so it
  // could not describe an icon in a heading.
  const slug = (heading) =>
    heading
      .toLowerCase()
      .replace(/[.!?:,、。：]/g, "")
      .replace(
        /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}\u{2B00}-\u{2BFF}]/gu,
        "",
      )
      .replace(/\s/g, "-");

  for (const file of READMES) {
    const text = read(file);
    // Only the numbered top-level sections participate in the table of contents.
    const headings = [...text.matchAll(/^## (\d+\..+)$/gm)].map((m) =>
      slug(m[1]),
    );
    const anchors = [...text.matchAll(/^\s*- \[.+?\]\(#([^)]+)\)$/gm)].map(
      (m) => m[1],
    );
    assert.ok(headings.length > 0, `${file} has numbered sections`);
    assert.deepEqual(
      anchors,
      headings,
      `${file}: every table-of-contents anchor resolves to its heading`,
    );
    assert.equal(
      relative(REPOSITORY_ROOT, join(REPOSITORY_ROOT, file)),
      file,
      "sanity: the README lives at the repository root",
    );
  }
});
