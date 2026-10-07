import assert from "node:assert/strict";
import test from "node:test";
import {
  composerCommandCatalog,
  EMPTY_COMMAND_CATALOG,
  LEGACY_SKILL_ID_ALIASES,
} from "../src/features/chat/composer/command-catalog.ts";

/*
 * D675: the draft token, the transcript chip and the "/" menu row are all
 * labelled from this one reduction, so what it keys — and what it keeps — is
 * the contract that stops the three surfaces from disagreeing.
 */

const commands = [
  {
    name: "compact",
    kind: "builtin",
    title: "Compact conversation context",
    id: "builtin.agent.compact",
  },
  {
    name: "qn-novel-write",
    kind: "skill",
    title: "章节写作",
    skillId: "com.qianning.novel-engine/write",
  },
  {
    name: "qianning/imagegen",
    kind: "skill",
    title: "imagegen",
    skillId: "qianning/imagegen",
  },
  { name: "ship", kind: "template", title: "Ship the release" },
  { name: "no-title", kind: "plugin", title: "" },
];

test("every kind is found by slash name, for a sent turn to be labelled", () => {
  const { byName } = composerCommandCatalog(commands);
  assert.equal(byName.get("compact")?.kind, "builtin");
  assert.equal(byName.get("compact")?.id, "builtin.agent.compact");
  assert.equal(byName.get("ship")?.kind, "template");
  // A skill's slash name is its id, which is what the draft and the turn carry.
  assert.equal(byName.get("qianning/imagegen")?.kind, "skill");
  // A plugin command has no palette id and no skill id.
  assert.equal(byName.get("no-title")?.id, undefined);
  assert.equal(byName.get("no-title")?.skillId, undefined);
});

test("a missing title falls back to the name, never to an empty label", () => {
  const { byName } = composerCommandCatalog(commands);
  assert.equal(byName.get("no-title")?.title, "no-title");
  assert.equal(byName.get("qn-novel-write")?.title, "章节写作");
});

test("only skills are keyed by id, because only mentions carry an id", () => {
  const { byId } = composerCommandCatalog(commands);
  assert.equal(byId.get("com.qianning.novel-engine/write")?.name, "qn-novel-write");
  assert.equal(byId.get("builtin.agent.compact"), undefined);
  assert.equal(byId.get("ship"), undefined);
});

test("an id from before the rename resolves to the current entry", () => {
  const catalog = composerCommandCatalog(commands);
  const current = catalog.byId.get("qianning/imagegen");
  assert.ok(current, "the current skill id is keyed");
  for (const [legacyId, currentId] of Object.entries(LEGACY_SKILL_ID_ALIASES)) {
    if (currentId !== "qianning/imagegen") continue;
    // The transcript looks a mention up by id; an older turn names the old one.
    assert.equal(catalog.byId.get(legacyId), current);
    // The slash name is the id, so a whole-invocation turn resolves too.
    assert.equal(catalog.byName.get(legacyId), current);
  }
});

test("no alias is invented for a skill this install does not have", () => {
  const catalog = composerCommandCatalog(commands.filter((c) => c.name !== "qianning/imagegen"));
  assert.equal(catalog.byId.get("pi-desktop/imagegen"), undefined);
  assert.equal(catalog.byName.get("pi-desktop/imagegen"), undefined);
});

test("an empty catalog stays empty and unloaded", () => {
  assert.equal(EMPTY_COMMAND_CATALOG.loaded, false);
  assert.equal(composerCommandCatalog([]).loaded, true);
  assert.equal(composerCommandCatalog([]).byName.size, 0);
  assert.equal(composerCommandCatalog([]).byId.size, 0);
});
