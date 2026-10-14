/**
 * Rules for the skill authoring spec gate.
 *
 * `docs/spec/07-plugins/17-skill-authoring.md` states the skill document format
 * — its limits, its parsing rules, and what a write-back preserves. A spec that
 * drifts from the code is worse than no spec, because it is read as authoritative
 * while being wrong. This module ties the two together the only way that cannot
 * rot: **every number in the document is derived from the constant that enforces
 * it**, so changing the code without changing the document fails, and editing the
 * document to a different number fails too.
 *
 * The functions here are pure — they take source text and document text — so the
 * negative cases can be exercised with a string, without a checkout.
 *
 * A constant that cannot be located is a **failure**, never a skip. A check that
 * silently passes when its subject disappears is the exact class of gate this
 * module exists to avoid.
 */

/** The document this gate polices, in both locales. */
export const AUTHORING_SPEC_PATHS = [
  "docs/spec/07-plugins/17-skill-authoring.md",
  "docs/zh-CN/spec/07-plugins/17-skill-authoring.md",
];

/** Files whose constants the document quotes. */
export const AUTHORING_SOURCE_PATHS = {
  userSkills: "crates/host-core/src/user_skills.rs",
  agentCapabilities: "crates/host-core/src/agent_capabilities.rs",
  pluginRuntime: "apps/desktop/electron/main/plugin-runtime.ts",
  skillCatalog: "packages/shared/src/skill-catalog.ts",
};

/** Extract `NAME = <int>` or `NAME = <int> * <int>`, from Rust or TypeScript. */
export function readSizeConstant(source, name, where) {
  const re = new RegExp(`${name}\\s*(?::[^=]*)?=\\s*([0-9_]+)(?:\\s*\\*\\s*([0-9_]+))?`);
  const match = re.exec(source);
  if (!match) return null;
  const first = Number(match[1].replace(/_/g, ""));
  const second = match[2] ? Number(match[2].replace(/_/g, "")) : 1;
  if (!Number.isFinite(first) || !Number.isFinite(second)) return null;
  void where;
  return first * second;
}

/** Extract the argument of `capability_id(…, <int>)`, the id length budget. */
function readIdBudget(source) {
  const match = /capability_id\([^)]*?,\s*([0-9_]+)\s*\)/.exec(source);
  if (!match) return null;
  const value = Number(match[1].replace(/_/g, ""));
  return Number.isFinite(value) ? value : null;
}

/** Extract the literal of `const SKILL_ID = /…/`, the id pattern. */
function readIdPattern(source) {
  const match = /SKILL_ID\s*=\s*\/(.+?)\/([a-z]*)/.exec(source);
  if (!match) return null;
  return { source: match[1], flags: match[2] };
}

/** Thousands separators, so the document can spell a byte count readably. */
function withThousands(value) {
  return value.toLocaleString("en-US");
}

/**
 * Check the spec documents against the constants that enforce them.
 *
 * @param {object} input
 * @param {string|null} input.docEn  English spec text, or null when missing.
 * @param {string|null} input.docZh  Chinese spec text, or null when missing.
 * @param {Record<string, string>} input.sources  File contents, keyed by short id.
 * @returns {string[]} problems, empty when every rule holds.
 */
export function checkSkillAuthoringSpec({ docEn, docZh, sources }) {
  const problems = [];

  if (docEn === null) problems.push(`missing ${AUTHORING_SPEC_PATHS[0]}`);
  if (docZh === null) problems.push(`missing ${AUTHORING_SPEC_PATHS[1]}`);
  for (const [key, relPath] of Object.entries(AUTHORING_SOURCE_PATHS)) {
    if (typeof sources[key] !== "string") {
      problems.push(`cannot read ${relPath}: the document quotes its constants`);
    }
  }
  if (problems.length > 0) return problems;

  const skillBytes = readSizeConstant(sources.userSkills, "MAX_SKILL_BYTES", AUTHORING_SOURCE_PATHS.userSkills);
  const nameChars = readSizeConstant(sources.userSkills, "MAX_NAME_CHARS", AUTHORING_SOURCE_PATHS.userSkills);
  const descChars = readSizeConstant(
    sources.pluginRuntime,
    "MAX_SKILL_DESCRIPTION_CHARS",
    AUTHORING_SOURCE_PATHS.pluginRuntime,
  );
  const idChars = readIdBudget(sources.userSkills);
  const idPattern = readIdPattern(sources.skillCatalog);

  // A constant that moved or was renamed is a problem, not a reason to check less.
  const limits = [
    ["MAX_SKILL_BYTES", skillBytes, AUTHORING_SOURCE_PATHS.userSkills],
    ["MAX_NAME_CHARS", nameChars, AUTHORING_SOURCE_PATHS.userSkills],
    ["MAX_SKILL_DESCRIPTION_CHARS", descChars, AUTHORING_SOURCE_PATHS.pluginRuntime],
    ["capability_id(…, N)", idChars, AUTHORING_SOURCE_PATHS.userSkills],
  ];
  for (const [name, value, where] of limits) {
    if (value === null) problems.push(`${where}: cannot locate ${name}; the spec quotes it, so it must be readable`);
  }
  if (idPattern === null) {
    problems.push(`${AUTHORING_SOURCE_PATHS.skillCatalog}: cannot locate the SKILL_ID pattern`);
  }
  if (problems.length > 0) return problems;

  const kib = skillBytes / 1024;
  const expectations = [
    { text: `**${kib} KiB**`, what: `the document size limit (${kib} KiB)` },
    { text: `${withThousands(skillBytes)} bytes`, what: `the document size limit in bytes (${withThousands(skillBytes)})` },
    { text: `**${nameChars} characters**`, what: `the name limit (${nameChars} characters)` },
    { text: `**${descChars} characters**`, what: `the description limit (${descChars} characters)` },
    { text: `**${idChars} characters**`, what: `the id budget (${idChars} characters)` },
    { text: idPattern.source, what: `the id pattern (${idPattern.source})` },
  ];

  for (const { text, what } of expectations) {
    for (const [label, doc] of [
      ["English", docEn],
      ["Chinese", docZh],
    ]) {
      if (!doc.includes(text)) {
        problems.push(`${label} spec does not state ${what}; expected to find: ${text}`);
      }
    }
  }

  // The spec names each enforcing file, so a reader can tell a guarantee from a habit.
  const enforcement = [
    "scripts/check-skill-provenance.mjs",
    "scripts/check-skill-authoring-spec.mjs",
    "apps/desktop/test/builtin-skill-discovery.test.mjs",
    "crates/host-core/src/user_skills/tests.rs",
  ];
  for (const path of enforcement) {
    for (const [label, doc] of [
      ["English", docEn],
      ["Chinese", docZh],
    ]) {
      if (!doc.includes(path)) problems.push(`${label} spec does not name the enforcing file ${path}`);
    }
  }

  // §4.3 makes a negative claim about `version`. It is load-bearing: it is the
  // sentence that stops a reader assuming a binding that does not exist.
  if (!/not consumed by host-core|host-core 不消费它/.test(docEn) || !/host-core 不消费它/.test(docZh)) {
    problems.push("spec must state that host-core does not consume `version` (English and Chinese)");
  }

  return problems;
}
