import assert from "node:assert/strict";
import test from "node:test";

import promptLab, {
  composeSystemPrompt,
  interpolate,
  stripDocsBlock,
  stripIdentityLine,
} from "../resources/plugins/qianning.prompt-lab/src/extension.mjs";

const BASE = [
  "You are a coding assistant running inside the harness.",
  "",
  "## Tools",
  "read, write, edit",
  "",
  "<docs>",
  "Harness documentation, long and read-only.",
  "</docs>",
  "",
  "## Guidelines",
  "Prefer small diffs.",
].join("\n");

function session() {
  const handlers = new Map();
  const commands = new Map();
  const notes = [];
  const pi = {
    on(event, handler) {
      handlers.set(event, handler);
    },
    registerCommand(name, definition) {
      commands.set(name, definition);
    },
    ui: { notify: (message) => notes.push(message) },
  };
  promptLab(pi);
  return {
    start: (systemPrompt = BASE, cwd = "/repo") =>
      handlers.get("before_agent_start")({ systemPrompt, systemPromptOptions: { cwd } }),
    run: (args) => commands.get("promptlab").handler(args),
    notes,
  };
}

test("strict sends the persona and the working directory only", () => {
  const out = composeSystemPrompt({ mode: "strict", persona: "Be terse.", base: BASE, cwd: "/repo" });
  assert.equal(out, "Be terse.\n\nCurrent working directory: /repo");
  assert.ok(!out.includes("Tools"));
});

test("append keeps the harness prompt untouched, persona in front", () => {
  const out = composeSystemPrompt({ mode: "append", persona: "Be terse.", base: BASE, cwd: "/repo" });
  assert.ok(out.startsWith("Be terse.\n\n"));
  assert.ok(out.includes(BASE));
});

test("replace drops the identity line and the docs block, keeps the rest", () => {
  const out = composeSystemPrompt({ mode: "replace", persona: "Be terse.", base: BASE, cwd: "/repo" });
  assert.ok(!out.includes("running inside the harness"));
  assert.ok(!out.includes("Harness documentation"));
  assert.ok(out.includes("## Tools"));
  assert.ok(out.includes("Prefer small diffs."));
});

test("replace falls back to the whole prompt when the identity line is not found", () => {
  const unknown = "## Tools\nread, write\n\n## Guidelines\nBe careful.";
  const out = composeSystemPrompt({ mode: "replace", persona: "Be terse.", base: unknown, cwd: "/repo" });
  assert.ok(out.includes(unknown), "an unrecognised harness prompt is left intact");
});

test("a persona without the directory placeholder is sent as written", () => {
  assert.equal(interpolate("Be terse.", "/repo"), "Be terse.");
  assert.equal(interpolate("cwd is {{cwd}}", "/repo"), "cwd is /repo");
  assert.equal(interpolate("cwd is {{cwd}}\n", ""), "cwd is\n");
});

test("the docs block is left alone when the tags are absent", () => {
  const text = "Documentation without tags.";
  assert.deepEqual(stripDocsBlock(text), { text, found: false });
});

test("the identity strip reports whether it found anything", () => {
  assert.equal(stripIdentityLine("nothing to cut").found, false);
  assert.equal(stripIdentityLine("You are a coding assistant running inside x.\nbody").found, true);
});

test("nothing changes until the command is run", () => {
  const s = session();
  assert.equal(s.start(), undefined);
});

test("toggling on rewrites the prompt, toggling off stops it", async () => {
  const s = session();
  await s.run("on");
  const out = s.start();
  assert.equal(typeof out.systemPrompt, "string");
  assert.ok(!out.systemPrompt.includes("Tools"));
  await s.run("off");
  assert.equal(s.start(), undefined);
});

test("mode and status are reported back to the user", async () => {
  const s = session();
  await s.run("mode strict");
  await s.run("on");
  await s.run("status");
  const last = s.notes.at(-1);
  assert.match(last, /enabled: true/);
  assert.match(last, /mode: strict/);
  assert.match(last, /source: embedded/);
});

test("an unknown mode is refused without changing the current one", async () => {
  const s = session();
  await s.run("mode append");
  await s.run("mode nonsense");
  assert.match(s.notes.at(-1), /mode must be one of/);
  await s.run("status");
  assert.match(s.notes.at(-1), /mode: append/);
});
