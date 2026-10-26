import { describe, expect, it } from "vitest";
import {
  pluginSkillsPrompt,
  pluginSkillsPromptSections,
  SKILL_TOOL_NAME,
  type PluginSkillDef,
} from "./plugin-skills-prompt.js";

const skills: PluginSkillDef[] = [
  {
    id: "demo.hello/release-notes",
    name: "Release notes",
    description: "Draft release notes from the changelog.",
  },
  { id: "demo.hello/no-description", name: "Bare" },
];

describe("pluginSkillsPrompt", () => {
  it("returns nothing when no plugin taught a skill", () => {
    expect(pluginSkillsPrompt([])).toBeUndefined();
  });

  it("lists ids, names and descriptions and names the load tool", () => {
    const prompt = pluginSkillsPrompt(skills) ?? "";
    expect(prompt.startsWith("# Skills")).toBe(true);
    expect(prompt).toContain(`\`${SKILL_TOOL_NAME}\` tool`);
    expect(prompt).toContain(
      "- `demo.hello/release-notes` — Release notes: Draft release notes from the changelog.",
    );
    // A skill without a description still has to be addressable.
    expect(prompt).toContain("- `demo.hello/no-description` — Bare");
  });

  it("keeps the document body out of the prompt", () => {
    const prompt = pluginSkillsPrompt([
      { id: "a/b", name: "B", description: "Short line." },
    ]) ?? "";
    expect(prompt).not.toContain("Short line.\n\n");
    expect(prompt.split("\n").filter((line) => line.startsWith("- "))).toHaveLength(1);
  });
});

it("gives skill IDs collision-free section names and stable catalog ordering", () => {
  const entries = [
    { id: "__proto__", name: "Prototype" }, { id: "runtime", name: "Reserved" },
    { id: "skill:a", name: "Colon" }, { id: "a", name: "A" },
  ];
  const sections = pluginSkillsPromptSections(entries);
  expect(sections).toEqual(pluginSkillsPromptSections([...entries].reverse()));
  expect(Object.keys(sections)).toEqual(Object.keys(pluginSkillsPromptSections([...entries].reverse())));
  expect(sections["skill:__proto__"]).toContain("Prototype");
  expect(sections["skill:runtime"]).toContain("Reserved");
  expect(sections["skill:skill:a"]).toContain("Colon");
  expect(sections["skill:a"]).toContain("A");
  expect(pluginSkillsPromptSections([])).toEqual({});
});

describe("catalog grouping", () => {
  const grouped: PluginSkillDef[] = [
    { id: "qianning/writing-a", name: "Writing A", group: "Writing" },
    { id: "qianning/eng-b", name: "Engineering B", description: "Do B.", group: "Engineering" },
    { id: "demo.plugin/plain", name: "Plain" },
    { id: "qianning/writing-b", name: "Writing B", group: "Writing" },
  ];

  it("prints ungrouped entries flat, then one heading per group", () => {
    const lines = (pluginSkillsPrompt(grouped) ?? "").split("\n");
    const plain = lines.indexOf("- `demo.plugin/plain` — Plain");
    const engineering = lines.indexOf("## Engineering");
    const writing = lines.indexOf("## Writing");

    expect(plain).toBeGreaterThan(-1);
    expect(engineering).toBeGreaterThan(plain);
    expect(writing).toBeGreaterThan(engineering);
    expect(lines.indexOf("- `qianning/eng-b` — Engineering B: Do B.")).toBeGreaterThan(engineering);
    expect(lines.indexOf("- `qianning/writing-a` — Writing A")).toBeGreaterThan(writing);
    expect(lines.indexOf("- `qianning/writing-b` — Writing B")).toBeGreaterThan(writing);
  });

  it("keeps the rendering stable regardless of catalog order", () => {
    expect(pluginSkillsPrompt(grouped)).toBe(pluginSkillsPrompt([...grouped].reverse()));
  });

  it("still advertises every entry — grouping never filters", () => {
    const prompt = pluginSkillsPrompt(grouped) ?? "";
    for (const skill of grouped) expect(prompt).toContain(`\`${skill.id}\``);
    expect(prompt.split("\n").filter((line) => line.startsWith("- "))).toHaveLength(grouped.length);
  });

  it("gives each heading one own section key that cannot collide with a skill id", () => {
    const sections = pluginSkillsPromptSections(grouped);
    expect(sections["skill-group:Engineering"]).toBe("## Engineering");
    expect(sections["skill-group:Writing"]).toBe("## Writing");
    expect(Object.keys(sections).filter((key) => key.startsWith("skill-group:"))).toHaveLength(2);
    // An ungrouped catalog keeps exactly the old shape: header plus one line per id.
    expect(Object.keys(pluginSkillsPromptSections(skills))).toEqual([
      "skills",
      "skill:demo.hello/no-description",
      "skill:demo.hello/release-notes",
    ]);
  });
});
