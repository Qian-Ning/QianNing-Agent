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

  it("indexes each group in one line instead of listing its members", () => {
    const lines = (pluginSkillsPrompt(grouped) ?? "").split(String.fromCharCode(10));
    const plain = lines.indexOf("- `demo.plugin/plain` — Plain");
    const engineering = lines.findIndex((line) => line.includes("group:Engineering"));
    const writing = lines.findIndex((line) => line.includes("group:Writing"));

    // Ungrouped (third-party) entries stay flat and addressable by id.
    expect(plain).toBeGreaterThan(-1);
    // A group costs one line, ordered after the flat entries.
    expect(engineering).toBeGreaterThan(plain);
    expect(writing).toBeGreaterThan(engineering);
    // That line carries the count and a teaser, not the member ids.
    expect(lines[engineering]).toContain("Engineering (1)");
    expect(lines[engineering]).toContain("Engineering B");
    expect(lines[writing]).toContain("Writing (2)");
    expect(lines.join(String.fromCharCode(10))).not.toContain("- `qianning/eng-b`");
  });

  it("keeps the rendering stable regardless of catalog order", () => {
    expect(pluginSkillsPrompt(grouped)).toBe(pluginSkillsPrompt([...grouped].reverse()));
  });

  it("advertises ungrouped entries by id and grouped ones by index", () => {
    const prompt = pluginSkillsPrompt(grouped) ?? "";
    expect(prompt).toContain("`demo.plugin/plain`");
    expect(prompt).toContain("group:Engineering");
    expect(prompt).toContain("group:Writing");
    // The member descriptions are what the index call is for.
    expect(prompt).not.toContain("Do B.");
  });

  it("gives each heading one own section key that cannot collide with a skill id", () => {
    const sections = pluginSkillsPromptSections(grouped);
    expect(sections["skill-group:Engineering"] ?? "").toContain("group:Engineering");
    expect(sections["skill-group:Writing"] ?? "").toContain("group:Writing");
    expect(Object.keys(sections).filter((key) => key.startsWith("skill-group:"))).toHaveLength(2);
    // An ungrouped catalog keeps exactly the old shape: header plus one line per id.
    expect(Object.keys(pluginSkillsPromptSections(skills))).toEqual([
      "skills",
      "skill:demo.hello/no-description",
      "skill:demo.hello/release-notes",
    ]);
  });
});
