import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

/**
 * The preload is the only place where the host guesses which instruction
 * document the first prompt needs. These tests pin both halves: a clear match
 * arrives with its real body, and an ambiguous prompt resolves to nothing so
 * the model keeps the catalog and the `Skill` tool.
 */
async function loadPreload() {
  const previous = globalThis.__dirname;
  globalThis.__dirname = fileURLToPath(new URL("../electron/main/", import.meta.url));
  try {
    return await import("../electron/main/skill-preload.ts");
  } finally {
    globalThis.__dirname = previous;
  }
}

const catalog = [
  {
    id: "qianning/release-verification",
    name: "Release verification",
    description:
      "Prove the tagged artefact matches the tested tree before publishing a release.",
  },
  {
    id: "qianning/songwriting",
    name: "Songwriting",
    description: "Shape lyrics, melody and structure for a folk or pop song.",
  },
];

test("a clear match returns the real bundled body", async () => {
  const { resolvePreloadedSkill } = await loadPreload();
  const picked = resolvePreloadedSkill(
    "the tagged artefact hash does not match the tested tree we built",
    catalog,
  );

  assert.equal(picked.id, "qianning/release-verification");
  assert.ok(picked.name.length > 0);
  assert.ok(picked.body.length > 200);
  assert.ok(!picked.body.startsWith("---"), "frontmatter is not part of the body");
});

test("an ambiguous or unrelated prompt preloads nothing", async () => {
  const { resolvePreloadedSkill } = await loadPreload();

  assert.equal(resolvePreloadedSkill("hey, what is up", catalog), undefined);
  assert.equal(
    resolvePreloadedSkill("add a toggle to the settings screen", catalog),
    undefined,
  );
  // Two skills score alike; the model decides.
  const twins = [
    {
      id: "qianning/alpha-report",
      name: "Alpha report",
      description: "Render the monthly usage report for the billing export.",
    },
    {
      id: "qianning/beta-report",
      name: "Beta report",
      description: "Render the monthly usage report for the billing export.",
    },
  ];
  assert.equal(resolvePreloadedSkill("render the monthly usage report", twins), undefined);
});

test("a skill the catalog does not advertise is never preloaded", async () => {
  const { resolvePreloadedSkill } = await loadPreload();
  // `release-verification` is the only match, but it is not advertised here.
  assert.equal(
    resolvePreloadedSkill("prove the tagged artefact matches the tested tree", [
      catalog[1],
    ]),
    undefined,
  );
});

test("the prompt path actually hands the match to the runtime", async () => {
  // The matcher is only real if the model-facing call site uses it: the host
  // resolves the match before `agent.prompt` and forwards it with the turn.
  const source = await readFile(
    new URL("../electron/main/ipc/agent-ipc.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /resolvePreloadedSkill\(/);
  assert.match(source, /\.\.\.\(preloadedSkill \? \{ preloadedSkill \} : \{\}\)/);

  const sidecar = await readFile(
    new URL("../../../packages/agent-runtime/src/sidecar.ts", import.meta.url),
    "utf8",
  );
  assert.match(sidecar, /setPreloadedSkill\(params\.preloadedSkill\)/);
  assert.match(sidecar, /preloadedSkill: params\.preloadedSkill/);
});
