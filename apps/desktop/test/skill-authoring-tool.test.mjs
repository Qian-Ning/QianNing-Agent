import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

/**
 * A tool exists in two halves: the catalogue that advertises it to the model, and
 * a handler in every host that can serve it. Either half alone is a bug — a
 * catalogue entry with no handler offers the model a tool that always fails, and
 * a handler with no entry is dead code. These assertions pin both halves and the
 * places they must agree.
 */

const root = new URL("../../../", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const runtimeSource = readFileSync(
  `${root}packages/agent-runtime/src/runtime.ts`,
  "utf8",
);
const desktopSidecar = readFileSync(
  `${root}apps/desktop/electron/main/runtime/sidecar.ts`,
  "utf8",
);
const hostApp = readFileSync(`${root}apps/pi-host/src/app.ts`, "utf8");

test("the tool catalogue advertises SkillCreate with a name and a body", () => {
  assert.match(runtimeSource, /SkillCreate: skillCreateParameters/);
  assert.match(runtimeSource, /toolName === "SkillCreate"/);
  assert.match(runtimeSource, /skillCreateDescription/);
});

test("SkillCreate is a write tool, so it is advertised in agent mode only", () => {
  const line = runtimeSource
    .split("\n")
    .find((l) => l.includes("tools.push(") && l.includes("PluginPack"));
  assert.ok(line, "the agent-mode tool list was not found");
  assert.ok(line.includes("SkillCreate"), `agent-mode list is missing SkillCreate: ${line}`);
});

test("every host that builds the catalogue registers the handler", () => {
  assert.match(desktopSidecar, /registerSkillAuthoringTools\(/);
  assert.match(hostApp, /registerSkillAuthoringTools\(/);
});

test("both hosts reach the same host-core create path", () => {
  const desktop = desktopSidecar.slice(desktopSidecar.indexOf("registerSkillAuthoringTools("));
  assert.ok(desktop.includes('"skills.create"'), "desktop host does not call skills.create");
  const headless = hostApp.slice(hostApp.indexOf("registerSkillAuthoringTools("));
  assert.ok(headless.includes('"skills.create"'), "headless host does not call skills.create");
});

test("the handler implementation is shared, not duplicated per host", () => {
  const shared = readFileSync(
    `${root}packages/host-runtime/src/skill-authoring-tools.ts`,
    "utf8",
  );
  assert.match(shared, /setLocalTool\("SkillCreate"/);
  assert.ok(
    !desktopSidecar.includes('setLocalTool("SkillCreate"'),
    "the desktop app must not define its own SkillCreate handler",
  );
  assert.ok(
    !hostApp.includes('setLocalTool("SkillCreate"'),
    "the headless host must not define its own SkillCreate handler",
  );
});
