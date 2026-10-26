#!/usr/bin/env node
/**
 * Read the bundled-skill load counts and print them as a ranking.
 *
 * Usage:
 *   pnpm skills:usage                 # default data directory
 *   pnpm skills:usage <path>          # explicit skill-usage.json
 *
 * The file counts only bundled skills, written by the Skill tool in the main
 * process. Plugins and user-authored skills are not tracked here. Nothing is
 * uploaded; this reads a local file and prints a table.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const path = process.argv[2] ?? join(homedir(), ".qianning-agent", "skill-usage.json");

let parsed;
try {
  parsed = JSON.parse(readFileSync(path, "utf8"));
} catch {
  console.log(`No usage data at ${path}`);
  console.log("Load a few skills and run this again.");
  process.exit(0);
}

const skills = parsed?.skills && typeof parsed.skills === "object" ? parsed.skills : {};
const rows = Object.entries(skills)
  .map(([id, value]) => ({
    id,
    loads: Number(value?.loads) || 0,
    last: typeof value?.lastLoadedAt === "string" ? value.lastLoadedAt.slice(0, 10) : "-",
  }))
  .sort((left, right) => right.loads - left.loads || left.id.localeCompare(right.id));

if (rows.length === 0) {
  console.log(`No skills loaded yet (${path}).`);
  process.exit(0);
}

const width = Math.max(...rows.map((row) => row.id.length), "skill".length);
console.log(`${"skill".padEnd(width)}  loads  last loaded`);
console.log(`${"-".repeat(width)}  -----  -----------`);
for (const row of rows) {
  console.log(`${row.id.padEnd(width)}  ${String(row.loads).padStart(5)}  ${row.last}`);
}
console.log(`\n${rows.length} skills tracked · ${path}`);
