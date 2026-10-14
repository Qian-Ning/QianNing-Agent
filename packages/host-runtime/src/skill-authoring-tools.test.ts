import { describe, expect, it } from "vitest";
import type { LocalToolHandler } from "./agent-sidecar.js";
import { registerSkillAuthoringTools } from "./skill-authoring-tools.js";

/**
 * These cover the contract the model sees: what is refused, what is forwarded,
 * and that a host failure returns as a tool result rather than an exception.
 * Whether the tool is actually advertised is asserted where the catalogue is
 * built, in the desktop test suite.
 */

type CreateInput = { name: string; description?: string; body: string };

function setup(create: (input: CreateInput) => Promise<unknown>) {
  const handlers = new Map<string, LocalToolHandler>();
  const seen: CreateInput[] = [];
  registerSkillAuthoringTools(
    {
      setLocalTool: (name: string, handler: LocalToolHandler) => {
        handlers.set(name, handler);
      },
    },
    {
      createUserSkill: async (input) => {
        seen.push(input);
        return create(input);
      },
    },
  );
  const handler = handlers.get("SkillCreate");
  if (!handler) throw new Error("SkillCreate was not registered");
  const call = (args: unknown) =>
    handler({ args, sessionId: "s1", toolCallId: "t1", signal: new AbortController().signal });
  return { call, seen };
}

const created = async () => ({ skill: { id: "my-procedure" } });

describe("SkillCreate", () => {
  it("refuses a missing name before reaching host-core", async () => {
    const { call, seen } = setup(created);
    const result = await call({ body: "steps" });
    expect(result.ok).toBe(false);
    expect(result.content).toContain("`name` is required");
    expect(seen).toHaveLength(0);
  });

  it("refuses a missing body", async () => {
    const { call } = setup(created);
    const result = await call({ name: "My procedure" });
    expect(result.ok).toBe(false);
    expect(result.content).toContain("`body` is required");
  });

  it("treats a whitespace-only field as missing", async () => {
    const { call } = setup(created);
    expect((await call({ name: "   ", body: "steps" })).ok).toBe(false);
    expect((await call({ name: "X", body: "  \n " })).ok).toBe(false);
  });

  it("forwards the trimmed fields and reports the created id", async () => {
    const { call, seen } = setup(created);
    const result = await call({
      name: "  My procedure  ",
      description: "  when X  ",
      body: "  steps  ",
    });
    expect(seen).toEqual([{ name: "My procedure", description: "when X", body: "steps" }]);
    expect(result.ok).toBe(true);
    expect(result.content).toContain("my-procedure");
  });

  it("omits an empty description rather than sending an empty string", async () => {
    const { call, seen } = setup(created);
    await call({ name: "X", body: "steps" });
    expect(seen).toEqual([{ name: "X", description: undefined, body: "steps" }]);
  });

  it("surfaces a host rejection as a tool failure, not an exception", async () => {
    const { call } = setup(async () => {
      throw new Error("SKILL_INVALID: a skill with this name already exists at this level");
    });
    const result = await call({ name: "X", body: "steps" });
    expect(result.ok).toBe(false);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("already exists");
  });
});
