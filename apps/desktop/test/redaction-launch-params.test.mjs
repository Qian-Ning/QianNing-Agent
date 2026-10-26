/**
 * The launch payload decides whether a session redacts at all.
 *
 * Two of the three states matter more than the enabled one: an absent setting
 * and an explicit `false` must both produce no binding, because the sidecar
 * treats a present binding as "open the token table". Deriving the parameters
 * from the settings object in one place is what keeps that true.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

const { redactionLaunchParams } = await import("../electron/main/runtime/session-launch.ts");

const DATA_DIR = join("/srv", "qianning");

test("an absent setting launches no redaction binding", () => {
  assert.equal(redactionLaunchParams({}, DATA_DIR), undefined);
});

test("an explicit false launches no redaction binding", () => {
  assert.equal(redactionLaunchParams({ redaction: { enabled: false } }, DATA_DIR), undefined);
});

test("enabled points at the redaction directory under the data directory", () => {
  assert.deepEqual(redactionLaunchParams({ redaction: { enabled: true } }, DATA_DIR), {
    dir: join(DATA_DIR, "redaction"),
  });
});
