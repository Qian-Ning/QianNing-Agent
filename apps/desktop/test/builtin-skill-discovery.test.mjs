import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

const {
  builtinSkillIdForFile,
  builtinSkills,
  listBuiltinSkillFiles,
  loadBuiltinSkillBody,
} = await import("../electron/main/builtin-skills.ts");

/**
 * The shipped skill set is discovered from the resource directory. These pin the
 * properties that make discovery safe: the ids already stored in sent
 * transcripts do not move, no shipped file is unreachable, and nothing in the
 * directory is silently skipped.
 */

const dir = fileURLToPath(new URL("../resources/skills/", import.meta.url));

test("the ids stored in past transcripts keep their values", () => {
  // These id strings are written into sent transcripts, where the id is also the
  // slash name. A rename here is a breaking change for history.
  assert.equal(builtinSkillIdForFile("image-generation.md"), "qianning/imagegen");
  assert.equal(builtinSkillIdForFile("video-generation.md"), "qianning/videogen");
  assert.equal(builtinSkillIdForFile("plugin-development.md"), "qianning/plugin-development");
});

test("a file with no explicit id derives its own", () => {
  assert.equal(builtinSkillIdForFile("systematic-debugging.md"), "qianning/systematic-debugging");
});

test("every file in the resource directory is discovered and non-empty", () => {
  const files = listBuiltinSkillFiles();
  assert.ok(files.length > 0, "no shipped skills were discovered");
  for (const file of files) {
    assert.ok(file.endsWith(".md"), `${file} is not a markdown file`);
    assert.ok(readFileSync(`${dir}${file}`).length > 0, `${file} is empty`);
  }
});

test("discovered ids are unique", () => {
  const ids = listBuiltinSkillFiles().map(builtinSkillIdForFile);
  assert.equal(new Set(ids).size, ids.length, `duplicate ids: ${ids.join(", ")}`);
});

test("no shipped file is missing from the catalog or unresolvable", () => {
  // A dev workspace, so the plugin primer is in scope; this test is about reach.
  const catalog = builtinSkills({ workspacePath: dir, pluginPaths: [dir] });
  const catalogIds = new Set(catalog.map((entry) => entry.id));
  for (const file of listBuiltinSkillFiles()) {
    const id = builtinSkillIdForFile(file);
    if (!catalogIds.has(id)) {
      assert.equal(
        file,
        "plugin-development.md",
        `${file} is in the resource directory but not advertised`,
      );
    }
    const body = loadBuiltinSkillBody(id);
    assert.ok(body, `${file} (${id}) has no loadable body`);
    assert.ok(body.body.trim().length > 0, `${file} has an empty body`);
  }
});

test("every advertised skill parses to a name and an applicability line", () => {
  for (const entry of builtinSkills({})) {
    assert.ok(entry.name && entry.name.length > 0, `${entry.id} has no name`);
    assert.ok(
      entry.description && entry.description.length > 0,
      `${entry.id} has no description; the model picks skills by that line`,
    );
  }
});

test("the plugin primer stays gated on a plugin workspace", () => {
  const plain = builtinSkills({}).map((entry) => entry.id);
  assert.ok(
    !plain.includes("qianning/plugin-development"),
    "the primer leaked into a plain session",
  );
  const dev = builtinSkills({ workspacePath: dir, pluginPaths: [dir] }).map((entry) => entry.id);
  assert.ok(
    dev.includes("qianning/plugin-development"),
    "the primer did not activate in a dev workspace",
  );
});

test("a legacy id still resolves to its current skill", () => {
  const body = loadBuiltinSkillBody("pi-desktop/imagegen");
  assert.ok(body, "a legacy id stopped resolving");
  assert.equal(body.id, "qianning/imagegen");
});
