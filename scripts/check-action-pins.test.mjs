import assert from "node:assert/strict";
import test from "node:test";
import { auditRepository, auditWorkflowText } from "./check-action-pins.mjs";

const SHA = "0123456789abcdef0123456789abcdef01234567";

test("a commit-pinned third-party action passes", () => {
  const issues = auditWorkflowText(`steps:\n  - uses: actions/checkout@${SHA} # v7\n`, "ok.yml");
  assert.deepEqual(issues, []);
});

test("a tag, branch and major ref fail", () => {
  for (const ref of ["v7", "main", "stable", "v7.0.1"]) {
    const issues = auditWorkflowText(`steps:\n  - uses: actions/checkout@${ref}\n`, "bad.yml");
    assert.equal(issues.length, 1, ref);
    assert.equal(issues[0].file, "bad.yml");
    assert.equal(issues[0].value, `actions/checkout@${ref}`);
  }
});

test("local and docker actions are not pinned", () => {
  const issues = auditWorkflowText(
    `steps:\n  - uses: ./.github/actions/setup\n  - uses: docker://alpine:3.20\n`,
    "ok.yml",
  );
  assert.deepEqual(issues, []);
});

test("a commented uses line is ignored", () => {
  const issues = auditWorkflowText(`steps:\n  # - uses: actions/checkout@v7\n  - uses: actions/checkout@${SHA}\n`, "ok.yml");
  assert.deepEqual(issues, []);
});

test("auditRepository finds every mutable ref in the real workflows", () => {
  assert.deepEqual(auditRepository(process.cwd()), []);
});
