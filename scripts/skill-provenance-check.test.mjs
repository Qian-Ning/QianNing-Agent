import assert from "node:assert/strict";
import test from "node:test";
import {
  checkSkillDocument,
  FORBIDDEN_PRODUCT_NAMES,
  ORIGIN_FIRST_LINE,
} from "./skill-provenance-check.mjs";

// The negative cases matter as much as the positive ones: a rule that fired on
// the lowercase `@pi-desktop` identifier would force authors to strip legitimate
// internal names out of every skill, and a rule that only looked for the
// presence of `## Origin` would pass a document crediting the wrong owner.
const compliant = [
  "---",
  "name: demo",
  "---",
  "",
  "# Demo",
  "",
  "One paragraph summary.",
  "",
  "## Origin",
  "",
  "QianNing Agent. Written in this repository.",
  "",
  "## Usage",
  "",
  "Body.",
].join("\n");

test("accepts a document with a compliant Origin section", () => {
  assert.deepEqual(checkSkillDocument("skills/demo.md", compliant), []);
});

test("accepts an Origin section written in another language after the name", () => {
  const text = compliant.replace(
    "QianNing Agent. Written in this repository.",
    "QianNing Agent。本仓库自有内容。",
  );
  assert.deepEqual(checkSkillDocument("skills/demo.md", text), []);
});

test("rejects a document with no Origin section", () => {
  const problems = checkSkillDocument("skills/demo.md", "# Demo\n\nBody.\n");
  assert.equal(problems.length, 1);
  assert.match(problems[0], /no "## Origin" section/);
});

test("rejects an empty Origin section", () => {
  const problems = checkSkillDocument("skills/demo.md", "# Demo\n\n## Origin\n\n\n");
  assert.equal(problems.length, 1);
  assert.match(problems[0], /is empty/);
});

test("rejects an Origin section whose only content is another heading", () => {
  const problems = checkSkillDocument("skills/demo.md", "# Demo\n\n## Origin\n\n## Usage\n");
  assert.equal(problems.length, 1);
  assert.ok(problems[0].includes(ORIGIN_FIRST_LINE));
});

test("rejects an Origin section that credits another owner", () => {
  const problems = checkSkillDocument(
    "skills/demo.md",
    "# Demo\n\n## Origin\n\nAdapted from another project.\n",
  );
  assert.equal(problems.length, 1);
  assert.ok(problems[0].includes(ORIGIN_FIRST_LINE));
});

test("rejects an upstream product name anywhere in the document", () => {
  const problems = checkSkillDocument(
    "skills/demo.md",
    `${compliant}\nThis demonstrates the ${FORBIDDEN_PRODUCT_NAMES[0]} plugin system.\n`,
  );
  assert.equal(problems.length, 1);
  assert.ok(problems[0].includes(FORBIDDEN_PRODUCT_NAMES[0]));
  assert.match(problems[0], /line 16/);
});

test("does not fire on lowercase internal identifiers", () => {
  const text = `${compliant}
The \`@pi-desktop/shared\` package and the \`pi-desktop/\` IPC prefix stay stable.
`;
  assert.deepEqual(checkSkillDocument("skills/demo.md", text), []);
});

test("tolerates CRLF line endings", () => {
  assert.deepEqual(checkSkillDocument("skills/demo.md", compliant.replace(/\n/g, "\r\n")), []);
});

test("reports each offending product name", () => {
  const problems = checkSkillDocument(
    "skills/demo.md",
    "# Demo\n\n## Origin\n\nQianNing Agent.\n\nPI-Desktop\n\nPI Desktop\n",
  );
  assert.equal(problems.length, FORBIDDEN_PRODUCT_NAMES.length);
});
