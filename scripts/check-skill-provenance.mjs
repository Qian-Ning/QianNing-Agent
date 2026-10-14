#!/usr/bin/env node
/**
 * Skill provenance gate.
 *
 * CONTRIBUTING.md "Skill provenance" requires every skill document we author to
 * carry an `## Origin` section whose first line is `QianNing Agent`, and no
 * upstream product name, because a skill ships to users and its text reaches the
 * model. `docs/` is excluded: those pages are documentation, policed by
 * `docs-check.yml`, not shipped skills.
 *
 * Discovery is by path, not by a fixed list, so a skill document added under a
 * new `skills/` directory is covered the first time it is committed. The run
 * prints how many documents it verified; a count that drops is the signal that a
 * skill moved out of a scanned directory.
 *
 * Usage:
 *   node scripts/check-skill-provenance.mjs
 *
 * Exit status is 0 only when every discovered document satisfies the rule.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkSkillDocument } from "./skill-provenance-check.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

/** Directories never worth walking: generated, vendored, or not ours to police. */
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "out",
  "release",
  "target",
  "coverage",
  ".vitepress",
  "docs",
]);

function findSkillDocuments(dir, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      findSkillDocuments(full, found);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".md")) continue;
    const parent = path.basename(path.dirname(full));
    if (parent === "skills" || entry.name === "SKILL.md") {
      found.push(path.relative(root, full).split(path.sep).join("/"));
    }
  }
  return found;
}

const documents = findSkillDocuments(root).sort();
const problems = [];

for (const relPath of documents) {
  const full = path.join(root, relPath);
  if (!statSync(full).isFile()) continue;
  problems.push(...checkSkillDocument(relPath, readFileSync(full, "utf8")));
}

if (problems.length > 0) {
  console.error(`Skill provenance check failed (${problems.length} problem(s)):`);
  for (const problem of problems) console.error(`  error: ${problem}`);
  console.error(
    "\nEvery skill document declares its origin: see CONTRIBUTING.md, section \"Skill provenance\".",
  );
  process.exit(1);
}

console.log(`Verified ${documents.length} skill document(s): origin declared, no upstream product name.`);
