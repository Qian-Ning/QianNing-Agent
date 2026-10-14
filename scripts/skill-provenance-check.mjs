/**
 * Rules behind `scripts/check-skill-provenance.mjs`.
 *
 * CONTRIBUTING.md "Skill provenance" requires every skill document we author to
 * declare where it came from: an `## Origin` section whose first line is
 * `QianNing Agent`, and no upstream product name in the document, because a
 * skill ships to users and its text reaches the model. The brand contract lists
 * built-in plugin metadata among the QianNing Agent surfaces, so a skill is a
 * user-visible surface and the compatibility-identifier exception does not apply
 * to it.
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

/** The first line of `## Origin`, per CONTRIBUTING.md "Skill provenance". */
export const ORIGIN_FIRST_LINE = "QianNing Agent";

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
