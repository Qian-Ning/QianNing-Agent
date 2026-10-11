/**
 * Architecture budget ceilings (ADR 0324, amending ADR 0235).
 *
 * The checker in scripts/check-architecture.mjs protects two things: the facade
 * paths AGENTS.md section 7 names, and the exemptions recorded in
 * docs/architecture/allowlist.json. Both are only real while the numbers in the
 * files agree with each other, so this test pins the agreement rather than the
 * code that reads it:
 *
 *   - every facade path AGENTS.md names is enforced by the checker, and
 *   - every allowlist entry records a ceiling its file still respects.
 *
 * A drift here is silent in review: dropping a path from the checker, or
 * leaving a ceiling behind when a file grows, looks like nothing in a diff.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const read = (relative) => readFileSync(path.join(root, relative), "utf8");

const checkerSource = read("scripts/check-architecture.mjs");
const allowlist = JSON.parse(read("docs/architecture/allowlist.json"));

function physicalLines(relative) {
  const text = read(relative);
  const newlines = (text.match(/\n/g) || []).length;
  return newlines + (text.length > 0 && !text.endsWith("\n") ? 1 : 0);
}

/** The facade paths named by the AGENTS.md section 7 code block. */
function agentFacadePaths() {
  const section = /Known hotspots[\s\S]*?```text\n([\s\S]*?)\n```/.exec(read("AGENTS.md"));
  assert.ok(section, "AGENTS.md section 7 must still list its facade paths in a text block");
  return section[1].split("\n").map((line) => line.trim()).filter(Boolean);
}

test("every AGENTS.md section 7 facade path is enforced by the checker", () => {
  const paths = agentFacadePaths();
  assert.equal(paths.length, 8, "section 7 names eight facade paths");
  for (const relative of paths) {
    assert.ok(
      checkerSource.includes(`"${relative}"`),
      `${relative} is named in AGENTS.md section 7 but is not enforced by the checker`,
    );
  }
});

test("the checker and AGENTS.md agree on the facade ceilings it reports", () => {
  // The facade block is the checker's record; each entry pairs a path with the
  // measured size that must not be exceeded.
  const block = /facades: \[([\s\S]*?)\],\n\};/.exec(checkerSource);
  assert.ok(block, "the checker must keep a facades array");
  const entries = [...block[1].matchAll(/path: "([^"]+)", max: (\d+)/g)].map(([, p, max]) => ({
    path: p,
    max: Number(max),
  }));
  assert.ok(entries.length > 0, "the facades array must record ceilings");
  for (const { path: relative, max } of entries) {
    assert.ok(
      physicalLines(relative) <= max,
      `${relative} is past its recorded facade ceiling of ${max}`,
    );
  }
});

test("every allowlisted exemption records a ceiling its file still respects", () => {
  for (const [language, entries] of Object.entries(allowlist)) {
    for (const [relative, entry] of Object.entries(entries)) {
      assert.equal(typeof entry, "object", `${relative} (${language}) must be an object entry`);
      assert.equal(typeof entry.reason, "string", `${relative} must keep its written reason`);
      assert.ok(entry.reason.length > 0, `${relative} must keep a non-empty reason`);
      assert.equal(
        typeof entry.max,
        "number",
        `${relative} must record a \`max\` ceiling (ADR 0324)`,
      );
      assert.ok(
        physicalLines(relative) <= entry.max,
        `${relative} is past its recorded ceiling of ${entry.max}`,
      );
    }
  }
});

test("the checker enforces growth against the recorded ceiling", () => {
  // Behavioural tripwire: the failure text is the contract a reader relies on
  // when CI goes red, and its absence means the enforcement was dropped.
  assert.match(checkerSource, /grew past its recorded ceiling/);
  assert.match(checkerSource, /recorded facade ceiling/);
  assert.match(checkerSource, /without a `max` ceiling/);
});

test("the checker passes on the current tree", () => {
  // Runs the real checker: the ceilings above are only meaningful if it exits
  // clean on the tree they were measured from.
  const output = execFileSync(process.execPath, ["scripts/check-architecture.mjs"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ARCHITECTURE_BASE: "HEAD" },
  });
  assert.match(output, /Architecture check passed/);
});
