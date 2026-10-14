/**
 * Rules behind `scripts/check-skill-provenance.mjs`.
 *
 * CONTRIBUTING.md "Skill and plugin provenance" requires every skill document we
 * author to declare where it came from: an `## Origin` section whose first line
 * is `QianNing Agent`, and no upstream product name, because a skill ships to
 * users and its text reaches the model. A shipped plugin manifest is held to the
 * same standard, since its `name`, `description` and `manifest.i18n` strings are
 * display text and its `author` must name the plugin's real origin. The brand
 * contract lists built-in plugin metadata among the QianNing Agent surfaces, so
 * neither artifact may use the compatibility-identifier exception.
 *
 * Product names a shipped skill must not carry. `PI-Desktop` is the upstream
 * distribution this repository derives from; a user-visible surface names the
 * shipped product instead. Add a name here only when it is a product name that
 * reaches users — not an internal identifier such as the `@pi-desktop` package
 * scope, which the brand contract keeps stable on purpose and which never
 * appears in a skill document. The comparison is case-sensitive on purpose, so
 * lowercase internal identifiers stay legal.
 */
export const FORBIDDEN_PRODUCT_NAMES = ["PI-Desktop", "PI Desktop"];

/** A plugin manifest, discovered by name inside a `plugins/` directory. */
export const PLUGIN_MANIFEST_BASENAME = "manifest.json";

/**
 * Validate one plugin manifest. Returns an array of problems; empty means the
 * manifest satisfies the provenance rule.
 *
 * The manifest is held to the same standard as a skill document because it is
 * the same kind of surface: `manifest.i18n` and the base `name`/`description`
 * are display strings a user reads in the plugin list, so they must name the
 * shipped product, and `author` must name the plugin's real origin — a vendored
 * or third-party plugin keeps its own author rather than being relabelled.
 *
 * A manifest without `schemaVersion` is not a plugin manifest and is skipped,
 * so directory discovery can stay broad without failing on unrelated files.
 */
export function checkPluginManifest(relPath, text) {
  const problems = [];
  let manifest;
  try {
    manifest = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    problems.push(`${relPath}: manifest does not parse as JSON`);
    return problems;
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    problems.push(`${relPath}: manifest is not an object`);
    return problems;
  }
  if (manifest.schemaVersion === undefined) return problems;

  const author = manifest.author;
  const authorName =
    typeof author === "string"
      ? author.trim()
      : typeof (author && author.name) === "string"
        ? author.name.trim()
        : "";
  if (!authorName) {
    problems.push(`${relPath}: no author; shipped plugin metadata names its real origin`);
  }

  for (const name of FORBIDDEN_PRODUCT_NAMES) {
    if (text.includes(name)) {
      const where = text.split(/\r?\n/).findIndex((line) => line.includes(name)) + 1;
      problems.push(
        `${relPath}: carries the upstream product name "${name}" (line ${where}); user-visible surfaces name the shipped product`,
      );
    }
  }

  return problems;
}

/** The first line of `## Origin`, per CONTRIBUTING.md "Skill and plugin provenance". */
export const ORIGIN_FIRST_LINE = "QianNing Agent";

/**
 * Whether a repository-relative path is a plugin manifest to police.
 *
 * Scoped to a `plugins/` path segment because `manifest.json` is a generic file
 * name that web app manifests also use. The segment may be the first one — a
 * repository-root `plugins/` directory is as valid as a nested example's — so
 * this matches a leading segment as well as an interior one.
 */
export function isPluginManifestPath(relPath) {
  const parts = relPath.split("/");
  return (
    parts[parts.length - 1] === PLUGIN_MANIFEST_BASENAME &&
    parts.slice(0, -1).includes("plugins")
  );
}

/**
 * Whether a repository-relative path is a skill document to police.
 *
 * A skill document is markdown inside a `skills/` directory, or a `SKILL.md`
 * wherever it lives.
 */
export function isSkillDocumentPath(relPath) {
  const parts = relPath.split("/");
  const name = parts[parts.length - 1];
  if (name === "SKILL.md") return true;
  return name.endsWith(".md") && parts.slice(0, -1).includes("skills");
}

const ORIGIN_HEADING = /^##[ \t]+Origin[ \t]*$/m;

/**
 * Validate one skill document. Returns an array of problems; empty means the
 * document satisfies the provenance rule.
 *
 * `relPath` is used only in messages, so the caller keeps its own path style.
 */
export function checkSkillDocument(relPath, text) {
  const problems = [];
  const lines = text.split(/\r?\n/);

  const headingIndex = lines.findIndex((line) => ORIGIN_HEADING.test(line));
  if (headingIndex === -1) {
    problems.push(`${relPath}: no "## Origin" section`);
  } else {
    const firstLine = lines
      .slice(headingIndex + 1)
      .find((line) => line.trim().length > 0);
    if (firstLine === undefined) {
      problems.push(`${relPath}: "## Origin" section is empty`);
    } else if (!firstLine.trimStart().startsWith(ORIGIN_FIRST_LINE)) {
      problems.push(
        `${relPath}: "## Origin" must open with "${ORIGIN_FIRST_LINE}", found "${firstLine.trim().slice(0, 60)}"`,
      );
    }
  }

  for (const name of FORBIDDEN_PRODUCT_NAMES) {
    if (text.includes(name)) {
      const where = lines.findIndex((line) => line.includes(name)) + 1;
      problems.push(
        `${relPath}: carries the upstream product name "${name}" (line ${where}); user-visible surfaces name the shipped product`,
      );
    }
  }

  return problems;
}
