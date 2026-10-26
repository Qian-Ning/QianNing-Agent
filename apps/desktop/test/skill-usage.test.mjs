import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

/**
 * The usage file is evidence for pruning, never a turn dependency. These tests
 * pin the two halves of that promise: counts survive a flush with the right
 * shape, and any unreadable file resets to zero instead of raising.
 */
const usage = await import("../electron/main/skill-usage.ts");

function tempDir() {
  return mkdtempSync(join(tmpdir(), "qianning-skill-usage-"));
}

test("counts loads and writes them on flush", () => {
  const dir = tempDir();
  try {
    usage.recordSkillLoad(dir, "qianning/release-verification");
    usage.recordSkillLoad(dir, "qianning/release-verification");
    usage.recordSkillLoad(dir, "qianning/python-debugpy");
    usage.flushSkillUsage();

    const written = JSON.parse(readFileSync(usage.skillUsagePath(dir), "utf8"));
    assert.equal(written.version, 1);
    assert.equal(written.skills["qianning/release-verification"].loads, 2);
    assert.equal(written.skills["qianning/python-debugpy"].loads, 1);
    assert.match(written.skills["qianning/python-debugpy"].lastLoadedAt, /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("continues from an existing file", () => {
  const dir = tempDir();
  try {
    writeFileSync(
      usage.skillUsagePath(dir),
      JSON.stringify({
        version: 1,
        skills: { "qianning/skill-authoring": { loads: 4, lastLoadedAt: "2026-01-01T00:00:00.000Z" } },
      }),
    );

    usage.recordSkillLoad(dir, "qianning/skill-authoring");
    usage.flushSkillUsage();

    const written = JSON.parse(readFileSync(usage.skillUsagePath(dir), "utf8"));
    assert.equal(written.skills["qianning/skill-authoring"].loads, 5);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("starts over when the file is corrupt or from another version", () => {
  const dir = tempDir();
  try {
    writeFileSync(usage.skillUsagePath(dir), "{ not json");
    assert.deepEqual(usage.readSkillUsage(dir), { version: 1, skills: {} });

    writeFileSync(usage.skillUsagePath(dir), JSON.stringify({ version: 2, skills: { a: { loads: 1 } } }));
    assert.deepEqual(usage.readSkillUsage(dir), { version: 1, skills: {} });

    writeFileSync(
      usage.skillUsagePath(dir),
      JSON.stringify({ version: 1, skills: { a: { loads: -3 }, b: { loads: "many" } } }),
    );
    assert.deepEqual(usage.readSkillUsage(dir), { version: 1, skills: {} });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
