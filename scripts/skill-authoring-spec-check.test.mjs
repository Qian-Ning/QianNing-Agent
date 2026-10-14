/**
 * Self-test for the skill authoring spec gate.
 *
 * The gate's value is entirely in what it rejects. A check that prints a verdict
 * without failing is not a gate, so the negative cases below are the substance
 * here: each one removes or changes a single thing and asserts the gate notices.
 *
 * Two kinds of case:
 *   - synthetic sources and documents, which exercise one rule each;
 *   - the real repository files, which prove the spec as committed passes.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  AUTHORING_SOURCE_PATHS,
  AUTHORING_SPEC_PATHS,
  checkSkillAuthoringSpec,
} from "./skill-authoring-spec-check.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

/** Minimal stand-ins carrying the four constants, in their real syntax. */
const SOURCES = {
  userSkills: [
    "pub const MAX_SKILL_BYTES: usize = 128 * 1024;",
    "const MAX_NAME_CHARS: usize = 120;",
    "        let id = capability_id(&name, &path, 64);",
  ].join("\n"),
  agentCapabilities: "pub fn parse_front_matter(raw: &str) {}",
  pluginRuntime: "const MAX_SKILL_DESCRIPTION_CHARS = 240;",
  skillCatalog: "const SKILL_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;",
};

/** A document that states every number, in both locales, plus the claims. */
function doc({ kib = "128", bytes = "131,072", name = "120", desc = "240", id = "64", pattern = "^[a-z0-9][a-z0-9-]{0,63}$", locale = "en" } = {}) {
  const versionClaim = locale === "en" ? "not consumed by host-core" : "host-core 不消费它";
  return [
    "# 17. Skill Authoring",
    `| Document size | **${kib} KiB** (${bytes} bytes) |`,
    `| name | **${name} characters** |`,
    `| description | **${desc} characters** |`,
    `| id | **${id} characters** |`,
    `| pattern | \`${pattern}\` |`,
    `version is ${versionClaim}; it does not bind a revision.`,
    "scripts/check-skill-provenance.mjs",
    "scripts/check-skill-authoring-spec.mjs",
    "apps/desktop/test/builtin-skill-discovery.test.mjs",
    "crates/host-core/src/user_skills/tests.rs",
  ].join("\n");
}

/** Baseline: a matching pair, which must report nothing. */
test("a document matching the code reports no problems", () => {
  const problems = checkSkillAuthoringSpec({
    docEn: doc(),
    docZh: doc({ locale: "zh" }),
    sources: { ...SOURCES },
  });
  assert.deepEqual(problems, []);
});

// ---------------------------------------------------------------------------
// Negative cases: the document moves, the code does not.
// ---------------------------------------------------------------------------

test("a wrong name limit in the English spec is rejected", () => {
  const problems = checkSkillAuthoringSpec({
    docEn: doc({ name: "160" }),
    docZh: doc({ locale: "zh" }),
    sources: { ...SOURCES },
  });
  assert.ok(problems.some((p) => p.includes("the name limit (120 characters)")), problems.join("; "));
});

test("a wrong description limit in the Chinese spec is rejected", () => {
  const problems = checkSkillAuthoringSpec({
    docEn: doc(),
    docZh: doc({ locale: "zh", desc: "200" }),
    sources: { ...SOURCES },
  });
  assert.ok(problems.some((p) => p.startsWith("Chinese spec") && p.includes("240 characters")), problems.join("; "));
});

test("a wrong size in KiB is rejected even when the byte count matches", () => {
  const problems = checkSkillAuthoringSpec({
    docEn: doc({ kib: "256" }),
    docZh: doc({ locale: "zh" }),
    sources: { ...SOURCES },
  });
  assert.ok(problems.some((p) => p.includes("128 KiB")), problems.join("; "));
});

test("a wrong byte count is rejected even when the KiB figure matches", () => {
  const problems = checkSkillAuthoringSpec({
    docEn: doc({ bytes: "131,000" }),
    docZh: doc({ locale: "zh" }),
    sources: { ...SOURCES },
  });
  assert.ok(problems.some((p) => p.includes("131,072")), problems.join("; "));
});

