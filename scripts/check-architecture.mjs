#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { extname, resolve } from "node:path";

const root = process.cwd();
const sourceRoots = ["apps", "packages", "crates", "scripts"];
const sourceExtensions = new Set([".js", ".jsx", ".mjs", ".ts", ".tsx", ".rs"]);
const excludedSegments = new Set([
  ".git",
  "node_modules",
  "dist",
  "out",
  "release",
  "target",
  "coverage",
]);

const limits = {
  mainIndex: {
    path: "apps/desktop/electron/main/index.ts",
    max: 1_500,
  },
  appStore: {
    path: "apps/desktop/src/stores/app-store.ts",
    max: 1_000,
  },
  newTypeScript: {
    extension: ".ts/.tsx",
    max: 800,
  },
  rust: {
    extension: ".rs",
    max: 1_000,
  },
  // Facade paths named by AGENTS.md section 7. main/index.ts and app-store.ts
  // carry their own limits above; these are the remaining six. Each ceiling is
  // the measured size when the ceiling was recorded. Growth fails the check:
  // raise the ceiling deliberately in the same change, or move the code to the
  // domain module that owns it, as ADR 0235 requires of a facade.
  facades: [
    { path: "apps/desktop/src/components/Composer.tsx", max: 714 },
    { path: "apps/desktop/src/components/ChatTranscript.tsx", max: 1 },
    { path: "crates/host-core/src/plugins.rs", max: 79 },
    { path: "crates/host-core/src/db.rs", max: 63 },
    { path: "crates/host-core/src/providers.rs", max: 58 },
    { path: "crates/host-core/src/plans.rs", max: 45 },
  ],
};

function git(args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trimEnd();
}

function isSourcePath(filePath) {
  const segments = filePath.split("/");
  if (
    segments.some((segment) => excludedSegments.has(segment)) ||
    !sourceRoots.some(
      (sourceRoot) => filePath === sourceRoot || filePath.startsWith(sourceRoot + "/"),
    )
  ) {
    return false;
  }
  return sourceExtensions.has(extname(filePath));
}

function trackedSourceFiles() {
  return git(["ls-files", "-co", "--exclude-standard"])
    .split("\n")
    .filter(Boolean)
    .filter(isSourcePath)
    // A tracked path removed in the working tree is not a file to measure; CI
    // never sees one, but a local run before the deletion is staged would.
    .filter((filePath) => existsSync(resolve(root, filePath)));
}

function locFor(filePath) {
  const text = readFileSync(resolve(root, filePath), "utf8");
  const newlineCount = (text.match(/\n/g) || []).length;
  return newlineCount + (text.length > 0 && !text.endsWith("\n") ? 1 : 0);
}

function collectMetrics(filePaths) {
  return filePaths
    .map((path) => ({ path, loc: locFor(path) }))
    .sort((left, right) => right.loc - left.loc || left.path.localeCompare(right.path));
}

function parseArgs() {
  const args = process.argv.slice(2);
  let base = process.env.ARCHITECTURE_BASE || "main";
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--base") {
      base = args[index + 1];
      index += 1;
    }
  }
  return { base };
}

function revisionExists(revision) {
  try {
    git(["rev-parse", "--verify", revision]);
    return true;
  } catch {
    return false;
  }
}

function fallbackBase() {
  try {
    return git(["rev-parse", "HEAD^"]);
  } catch {
    return null;
  }
}

function addedSourceFiles(base) {
  if (!base) return [];
  return git(["diff", "--name-only", "--diff-filter=A", base + "...HEAD"])
    .split("\n")
    .filter(Boolean)
    .filter(isSourcePath);
}

function readAllowlist() {
  const path = resolve(root, "docs/architecture/allowlist.json");
  if (!existsSync(path)) return { typescript: {}, rust: {} };
  const value = JSON.parse(readFileSync(path, "utf8"));
  return {
    typescript: value.typescript || {},
    rust: value.rust || {},
  };
}

function allowlistReason(entries, path) {
  const value = entries[path];
  if (typeof value === "string") return value;
  if (value && typeof value.reason === "string") return value.reason;
  return null;
}

function allowlistCeiling(entries, path) {
  const value = entries[path];
  if (value && typeof value.max === "number") return value.max;
  return null;
}

function formatEntry(entry) {
  return entry.path + " (" + entry.loc + " LOC)";
}

const { base: requestedBase } = parseArgs();
const base = revisionExists(requestedBase) ? requestedBase : fallbackBase();
if (requestedBase && requestedBase !== base) {
  console.warn(
    "Architecture base " +
      requestedBase +
      " is unavailable; comparing added files with " +
      (base || "no base") +
      ".",
  );
}

const metrics = collectMetrics(trackedSourceFiles());
const byPath = new Map(metrics.map((entry) => [entry.path, entry]));
const allowlist = readAllowlist();
const failures = [];

const counts = new Map([
  [">500", metrics.filter((entry) => entry.loc > 500).length],
  [">1000", metrics.filter((entry) => entry.loc > 1_000).length],
  [">2000", metrics.filter((entry) => entry.loc > 2_000).length],
]);

