#!/usr/bin/env node
/**
 * Reject mutable refs in GitHub Actions `uses:` lines.
 *
 * A tag is a name its owner can retarget; a branch is a name its owner can push
 * to. Either turns a workflow that holds `contents: write` into a remote code
 * execution path controlled by a third party. Commit SHAs are immutable, so the
 * release and CI workflows pin every third-party action and this check keeps a
 * later edit from quietly reintroducing `@v7`.
 *
 * Local actions (`./...`) and Docker references are skipped: the first is this
 * checkout, and the second is resolved by the container runtime, not Actions.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

const USES = /^\s*(?:-\s*)?uses:\s*([^\s#]+)/;
const SHA = /@[0-9a-f]{40}$/;

export function auditWorkflowText(text, file) {
  const issues = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\s*#/.test(line)) continue;
    const match = USES.exec(line);
    if (!match) continue;
    const value = match[1].replace(/^["']|["']$/g, "");
    if (value.startsWith("./") || value.startsWith("docker://")) continue;
    if (SHA.test(value)) continue;
    issues.push({ file, line: index + 1, value });
  }
  return issues;
}

function workflowFiles(root) {
  const dir = join(root, ".github", "workflows");
  return readdirSync(dir)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .map((name) => join(dir, name))
    .filter((path) => statSync(path).isFile());
}

export function auditRepository(root = process.cwd()) {
  const issues = [];
  for (const path of workflowFiles(root)) {
    const file = relative(root, path).replaceAll("\\", "/");
    issues.push(...auditWorkflowText(readFileSync(path, "utf8"), file));
  }
  return issues;
}

function main() {
  const issues = auditRepository();
  for (const issue of issues) {
    console.error(`::error file=${issue.file},line=${issue.line}::${issue.value} is not pinned to a 40-character commit SHA`);
  }
  if (issues.length > 0) {
    const files = new Set(issues.map((issue) => issue.file)).size;
    console.error(`action pins: ${issues.length} mutable reference(s) in ${files} file(s)`);
    process.exitCode = 1;
    return;
  }
  console.log("action pins OK: every third-party uses: is a 40-character commit SHA");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
