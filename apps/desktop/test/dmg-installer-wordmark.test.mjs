import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const REPOSITORY_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const SCRIPTS = join(REPOSITORY_ROOT, "scripts");

const dmgScript = readFileSync(
  join(SCRIPTS, "make-dmg-background.py"),
  "utf8",
);
const packageJson = JSON.parse(
  readFileSync(join(REPOSITORY_ROOT, "apps/desktop/package.json"), "utf8"),
);

/**
 * The DMG plate shipped the wordmark `PI-Desktop` for the whole life of the
 * rebrand. Nothing caught it: the PNG is committed, packaging never regenerates
 * it, and the script's macOS-only font paths degrade to a bitmap default, so a
 * stale plate still looked plausible. ADR 0296 forbids hand-editing the PNG
 * pair, so the fix has to come from the script — and the script has to stop
 * carrying its own copy of the product name.
 */
test("the DMG script takes the wordmark from the product configuration", () => {
  assert.match(
    dmgScript,
    /json\.load\(_f\)\["build"\]\["productName"\]/,
    "the script reads build.productName from apps/desktop/package.json",
  );
  assert.match(
    dmgScript,
    /^\s{4}title = PRODUCT_NAME$/m,
    "the wordmark is the product name, not a literal",
  );
  assert.equal(
    packageJson.build.productName,
    "QianNing Agent",
    "build.productName is the name the plate will carry",
  );
});

test("no Python script hardcodes a product name", () => {
  const scripts = readdirSync(SCRIPTS).filter((name) => name.endsWith(".py"));
  assert.ok(scripts.length >= 3, "the Python scripts were discovered");
  const offenders = scripts.filter((name) =>
    /PI-Desktop|pi-desktop/.test(readFileSync(join(SCRIPTS, name), "utf8")),
  );
  assert.deepEqual(
    offenders,
    [],
    "derive the name from package.json instead of writing it into a generator",
  );
});

/**
 * The committed plate is the macOS rendering, and the script is the only way it
 * is allowed to be produced (ADR 0296 §3). The brand faces therefore have to be
 * the first candidate in each chain, and the chain mechanism itself has to
 * exist — a single hardcoded path was what silently degraded the wordmark to a
 * bitmap font on any other machine.
 */
test("the DMG script resolves fonts through brand-first candidate chains", () => {
  const chainOf = (name) => {
    const lines = dmgScript.split("\n");
    const start = lines.findIndex((line) => line.startsWith(`${name}:`));
    assert.ok(start !== -1, `${name} is defined`);
    const end = lines.findIndex((line, index) => index > start && line.trim() === ")");
    assert.ok(end !== -1, `${name} is a closed tuple`);
    return lines.slice(start, end + 1);
  };

  for (const [name, faces] of [
    ["TITLE_FACES", "HelveticaNeue.ttc"],
    ["CAPTION_FACES", "HelveticaNeue.ttc"],
    ["CJK_FACES", "Hiragino Sans GB.ttc"],
  ]) {
    const block = chainOf(name);
    const entries = block
      .filter((line) => line.includes('("'))
      .map((line) => line.match(/"([^"]+)"/)?.[1]);
    assert.ok(entries.length >= 2, `${name} carries a fallback chain`);
    assert.ok(
      entries[0]?.startsWith("/System/Library/Fonts/"),
      `${name} leads with a macOS face, got ${entries[0]}`,
    );
    assert.ok(
      entries[0]?.includes(faces),
      `${name} leads with ${faces}`,
    );
  }

  assert.match(
    dmgScript,
    /def _font\(\s*faces: tuple\[tuple\[str, int\], \.\.\.\],/,
    "the font helper takes a candidate chain",
  );
  assert.match(
    dmgScript,
    /for path, index in faces:/,
    "the font helper walks the chain instead of falling back to a bitmap font",
  );
});

test("the script is the only producer of the committed plate", () => {
  // ADR 0296 §3.
  assert.equal(
    packageJson.build.dmg.background,
    "build/dmg-background.png",
    "electron-builder consumes the generated 1x plate",
  );
  const adr = readFileSync(
    join(REPOSITORY_ROOT, "docs/adr/0296-macos-signed-dmg-two-icon-install.md"),
    "utf8",
  );
  assert.match(adr, /Do not hand-edit the PNG pair/);
  assert.match(adr, /make-dmg-background\.py/);
});
