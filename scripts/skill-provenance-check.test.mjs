import assert from "node:assert/strict";
import test from "node:test";
import {
  FORBIDDEN_PRODUCT_NAMES,
  ORIGIN_FIRST_LINE,
  checkPluginManifest,
  checkSkillDocument,
  isPluginManifestPath,
  isSkillDocumentPath,
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

test("accepts a manifest whose author is a plain string", () => {
  const manifest = JSON.stringify({ schemaVersion: 1, id: "demo.x", author: "QianNing Agent" });
  assert.deepEqual(checkPluginManifest("examples/plugins/x/manifest.json", manifest), []);
});

test("accepts a manifest whose author is a contact object", () => {
  const manifest = JSON.stringify({
    schemaVersion: 1,
    id: "demo.x",
    author: { name: "Tioit-Wang", url: "https://example.invalid" },
  });
  assert.deepEqual(checkPluginManifest("examples/plugins/x/manifest.json", manifest), []);
});

test("rejects a manifest with no author", () => {
  const manifest = JSON.stringify({ schemaVersion: 1, id: "demo.x", name: "X" });
  const problems = checkPluginManifest("examples/plugins/x/manifest.json", manifest);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /no author/);
});

test("rejects an author object without a name", () => {
  const manifest = JSON.stringify({ schemaVersion: 1, id: "demo.x", author: { url: "x" } });
  const problems = checkPluginManifest("examples/plugins/x/manifest.json", manifest);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /no author/);
});

test("rejects a manifest carrying the upstream product name", () => {
  const manifest = JSON.stringify({
    schemaVersion: 1,
    id: "demo.x",
    author: "QianNing Agent",
    description: "PI-Desktop sample plugin",
  });
  const problems = checkPluginManifest("examples/plugins/x/manifest.json", manifest);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /upstream product name/);
});

test("rejects a manifest that does not parse", () => {
  const problems = checkPluginManifest("examples/plugins/x/manifest.json", "{ not json");
  assert.equal(problems.length, 1);
  assert.match(problems[0], /does not parse/);
});

test("skips a JSON file that is not a plugin manifest", () => {
  // A package.json-shaped file has no schemaVersion; the rule leaves it alone so
  // the directory guard cannot turn an unrelated file into a failure.
  const text = JSON.stringify({ name: "unrelated", version: "1.0.0" });
  assert.deepEqual(checkPluginManifest("somewhere/manifest.json", text), []);
});

test("isPluginManifestPath accepts a repository-root plugins directory", () => {
  assert.equal(isPluginManifestPath("plugins/manifest.json"), true);
});

test("isPluginManifestPath accepts a nested plugin directory", () => {
  assert.equal(
    isPluginManifestPath("examples/plugins/hello/manifest.json"),
    true,
  );
  assert.equal(
    isPluginManifestPath(
      "apps/desktop/resources/plugins/pi.browser/manifest.json",
    ),
    true,
  );
});

test("isPluginManifestPath rejects a manifest outside a plugins directory", () => {
  assert.equal(isPluginManifestPath("apps/desktop/public/manifest.json"), false);
  assert.equal(isPluginManifestPath("manifest.json"), false);
});

test("isPluginManifestPath rejects a non-manifest file in a plugins directory", () => {
  assert.equal(
    isPluginManifestPath("examples/plugins/hello/plugin.json"),
    false,
  );
});

test("isPluginManifestPath does not match a directory merely named like one", () => {
  assert.equal(
    isPluginManifestPath("docs/plugins-reference/manifest.json"),
    false,
  );
});

test("isSkillDocumentPath accepts markdown inside a skills directory", () => {
  assert.equal(
    isSkillDocumentPath("apps/desktop/resources/skills/imagegen.md"),
    true,
  );
  assert.equal(
    isSkillDocumentPath("examples/plugins/hello/skills/hello.md"),
    true,
  );
});

test("isSkillDocumentPath accepts a SKILL.md at any depth", () => {
  assert.equal(isSkillDocumentPath("SKILL.md"), true);
  assert.equal(isSkillDocumentPath("skills/deep/nested/SKILL.md"), true);
});

test("isSkillDocumentPath rejects ordinary specification markdown", () => {
  assert.equal(
    isSkillDocumentPath("docs/spec/07-plugins/01-plugin-system.md"),
    false,
  );
  assert.equal(
    isSkillDocumentPath("apps/desktop/resources/skills/README.txt"),
    false,
  );
});