test("a wrong id pattern is rejected", () => {
  const problems = checkSkillAuthoringSpec({
    docEn: doc({ pattern: "^[a-z0-9-]+$" }),
    docZh: doc({ locale: "zh" }),
    sources: { ...SOURCES },
  });
  assert.ok(problems.some((p) => p.includes("the id pattern")), problems.join("; "));
});

test("a missing locale is reported", () => {
  const problems = checkSkillAuthoringSpec({ docEn: doc(), docZh: null, sources: { ...SOURCES } });
  assert.ok(problems.some((p) => p.includes(AUTHORING_SPEC_PATHS[1])), problems.join("; "));
});

test("dropping the version claim is rejected", () => {
  const stripped = doc().replace(/version is .*$/m, "");
  const problems = checkSkillAuthoringSpec({
    docEn: stripped,
    docZh: doc({ locale: "zh" }),
    sources: { ...SOURCES },
  });
  assert.ok(problems.some((p) => p.includes("does not consume `version`")), problems.join("; "));
});

test("dropping an enforcing-file name is rejected", () => {
  // The last entry has no trailing newline, so the removal must not require one.
  const stripped = doc().replace("crates/host-core/src/user_skills/tests.rs", "");
  const problems = checkSkillAuthoringSpec({
    docEn: stripped,
    docZh: doc({ locale: "zh" }),
    sources: { ...SOURCES },
  });
  assert.ok(problems.some((p) => p.includes("user_skills/tests.rs")), problems.join("; "));
});

// ---------------------------------------------------------------------------
// Negative cases: the code moves, the document does not.
// ---------------------------------------------------------------------------

test("a changed code constant is rejected even when the document is untouched", () => {
  const problems = checkSkillAuthoringSpec({
    docEn: doc(),
    docZh: doc({ locale: "zh" }),
    sources: { ...SOURCES, userSkills: SOURCES.userSkills.replace("120;", "160;") },
  });
  assert.ok(problems.some((p) => p.includes("160 characters")), problems.join("; "));
});

test("a renamed constant is a problem, not a silent skip", () => {
  const problems = checkSkillAuthoringSpec({
    docEn: doc(),
    docZh: doc({ locale: "zh" }),
    sources: { ...SOURCES, pluginRuntime: "const DESCRIPTION_LIMIT = 240;" },
  });
  assert.ok(problems.some((p) => p.includes("cannot locate MAX_SKILL_DESCRIPTION_CHARS")), problems.join("; "));
  assert.ok(problems.length > 0);
});

test("a renamed id pattern constant is a problem, not a silent skip", () => {
  const problems = checkSkillAuthoringSpec({
    docEn: doc(),
    docZh: doc({ locale: "zh" }),
    sources: { ...SOURCES, skillCatalog: "const CAPABILITY_ID = /^[a-z]+$/;" },
  });
  assert.ok(problems.some((p) => p.includes("cannot locate the SKILL_ID pattern")), problems.join("; "));
});

test("an unreadable source file is a problem, not a skip", () => {
  const { userSkills, ...rest } = SOURCES;
  void userSkills;
  const problems = checkSkillAuthoringSpec({ docEn: doc(), docZh: doc({ locale: "zh" }), sources: rest });
  assert.ok(problems.some((p) => p.includes(AUTHORING_SOURCE_PATHS.userSkills)), problems.join("; "));
});

test("an empty problem list is only possible when every input was present", () => {
  const problems = checkSkillAuthoringSpec({ docEn: null, docZh: null, sources: {} });
  assert.ok(problems.length >= AUTHORING_SPEC_PATHS.length + Object.keys(AUTHORING_SOURCE_PATHS).length, problems.join("; "));
});

// ---------------------------------------------------------------------------
// The committed spec must pass the gate it is policed by.
// ---------------------------------------------------------------------------

test("the committed spec matches the committed code, in both locales", () => {
  const sources = {};
  for (const [key, relPath] of Object.entries(AUTHORING_SOURCE_PATHS)) {
    sources[key] = readFileSync(path.join(root, relPath), "utf8");
  }
  const read = (relPath) => readFileSync(path.join(root, relPath), "utf8");
  const problems = checkSkillAuthoringSpec({
    docEn: read(AUTHORING_SPEC_PATHS[0]),
    docZh: read(AUTHORING_SPEC_PATHS[1]),
    sources,
  });
  assert.deepEqual(problems, [], problems.join("; "));
});
