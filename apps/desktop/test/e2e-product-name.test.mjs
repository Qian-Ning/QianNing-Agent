import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { APP_NAME } from "@pi-desktop/shared";

const REPOSITORY_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const SCRIPTS = join(REPOSITORY_ROOT, "scripts");

/**
 * `scripts/e2e-electron-boot.mjs` compared the boot probe's `appName` against
 * the literal `"PI-Desktop"`. After the rename that gate was false for every
 * run, and because `pnpm test:e2e:boot` is not wired to a workflow, nothing
 * failed — the smoke test simply reported FAIL forever. The app name now comes
 * from `APP_NAME`, so these tests keep a literal from coming back.
 */
function e2eScriptPaths() {
  const paths = readdirSync(SCRIPTS)
    .filter((name) => /^e2e-.*\.mjs$/.test(name))
    .map((name) => join(SCRIPTS, name));
  for (const name of readdirSync(join(SCRIPTS, "e2e"))) {
    if (name.endsWith(".mjs")) paths.push(join(SCRIPTS, "e2e", name));
  }
  return paths;
}

const e2eScripts = e2eScriptPaths().map((path) => ({
  name: path.slice(SCRIPTS.length + 1).replaceAll("\\", "/"),
  source: readFileSync(path, "utf8"),
}));

test("the app name has exactly one source of truth", () => {
  // `app.getName()` — which the boot probe reports — returns what the main
  // process set here.
  const main = readFileSync(
    join(REPOSITORY_ROOT, "apps/desktop/electron/main/index.ts"),
    "utf8",
  );
  assert.match(
    main,
    /app\.setName\(APP_NAME\)/,
    "electron/main names the app from the shared APP_NAME constant",
  );

  // A CDP page target's `title` is the renderer document title.
  const html = readFileSync(join(REPOSITORY_ROOT, "apps/desktop/index.html"), "utf8");
  const title = html.match(/<title>([^<]*)<\/title>/)?.[1]?.trim();
  assert.equal(title, APP_NAME, "the renderer document title is the product name");
});

test("no end-to-end script hardcodes the product name", () => {
  assert.ok(e2eScripts.length > 5, "the end-to-end scripts were discovered");
  const offenders = e2eScripts
    .filter(({ source }) => /"PI-Desktop"|'PI-Desktop'/.test(source))
    .map(({ name }) => name);
  assert.deepEqual(
    offenders,
    [],
    "compare against APP_NAME instead of a product-name literal",
  );
});

test("end-to-end scripts that compare the app identity use APP_NAME", () => {
  const cases = [
    { name: "e2e-electron-boot.mjs", assertion: /probe\.appName === APP_NAME/ },
    { name: "e2e-plan-ui.mjs", assertion: /target\.title === APP_NAME/ },
  ];
  for (const { name, assertion } of cases) {
    const script = e2eScripts.find((entry) => entry.name === name);
    assert.ok(script, `${name} exists`);
    assert.match(
      script.source,
      /import \{ APP_NAME \} from "\.\.\/packages\/shared\/dist\/protocol\.js"/,
      `${name} imports APP_NAME from the shared protocol constants`,
    );
    assert.match(script.source, assertion, `${name} asserts against APP_NAME`);
  }
});
