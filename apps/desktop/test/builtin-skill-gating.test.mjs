import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * The built-in generation skills cost context in every session that advertises
 * them, and a skill whose tool has no configured model can only tell the model
 * to go configure one. The gating rule is the subject here: `false` drops the
 * entry, `undefined` keeps it, so a caller without settings access (the
 * composer's slash list) still shows every built-in skill to the user.
 */

async function loadBuiltinSkills() {
  const previous = globalThis.__dirname;
  globalThis.__dirname = fileURLToPath(new URL("../electron/main/", import.meta.url));
  try {
    return await import("../electron/main/builtin-skills.ts");
  } finally {
    globalThis.__dirname = previous;
  }
}

function ids(skills) {
  return skills.map((skill) => skill.id);
}

test("an unknown capability keeps both generation skills", async () => {
  const { builtinSkills } = await loadBuiltinSkills();
  const catalog = ids(builtinSkills({}));
  assert.ok(catalog.includes("qianning/imagegen"));
  assert.ok(catalog.includes("qianning/videogen"));
});

test("a configured capability keeps its skill", async () => {
  const { builtinSkills } = await loadBuiltinSkills();
  const catalog = ids(
    builtinSkills({ imageGenerationAvailable: true, videoGenerationAvailable: true }),
  );
  assert.ok(catalog.includes("qianning/imagegen"));
  assert.ok(catalog.includes("qianning/videogen"));
});

test("an unconfigured capability drops only its own skill", async () => {
  const { builtinSkills } = await loadBuiltinSkills();
  const imageOff = ids(builtinSkills({ imageGenerationAvailable: false }));
  assert.ok(!imageOff.includes("qianning/imagegen"));
  assert.ok(imageOff.includes("qianning/videogen"));

  const videoOff = ids(builtinSkills({ videoGenerationAvailable: false }));
  assert.ok(videoOff.includes("qianning/imagegen"));
  assert.ok(!videoOff.includes("qianning/videogen"));

  const bothOff = ids(
    builtinSkills({ imageGenerationAvailable: false, videoGenerationAvailable: false }),
  );
  assert.ok(!bothOff.includes("qianning/imagegen"));
  assert.ok(!bothOff.includes("qianning/videogen"));
});

test("the generation group disappears with its last entry", async () => {
  // A heading over zero entries is pure catalog cost. The group gate is the
  // upstream switch: it drops the whole set before per-entry gating runs.
  const { builtinSkills } = await loadBuiltinSkills();

  const bothOff = builtinSkills({
    imageGenerationAvailable: false,
    videoGenerationAvailable: false,
  });
  assert.ok(!bothOff.some((skill) => skill.group === "Generation"));

  const imageOnly = builtinSkills({
    imageGenerationAvailable: true,
    videoGenerationAvailable: false,
  });
  assert.deepEqual(
    imageOnly.filter((skill) => skill.group === "Generation").map((skill) => skill.id),
    ["qianning/imagegen"],
  );

  // An unknown signal keeps the group: the composer's slash list must still
  // show every built-in skill to a human.
  const unknown = builtinSkills({});
  assert.deepEqual(
    unknown.filter((skill) => skill.group === "Generation").map((skill) => skill.id),
    ["qianning/imagegen", "qianning/videogen"],
  );
});

test("gating the catalog does not make the skill unloadable", async () => {
  // The entry disappears from the advertisement; the body still resolves, so a
  // transcript or an earlier turn that named the id keeps working.
  const { loadBuiltinSkillBody } = await loadBuiltinSkills();
  assert.match(loadBuiltinSkillBody("qianning/imagegen").body, /GenerateImages/);
  assert.match(loadBuiltinSkillBody("qianning/videogen").body, /GenerateVideos/);
});

test("the session catalog is wired to the configured generation models", async () => {
  // The rule above is only real if the model-facing call site passes it. The
  // composer's slash list deliberately does not, so the user keeps seeing every
  // built-in skill.
  const sessionLaunch = await readFile(
    new URL("../electron/main/runtime/session-launch.ts", import.meta.url),
    "utf8",
  );
  assert.match(sessionLaunch, /imageGenerationAvailable:/);
  assert.match(sessionLaunch, /videoGenerationAvailable:/);
  assert.match(sessionLaunch, /imageGenerationBindings\(/);
  assert.match(sessionLaunch, /videoGenerationBindings\(/);

  const composer = await readFile(
    new URL("../electron/main/ipc/composer-ipc.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(composer, /imageGenerationAvailable/);
  assert.doesNotMatch(composer, /videoGenerationAvailable/);
});

test("every shipped skill carries a catalog group and a short description", async () => {
  // The catalog advertises all eighty-odd entries in every session, so the two
  // presentation budgets are part of shipping a document: a long description or
  // a missing group turns the list back into noise and quietly costs trigger
  // accuracy. Both are enforced here rather than left to review.
  const {
    builtinSkills,
    BUILTIN_SKILL_DESCRIPTION_LIMIT,
    BUILTIN_SKILL_FALLBACK_GROUP,
  } = await loadBuiltinSkills();
  const catalog = builtinSkills({});

  assert.ok(catalog.length >= 80, `catalog shrank to ${catalog.length} entries`);

  const ungrouped = catalog.filter((skill) => !skill.group).map((skill) => skill.id);
  assert.deepEqual(ungrouped, [], "these skills have no group heading");

  const fellBack = catalog
    .filter((skill) => skill.group === BUILTIN_SKILL_FALLBACK_GROUP)
    .map((skill) => skill.id);
  assert.deepEqual(fellBack, [], "add these documents to BUILTIN_SKILL_GROUPS");

  const overBudget = catalog
    .filter((skill) => (skill.description ?? "").length > BUILTIN_SKILL_DESCRIPTION_LIMIT)
    .map((skill) => `${skill.id} (${(skill.description ?? "").length})`);
  assert.deepEqual(
    overBudget,
    [],
    `descriptions must stay within ${BUILTIN_SKILL_DESCRIPTION_LIMIT} characters`,
  );

  // A handful of topics, not one heading per document.
  const groups = new Set(catalog.map((skill) => skill.group));
  assert.ok(groups.size <= 12, `the catalog splintered into ${groups.size} groups`);
});
