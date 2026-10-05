import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import {
  classifyClickEffect,
  classifyFillEffect,
} from "../electron/main/browser-cdp.ts";

const cdpSource = readFileSync(resolve("electron/main/browser-cdp.ts"), "utf8");
const runtimeSource = readFileSync(resolve("electron/main/plugin-runtime.ts"), "utf8");
const pluginSource = readFileSync(
  resolve("resources/plugins/pi.browser/main.js"),
  "utf8",
);

/** The `case "<action>":` block of the plugin's execute switch. */
function pluginCase(action) {
  const start = pluginSource.indexOf(`case "${action}":`);
  assert.notEqual(start, -1, `plugin has no case "${action}"`);
  const rest = pluginSource.slice(start + 1);
  const end = rest.indexOf("\n        case ");
  return end === -1 ? rest : rest.slice(0, end);
}

test("the effect vocabulary is the closed set the tool documents", () => {
  assert.match(
    cdpSource,
    /export type BrowserEffect =\s*\n?\s*"confirmed" \| "unverifiable" \| "suspected_noop" \| "refused";/,
  );
  // No fifth value may be introduced without the spec and the tool text moving
  // with it, so the union is asserted whole rather than by substring.
  assert.doesNotMatch(cdpSource, /BrowserEffect =[^;]*"partial"/);
});

test("a disabled control is refused before anything is dispatched", () => {
  const verdict = classifyClickEffect(true);
  assert.equal(verdict.effect, "refused");
  assert.equal(verdict.verified, false);
  assert.equal(verdict.code, "ELEMENT_DISABLED");
  assert.equal(verdict.escalation?.recommended, "snapshot");
  assert.ok(verdict.escalation?.reason);

  // The refusal has to come back before the first input event, or the click
  // was sent anyway and the code is a lie.
  const body = cdpSource.slice(cdpSource.indexOf("async click("));
  const guard = body.indexOf('if (verdict.effect === "refused") return verdict;');
  const dispatch = body.indexOf('sendCommand("Input.dispatchMouseEvent"');
  assert.notEqual(guard, -1, "click has no refusal guard");
  assert.notEqual(dispatch, -1, "click has no dispatch");
  assert.ok(guard < dispatch, "the refusal must precede the input dispatch");
});

test("a dispatched click is unverifiable rather than reported as success", () => {
  const verdict = classifyClickEffect(false);
  assert.equal(verdict.effect, "unverifiable");
  assert.equal(verdict.verified, false);
  assert.equal(verdict.code, undefined);
  assert.equal(verdict.escalation?.recommended, "snapshot");
});

test("an exact read-back confirms a fill", () => {
  const verdict = classifyFillEffect("status: ready", "status: ready");
  assert.equal(verdict.effect, "confirmed");
  assert.equal(verdict.verified, true);
  assert.equal(verdict.observed, "status: ready");
  assert.equal(verdict.escalation, undefined);
});

test("a field left empty is a suspected no-op, and a changed one is unverified", () => {
  const empty = classifyFillEffect("status: ready", "");
  assert.equal(empty.effect, "suspected_noop");
  assert.equal(empty.verified, false);
  assert.equal(empty.escalation?.recommended, "evaluate");

  // A read-back that returned nothing usable is the same evidence as an empty
  // field: the requested text is not there.
  const none = classifyFillEffect("status: ready", null);
  assert.equal(none.effect, "suspected_noop");

  // Something else is not nothing: the field kept a value, just not this one.
  const other = classifyFillEffect("status: ready", "status: READY");
  assert.equal(other.effect, "unverifiable");
  assert.equal(other.verified, false);
  assert.equal(other.observed, "status: READY");
});

test("fill asks the page for its value instead of assuming the write landed", () => {
  assert.match(cdpSource, /returnByValue: true/);
  assert.match(cdpSource, /return classifyFillEffect\(\s*text,/);
  // The read-back is the page's own value, not the argument echoed back.
  assert.match(cdpSource, /typeof applied\.result\?\.value === "string"/);
});

test("the plugin reports an effect for every mutating action and no read-only one", () => {
  assert.match(pluginCase("navigate"), /\.\.\.navigateEffect\(state\)/);
  assert.match(pluginCase("click"), /\.\.\.effectOf\(/);
  assert.match(pluginCase("fill"), /\.\.\.effectOf\(/);
  assert.match(pluginCase("evaluate"), /effect: "confirmed"/);
  assert.match(pluginCase("evaluate"), /verified: true/);
  assert.match(pluginCase("cdp"), /effect: "unverifiable"/);
  assert.match(pluginCase("cdp"), /verified: false/);

  for (const readOnly of ["snapshot", "screenshot", "console"]) {
    assert.doesNotMatch(pluginCase(readOnly), /effect/, `${readOnly} observes the page`);
  }
});

test("the bridge forwards the click and fill result instead of dropping it", () => {
  assert.match(runtimeSource, /click: \(uid: string\) => Promise<unknown>;/);
  assert.match(runtimeSource, /fill: \(uid: string, text: string\) => Promise<unknown>;/);
  assert.match(runtimeSource, /return this\.services\.browser\.click\(uid\);/);
  assert.match(runtimeSource, /return this\.services\.browser\.fill\(uid, text\);/);
});
