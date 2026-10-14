import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  AUTHORING_SOURCE_PATHS,
  readSizeConstant,
} from "../../../scripts/skill-authoring-spec-check.mjs";

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

/**
 * The parameter schema and the contract are two mirrors of the same numbers, and a
 * mirror that drifts is worse than no mirror: host-core clips `name`, truncates
 * `description`, and rejects a document over its byte cap, so a model that writes
 * to the advertised budget has its work quietly altered or loudly refused. These
 * assertions read the caps out of the advertised schema and the enforcement
 * constants out of the files that hold them, then compare values, so neither side
 * can move alone.
 */
const toolSource = readFileSync(
  `${root}packages/agent-runtime/src/skill-authoring/tool.ts`,
  "utf8",
);
const userSkillsSource = readFileSync(
  `${root}${AUTHORING_SOURCE_PATHS.userSkills}`,
  "utf8",
);
const pluginRuntimeSource = readFileSync(
  `${root}${AUTHORING_SOURCE_PATHS.pluginRuntime}`,
  "utf8",
);

function advertisedCap(field) {
  const re = new RegExp(
    `${field}: (?:Type\\.Optional\\()?Type\\.String\\(\\{[^}]*maxLength: (\\d+)`,
  );
  const match = re.exec(toolSource);
  assert.ok(match, `SkillCreate declares no maxLength for \`${field}\``);
  return Number(match[1]);
}

test("SkillCreate advertises the contract's own limits, not approximations", () => {
  const nameCap = readSizeConstant(
    userSkillsSource,
    "MAX_NAME_CHARS",
    AUTHORING_SOURCE_PATHS.userSkills,
  );
  assert.ok(nameCap, "MAX_NAME_CHARS was not found in user_skills.rs");
  const descCap = readSizeConstant(
    pluginRuntimeSource,
    "MAX_SKILL_DESCRIPTION_CHARS",
    AUTHORING_SOURCE_PATHS.pluginRuntime,
  );
  assert.ok(descCap, "MAX_SKILL_DESCRIPTION_CHARS was not found in plugin-runtime.ts");
  const bytesCap = readSizeConstant(
    userSkillsSource,
    "MAX_SKILL_BYTES",
    AUTHORING_SOURCE_PATHS.userSkills,
  );
  assert.ok(bytesCap, "MAX_SKILL_BYTES was not found in user_skills.rs");

  assert.equal(advertisedCap("name"), nameCap, "`name` must advertise MAX_NAME_CHARS");
  assert.equal(
    advertisedCap("description"),
    descCap,
    "`description` must advertise MAX_SKILL_DESCRIPTION_CHARS",
  );

  // `maxLength` counts characters while host-core caps the document in bytes, so the
  // character cap has to be the byte cap divided by the widest UTF-8 encoding.
  // Anything larger lets the model write a document that passes the schema and then
  // dies on `SKILL_INVALID: document exceeds ... bytes`.
  assert.equal(
    advertisedCap("body"),
    Math.floor(bytesCap / 4),
    "`body` must be capped at MAX_SKILL_BYTES / 4 characters",
  );
});

