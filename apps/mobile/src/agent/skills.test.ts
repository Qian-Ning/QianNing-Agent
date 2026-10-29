import { describe, expect, it } from "vitest";
import { bundledSkills, findBundledSkill, skillCatalogSection } from "./skills";
import { createTools } from "./tools";
import { MemoryStore } from "./store";

describe("bundled skills", () => {
  it("ships the first-party set with parsed frontmatter", () => {
    const skills = bundledSkills();
    expect(skills.length).toBeGreaterThan(50);

    const sample = skills.find((skill) => skill.id === "qianning/chinese-novel-writing");
    expect(sample).toBeDefined();
    expect(sample!.description.length).toBeGreaterThan(10);
    expect(sample!.body.length).toBeGreaterThan(200);
    expect(sample!.body.startsWith("---")).toBe(false);
  });

  it("gives every skill a unique id and a name", () => {
    const skills = bundledSkills();
    const ids = new Set(skills.map((skill) => skill.id));
    expect(ids.size).toBe(skills.length);
    expect(skills.every((skill) => skill.name.length > 0)).toBe(true);
  });

  it("resolves a skill by id, file name or display name", () => {
    expect(findBundledSkill("qianning/code-reading")?.file).toBe("code-reading.md");
    expect(findBundledSkill("code-reading")?.file).toBe("code-reading.md");
    expect(findBundledSkill("QIANNING/CODE-READING")?.file).toBe("code-reading.md");
    expect(findBundledSkill("no-such-skill")).toBeNull();
  });

  it("advertises every skill in the catalog section", () => {
    const section = skillCatalogSection();
    expect(section.startsWith("# Skills")).toBe(true);
    expect(section).toContain("`qianning/chinese-novel-writing`");
    expect(section).toContain("`Skill` tool");
  });
});

describe("Skill tool", () => {
  it("returns the body of a known skill", async () => {
    const tools = createTools(new MemoryStore());
    const tool = tools.find((entry) => entry.name === "Skill")!;
    const result = await tool.execute("call-1", { id: "qianning/code-reading" });
    const content = (result as { content: Array<{ text: string }> }).content[0].text;
    expect(content.startsWith("# ")).toBe(true);
    expect(content.length).toBeGreaterThan(200);
  });

  it("names the available ids when the id is unknown", async () => {
    const tools = createTools(new MemoryStore());
    const tool = tools.find((entry) => entry.name === "Skill")!;
    const result = await tool.execute("call-2", { id: "qianning/nope" });
    const failed = result as { isError?: boolean; content: Array<{ text: string }> };
    expect(failed.isError).toBe(true);
    expect(failed.content[0].text).toContain("qianning/");
  });
});