for (const { path, max } of [limits.mainIndex, limits.appStore]) {
  const entry = byPath.get(path);
  if (!entry) {
    failures.push(path + " is missing");
  } else if (entry.loc > max) {
    failures.push(path + " is " + entry.loc + " LOC; maximum is " + max);
  }
}

const largeRust = metrics.filter(
  (entry) => extname(entry.path) === ".rs" && entry.loc > limits.rust.max,
);
for (const entry of largeRust) {
  if (!allowlistReason(allowlist.rust, entry.path)) {
    failures.push(
      formatEntry(entry) +
        " exceeds the Rust limit; add a documented entry with a `max` ceiling to docs/architecture/allowlist.json",
    );
  }
}

// An exemption is a bounded debt, not a blank cheque: every allowlisted file
// must record the size it was exempted at, and may not grow past it.
for (const [language, entries] of Object.entries(allowlist)) {
  for (const path of Object.keys(entries)) {
    const entry = byPath.get(path);
    if (!entry) continue;
    const ceiling = allowlistCeiling(entries, path);
    if (ceiling === null) {
      failures.push(
        path +
          " is exempted (" +
          language +
          ") without a `max` ceiling; record the exempted size in docs/architecture/allowlist.json",
      );
    } else if (entry.loc > ceiling) {
      failures.push(
        formatEntry(entry) + " grew past its recorded ceiling of " + ceiling + " LOC",
      );
    }
  }
}

// AGENTS.md section 7 facades: thin by contract, so any growth is a failure.
for (const { path, max } of limits.facades) {
  const entry = byPath.get(path);
  if (!entry) {
    failures.push(path + " is missing");
  } else if (entry.loc > max) {
    failures.push(
      path + " is " + entry.loc + " LOC; its recorded facade ceiling is " + max,
    );
  }
}

const addedFiles = addedSourceFiles(base);
const largeNewTypeScript = addedFiles
  .map((path) => byPath.get(path))
  .filter(
    (entry) =>
      entry &&
      [".ts", ".tsx"].includes(extname(entry.path)) &&
      entry.loc > limits.newTypeScript.max &&
      !entry.path.endsWith(".d.ts"),
  );
for (const entry of largeNewTypeScript) {
  if (!allowlistReason(allowlist.typescript, entry.path)) {
    failures.push(
      formatEntry(entry) +
        " is a new TypeScript source file over " +
        limits.newTypeScript.max +
        " LOC; add a documented entry to docs/architecture/allowlist.json",
    );
  }
}

console.log("Architecture metrics");
console.log("Source files: " + metrics.length);
console.log("Total LOC: " + metrics.reduce((total, entry) => total + entry.loc, 0));
console.log("");
console.log("Largest 30 source files");
for (const entry of metrics.slice(0, 30)) {
  console.log("  " + formatEntry(entry));
}
console.log("");
console.log("LOC thresholds");
for (const threshold of [">500", ">1000", ">2000"]) {
  console.log("  " + threshold + ": " + counts.get(threshold));
}
console.log("");
console.log("Enforced limits");
console.log(
  "  " +
    limits.mainIndex.path +
    ": " +
    byPath.get(limits.mainIndex.path)?.loc +
    " / " +
    limits.mainIndex.max,
);
console.log(
  "  " +
    limits.appStore.path +
    ": " +
    byPath.get(limits.appStore.path)?.loc +
    " / " +
    limits.appStore.max,
);
console.log("  New TS/TSX limit: " + limits.newTypeScript.max + " LOC");
console.log("  Rust limit: " + limits.rust.max + " LOC");
console.log(
  "  Rust exemptions: " +
    largeRust.filter((entry) => allowlistReason(allowlist.rust, entry.path)).length,
);
console.log("  Facade ceilings: " + limits.facades.length + " paths");
for (const { path, max } of limits.facades) {
  console.log("    " + path + ": " + byPath.get(path)?.loc + " / " + max);
}
const boundedDebt = Object.entries(allowlist).flatMap(([language, entries]) =>
  Object.keys(entries)
    .map((path) => ({ language, path, ceiling: allowlistCeiling(entries, path) }))
    .filter((item) => item.ceiling !== null),
);
console.log(
  "  Recorded debt ceilings: " +
    boundedDebt.length +
    "/" +
    Object.values(allowlist).reduce((total, entries) => total + Object.keys(entries).length, 0),
);
console.log(
  "  New TS/TSX files checked: " +
    (base ? addedFiles.length : "skipped; no usable base"),
);

if (largeNewTypeScript.length > 0) {
  console.log("");
  console.log("New large TS/TSX files");
  for (const entry of largeNewTypeScript) console.log("  " + formatEntry(entry));
}

if (failures.length > 0) {
  console.error("");
  console.error("Architecture check failed");
  for (const failure of failures) console.error("  " + failure);
  process.exitCode = 1;
} else {
  console.log("");
  console.log("Architecture check passed");
}
