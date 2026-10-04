import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

// The three screenshot stores are generated, never hand-made, and the scene
// lists in scripts/publish-screenshots.py are the only thing deciding what gets
// generated. That list rotted once: it kept naming `pulls-live`/`dark-pulls`
// after ADR 0308 removed the destination and `panel-menu` after the work panel
// lost its overflow menu. `publish()` refuses to run when a listed scene has no
// frame, so the committed gallery sat frozen while the shell moved on, and the
// docs-site hero kept showing a screenshot of the maintainer's own machine.
// These assertions are what stops that from happening again.

const root = new URL("../../../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

const RIG = "apps/desktop/electron/main/bootstrap/window.ts";
const PUBLISH = "scripts/publish-screenshots.py";
const LOCALES = ["en", "zh"];

const [rigSource, publisher] = await Promise.all([read(RIG), read(PUBLISH)]);

/** Scene ids the capture rig actually writes, without the "pi-" prefix. */
function rigScenes() {
  return new Set(
    [...rigSource.matchAll(/await shot\("pi-([a-z0-9-]+)"\)/g)].map((match) => match[1]),
  );
}

/** Quoted strings inside a tuple or dict literal in the publisher. */
function literalBlock(name, opener, closer) {
  const start = publisher.indexOf(`${name} = ${opener}`);
  assert.notEqual(start, -1, `${name} missing from ${PUBLISH}`);
  const end = publisher.indexOf(closer, start);
  assert.notEqual(end, -1, `${name} in ${PUBLISH} is not closed`);
  return publisher.slice(start + name.length, end);
}

function tupleEntries(name) {
  return [...literalBlock(name, "(", ")").matchAll(/"([a-z0-9-]+)"/g)].map((m) => m[1]);
}

function dictEntries(name) {
  const block = literalBlock(name, "{", "}");
  return [...block.matchAll(/"([a-z0-9-]+)":\s*"([a-z0-9-]+)"/g)].map((m) => [m[1], m[2]]);
}

const scenes = tupleEntries("SCENES");
const readmeShots = dictEntries("README_SHOTS");
const landingShots = dictEntries("LANDING_SHOTS");

test("every published scene has a frame the capture rig writes", () => {
  const produced = rigScenes();
  assert.ok(produced.size > 30, "rig scene extraction found suspiciously few shots");
  const orphans = [...scenes, ...readmeShots.map(([s]) => s), ...landingShots.map(([s]) => s)]
    .filter((scene) => !produced.has(scene));
  assert.deepEqual(orphans, [], "publisher lists scenes the rig never writes");
});

test("scene lists have no duplicates and every slot maps to one file stem", () => {
  assert.equal(new Set(scenes).size, scenes.length, "SCENES has duplicate entries");
  for (const name of ["README_SHOTS", "LANDING_SHOTS"]) {
    const used = name === "README_SHOTS" ? readmeShots : landingShots;
    assert.equal(new Set(used.map(([scene]) => scene)).size, used.length, `${name} repeats a scene`);
  }
  const stems = [...readmeShots, ...landingShots].map(([, stem]) => stem);
  assert.ok(stems.includes("hero"), "the landing hero slot is not declared");
});

test("no scene id carries the language; only the file suffix does", () => {
  for (const scene of scenes) {
    assert.doesNotMatch(scene, /-(en|zh)$/, `${scene} encodes the locale in the scene id`);
  }
});

test("the gallery pages reference frames the publisher generates", async () => {
  const known = new Set(scenes);
  for (const page of ["docs/guide/screenshots.md", "docs/zh-CN/guide/screenshots.md"]) {
    const source = await read(page);
    const referenced = [
      ...source.matchAll(/screenshots\/app\/(en|zh)\/([a-z0-9-]+)\.webp/g),
    ];
    assert.ok(referenced.length > 30, `${page} referenced suspiciously few frames`);
    for (const [, locale, scene] of referenced) {
      assert.ok(LOCALES.includes(locale), `${page} references locale ${locale}`);
      assert.ok(known.has(scene), `${page} references ${scene}, which the publisher never generates`);
    }
  }
});

test("the landing components reference only declared slots", async () => {
  const declared = new Set(landingShots.map(([, stem]) => stem));
  const modules = await read("docs/.vitepress/theme/components/HomeModules.vue");
  const hero = await read("docs/.vitepress/theme/components/HomeHeroVisual.vue");

  const slugs = [...modules.matchAll(/shot\('([^']+)'\)/g)].map((match) => match[1]);
  assert.ok(slugs.length > 8, "HomeModules.vue slot extraction found suspiciously few usages");
  for (const slug of slugs) {
    assert.ok(declared.has(slug), `HomeModules.vue references undeclared slot ${slug}`);
    assert.doesNotMatch(slug, /\./, `HomeModules.vue slot ${slug} hardcodes a filename`);
  }
  assert.match(hero, /readme\/hero\.\$\{/, "HomeHeroVisual.vue must resolve the hero by locale");
});

test("the front pages embed frames the publisher generates", async () => {
  const readmeStems = new Set(readmeShots.map(([, stem]) => stem));
  const pages = [
    ["README.en.md", "en"],
    ["README.md", "zh"],
  ];
  for (const [page, locale] of pages) {
    const source = await read(page);
    const used = [...source.matchAll(/docs\/image\/readme\/([a-z0-9-]+)\.(en|zh)\.webp/g)];
    assert.ok(used.length >= 3, `${page} embeds suspiciously few screenshots`);
    for (const [, stem, suffix] of used) {
      assert.equal(suffix, locale, `${page} embeds the ${suffix} frame of ${stem}`);
      assert.ok(readmeStems.has(stem), `${page} embeds undeclared stem ${stem}`);
    }
  }
});

test("no two published frames are byte-identical", async () => {
  // The rig fires a shot even when the step before it did nothing, so a scene
  // whose UI interaction stopped working silently republishes the previous
  // frame under a new caption. Five scenes were doing exactly that before this
  // assertion existed; see the SCENES comment in the publisher.
  const seen = new Map();
  for (const locale of LOCALES) {
    for (const scene of scenes) {
      const bytes = await readFile(
        new URL(`docs/public/screenshots/app/${locale}/${scene}.webp`, root),
      );
      const digest = createHash("sha256").update(bytes).digest("hex");
      const key = `${locale}:${digest}`;
      const previous = seen.get(key);
      assert.equal(
        previous,
        undefined,
        `${locale}: ${scene} is byte-identical to ${previous}`,
      );
      seen.set(key, scene);
    }
  }
});

test("the screenshot stores hold exactly the generated set", async () => {
  const listing = async (dir) =>
    (await readdir(new URL(dir, root))).filter((name) => name.endsWith(".webp")).sort();

  const expected = (pairs) =>
    pairs
      .flatMap(([, stem]) => LOCALES.map((locale) => `${stem}.${locale}.webp`))
      .sort();

  assert.deepEqual(await listing("docs/public/readme"), expected(landingShots));
  assert.deepEqual(await listing("docs/image/readme"), expected(readmeShots));
  for (const locale of LOCALES) {
    assert.deepEqual(
      await listing(`docs/public/screenshots/app/${locale}`),
      [...scenes].map((scene) => `${scene}.webp`).sort(),
    );
  }
});
