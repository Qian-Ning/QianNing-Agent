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
