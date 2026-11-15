import assert from "node:assert/strict";
import test from "node:test";

import { computeSkillsRevision } from "../electron/main/skills-revision.ts";

test("the same skill set always produces the same revision", () => {
  const entries = [
    { path: "motion-decisions.md", content: "a" },
    { path: "reviewing-motion.md", content: "b" },
  ];
  assert.equal(computeSkillsRevision(entries), computeSkillsRevision([...entries]));
});

test("directory order does not change the revision", () => {
  const a = computeSkillsRevision([
    { path: "a.md", content: "one" },
    { path: "b.md", content: "two" },
  ]);
  const b = computeSkillsRevision([
    { path: "b.md", content: "two" },
    { path: "a.md", content: "one" },
  ]);
  assert.equal(a, b);
});

test("editing one character of one document changes the revision", () => {
  const before = computeSkillsRevision([{ path: "a.md", content: "teh" }]);
  const after = computeSkillsRevision([{ path: "a.md", content: "the" }]);
  assert.notEqual(before, after);
});

test("adding or removing a document changes the revision", () => {
  const one = computeSkillsRevision([{ path: "a.md", content: "one" }]);
  const two = computeSkillsRevision([
    { path: "a.md", content: "one" },
    { path: "b.md", content: "" },
  ]);
  assert.notEqual(one, two);
});

test("moving text between documents is not the same revision", () => {
  const split = computeSkillsRevision([
    { path: "a.md", content: "ab" },
    { path: "b.md", content: "c" },
  ]);
  const merged = computeSkillsRevision([
    { path: "a.md", content: "a" },
    { path: "b.md", content: "bc" },
  ]);
  assert.notEqual(split, merged, "length prefixes keep boundaries significant");
});

test("backslash and forward-slash paths describe the same document", () => {
  const windows = computeSkillsRevision([{ path: "sub\\a.md", content: "x" }]);
  const posix = computeSkillsRevision([{ path: "sub/a.md", content: "x" }]);
  assert.equal(windows, posix);
});

test("the revision is short enough to print in a status line", () => {
  const revision = computeSkillsRevision([{ path: "a.md", content: "x" }]);
  assert.match(revision, /^[0-9a-f]{16}$/);
});
