/**
 * The first-party skills, on a phone.
 *
 * The desktop ships `apps/desktop/resources/skills/*.md` and advertises them as a
 * catalog the model can pull bodies from on demand (D174). A phone has the same
 * model and the same tasks, so it ships the same documents: `build-shared-surface`
 * copies them into `public/skills`, and this module turns that folder into the
 * same catalog-plus-tool pair. Nothing here is phone-specific except where the
 * files come from.
 */

export type BundledSkill = {
  /** `qianning/<file name>` — the id the model passes to the `Skill` tool. */
  id: string;
  name: string;
  description: string;
  body: string;
  /** File name inside the bundled folder, for the settings list. */
  file: string;
};

// Read straight from the desktop's shipped folder: one source of truth for both
// surfaces, and the bundle carries the text so no runtime copy step can drift.
const FILES = import.meta.glob("../../../../apps/desktop/resources/skills/*.md", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

type Frontmatter = { name?: string; description?: string };

/** Reads the small `---` block the skill format puts at the top of every file. */
function splitFrontmatter(raw: string): { data: Frontmatter; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!match) return { data: {}, body: raw.trim() };
  const data: Frontmatter = {};
  for (const line of match[1].split(/\r?\n/)) {
    const pair = /^([a-zA-Z]+):\s*(.*)$/.exec(line.trim());
    if (!pair) continue;
    if (pair[1] === "name") data.name = pair[2].trim();
    if (pair[1] === "description") data.description = pair[2].trim();
  }
  return { data, body: raw.slice(match[0].length).trim() };
}

function idForFile(file: string): string {
  return `qianning/${file.replace(/\.md$/i, "")}`;
}

let cached: BundledSkill[] | null = null;

/** Every bundled skill, sorted by id so the catalog never reshuffles. */
export function bundledSkills(): BundledSkill[] {
  if (cached) return cached;
  const skills: BundledSkill[] = [];
  for (const [path, raw] of Object.entries(FILES)) {
    const file = path.split("/").pop() ?? path;
    const { data, body } = splitFrontmatter(raw);
    const fallbackName = file.replace(/\.md$/i, "").replace(/-/g, " ");
    skills.push({
      id: idForFile(file),
      name: data.name?.trim() || fallbackName,
      description: data.description?.trim() || "",
      body,
      file,
    });
  }
  skills.sort((a, b) => a.id.localeCompare(b.id));
  cached = skills;
  return skills;
}

export function findBundledSkill(id: string): BundledSkill | null {
  const wanted = id.trim().toLowerCase();
  return (
    bundledSkills().find((skill) => skill.id.toLowerCase() === wanted) ??
    bundledSkills().find(
      (skill) =>
        skill.file.replace(/\.md$/i, "").toLowerCase() === wanted ||
        skill.name.toLowerCase() === wanted,
    ) ??
    null
  );
}

/**
 * The catalog section for the system prompt. Only id, name and description ship
 * up front — a body costs nothing until the model asks for it, which is the whole
 * reason skills are model-invoked rather than pasted into every prompt.
 */
export function skillCatalogSection(skills: BundledSkill[] = bundledSkills()): string {
  if (skills.length === 0) return "";
  const lines = [
    "# Skills",
    "",
    "You have the following skills. Each entry is a set of instructions you can load with the `Skill` tool by passing its exact id. When a task matches a skill's description, load the skill first and follow it; do not guess at its content. Load each skill at most once per task.",
    "",
    ...skills.map(
      (skill) =>
        `- \`${skill.id}\` — ${skill.name}${skill.description ? `: ${skill.description}` : ""}`,
    ),
  ];
  return lines.join("\n");
}
