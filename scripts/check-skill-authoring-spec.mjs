#!/usr/bin/env node
/**
 * Skill authoring spec gate.
 *
 * `docs/spec/07-plugins/17-skill-authoring.md` states the skill document format.
 * This run ties the document to the code it describes: every limit in the spec is
 * compared against the constant that enforces it, in both locales, and a constant
 * that cannot be found is reported as a problem rather than skipped.
 *
 * The point is drift. A spec is read as authoritative, so a spec that has moved
 * away from the code teaches the wrong contract to everyone who follows it — and
 * nothing else in the repository would notice.
 *
 * Usage:
 *   node scripts/check-skill-authoring-spec.mjs
 *
 * Exit status is 0 only when every documented limit matches the code and both
 * locales state it.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AUTHORING_SOURCE_PATHS,
  AUTHORING_SPEC_PATHS,
  checkSkillAuthoringSpec,
} from "./skill-authoring-spec-check.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

/** Read a repository-relative file, or null when it is not there. */
function readOrNull(relPath) {
  try {
    return readFileSync(path.join(root, relPath), "utf8");
  } catch {
    return null;
  }
}

const [docEnPath, docZhPath] = AUTHORING_SPEC_PATHS;
const sources = {};
for (const [key, relPath] of Object.entries(AUTHORING_SOURCE_PATHS)) {
  const text = readOrNull(relPath);
  if (text !== null) sources[key] = text;
}

const problems = checkSkillAuthoringSpec({
  docEn: readOrNull(docEnPath),
  docZh: readOrNull(docZhPath),
  sources,
});

if (problems.length > 0) {
  console.error(`Skill authoring spec check failed (${problems.length} problem(s)):`);
  for (const problem of problems) console.error(`  error: ${problem}`);
  console.error(
    "\nThe spec in docs/spec/07-plugins/17-skill-authoring.md states the skill document format.",
  );
  console.error("Its limits are quoted from the code; change both, or neither.");
  process.exit(1);
}

console.log(
  `Skill authoring spec matches the code: ${AUTHORING_SPEC_PATHS.length} locale(s) checked against ${Object.keys(AUTHORING_SOURCE_PATHS).length} source file(s).`,
);
