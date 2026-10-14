#!/usr/bin/env node
/**
 * Skill and plugin provenance gate.
 *
 * CONTRIBUTING.md "Skill and plugin provenance" requires every skill document we
 * author to carry an `## Origin` section whose first line is `QianNing Agent`,
 * and no upstream product name, because a skill ships to users and its text
 * reaches the model. A shipped plugin manifest is policed the same way: its
 * display strings must name the shipped product and its `author` its real origin.
 * `docs/` is excluded: those pages are documentation, policed by
 * `docs-check.yml`, not shipped skills.
 *
 * Discovery is by path, not by a fixed list, so a skill document or a plugin
 * manifest added under a new directory is covered the first time it is
 * committed. The run prints how many of each it verified; a count that drops is
 * the signal that something moved out of a scanned directory.
 *
 * Usage:
 *   node scripts/check-skill-provenance.mjs
 *
 * Exit status is 0 only when every discovered document satisfies the rule.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkPluginManifest,
  checkSkillDocument,
  isPluginManifestPath,
  isSkillDocumentPath,
} from "./skill-provenance-check.mjs";

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

/** Walk the tree once, handing every regular file to the visitor. */
function walk(dir, visit) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(full, visit);
      continue;
    }
    if (entry.isFile()) visit(full, entry.name);
  }
}

const documents = [];
const manifests = [];

walk(root, (full) => {
  const relPath = path.relative(root, full).split(path.sep).join("/");
  if (isPluginManifestPath(relPath)) {
    manifests.push(relPath);
    return;
  }
  if (isSkillDocumentPath(relPath)) documents.push(relPath);
});

documents.sort();
manifests.sort();

const problems = [];

for (const relPath of documents) {
  const full = path.join(root, relPath);
  if (!statSync(full).isFile()) continue;
  problems.push(...checkSkillDocument(relPath, readFileSync(full, "utf8")));
}

for (const relPath of manifests) {
  const full = path.join(root, relPath);
  if (!statSync(full).isFile()) continue;
  problems.push(...checkPluginManifest(relPath, readFileSync(full, "utf8")));
}

if (problems.length > 0) {
  console.error(`Skill and plugin provenance check failed (${problems.length} problem(s)):`);
  for (const problem of problems) console.error(`  error: ${problem}`);
  console.error(
    '\nEvery skill document and plugin manifest declares its origin: see CONTRIBUTING.md, section "Skill and plugin provenance".',
  );
  process.exit(1);
}

console.log(
  `Verified ${documents.length} skill document(s) and ${manifests.length} plugin manifest(s): origin declared, no upstream product name.`,
);
