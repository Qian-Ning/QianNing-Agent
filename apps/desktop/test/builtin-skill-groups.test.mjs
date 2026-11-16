import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * The catalog is indexed by group so 88 descriptions stay out of the system
 * prompt; `Skill("group:<name>")` is the only way to read one index page, so the
 * two halves have to agree on names and membership.
 */
async function loadBuiltinSkills() {
  globalThis.__dirname = fileURLToPath(new URL("../electron/main/", import.meta.url));
  return await import("../electron/main/builtin-skills.ts");
}

test("every group the catalog advertises can be looked up", async () => {
  const { builtinSkillGroupNames, builtinSkillsInGroup } = await loadBuiltinSkills();
  const groups = builtinSkillGroupNames();
  assert.ok(groups.length > 0, "the shipped catalog has groups");
  for (const group of groups) {
    const members = builtinSkillsInGroup(group);
    assert.ok(members.length > 0, `${group} resolves to entries`);
    for (const member of members) {
      assert.equal(member.group, group);
      assert.ok(member.id && member.name, `${group}: every entry is addressable`);
    }
  }
});

test("group membership covers the whole catalog exactly once", async () => {
  const { builtinSkillGroupNames, builtinSkillsInGroup } = await loadBuiltinSkills();
  const seen = new Set();
  for (const group of builtinSkillGroupNames()) {
    for (const member of builtinSkillsInGroup(group)) {
      assert.ok(!seen.has(member.id), `${member.id} appears in two groups`);
      seen.add(member.id);
    }
  }
  // Every shipped document is reachable through exactly one group.
  const { listBuiltinSkillFiles } = await loadBuiltinSkills();
  assert.equal(seen.size, listBuiltinSkillFiles().length);
});

test("an unknown group resolves to nothing rather than throwing", async () => {
  const { builtinSkillsInGroup } = await loadBuiltinSkills();
  assert.deepEqual(builtinSkillsInGroup("No Such Group"), []);
  assert.deepEqual(builtinSkillsInGroup(""), []);
});
