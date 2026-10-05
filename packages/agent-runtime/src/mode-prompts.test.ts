import { describe, expect, it } from "vitest";
import {
  composeModeSystemPrompt,
  DEFAULT_RUNTIME_SYSTEM_PROMPT,
  GOAL_MODE_SYSTEM_PROMPT,
  PLAN_MODE_SYSTEM_PROMPT,
  PRODUCT_IDENTITY_SYSTEM_PROMPT,
} from "./mode-prompts.js";

describe("built-in runtime persona", () => {
  it("states the official Chinese product name as a positive fact", () => {
    expect(DEFAULT_RUNTIME_SYSTEM_PROMPT).toContain("QianNing Agent");
    expect(DEFAULT_RUNTIME_SYSTEM_PROMPT).toContain("千凝");
    expect(PRODUCT_IDENTITY_SYSTEM_PROMPT).toContain("千凝");
    // State the right name; never seed the model with a wrong homophone.
    for (const wrong of ["乾宁", "千宁"]) {
      expect(DEFAULT_RUNTIME_SYSTEM_PROMPT).not.toContain(wrong);
      expect(PRODUCT_IDENTITY_SYSTEM_PROMPT).not.toContain(wrong);
    }
  });

  it("opens with the persona line a custom prompt replaces", () => {
    // The per-conversation prompt swaps this first layer out; the wording is
    // pinned so the swap stays detectable.
    expect(
      DEFAULT_RUNTIME_SYSTEM_PROMPT.startsWith(
        "You are QianNing Agent, a coding agent.",
      ),
    ).toBe(true);
  });
});

describe("mode-specific system prompts", () => {
  it("composes Plan instructions over the shared runtime prompt", () => {
    const prompt = composeModeSystemPrompt("plan", "base instructions");

    expect(prompt).toContain("base instructions");
    expect(prompt).toContain(PLAN_MODE_SYSTEM_PROMPT);
    expect(prompt).toContain("Inspect the workspace");
    expect(prompt).toContain("SubmitPlan");
    expect(prompt).toContain("When any initial or revised plan is ready");
    expect(prompt).toContain("immediately exactly once in the current turn");
    expect(prompt).toContain("one complete Markdown snapshot");
    expect(prompt).toContain("Do not write or edit a plan file yourself");
    expect(prompt).toContain("host writes a new .pi/plan artifact");
    expect(prompt).toContain("An accepted new Plan prompt means no prior approval is pending");
    expect(prompt).toContain("historical immutable checkpoints");
    expect(prompt).toContain("After reject, expiry, or interruption");
    expect(prompt).toContain("follow the same one-SubmitPlan rule");
    expect(prompt).toContain("Do not wait for chat confirmation");
    expect(prompt).toContain("Do not use Write, Edit");
    expect(prompt).toContain("Do not create, overwrite, delete, or otherwise mutate workspace files in Plan mode");
    expect(prompt).toContain("including through Bash");
    expect(prompt).toContain("ask them to switch to Agent mode");
    expect(prompt).toContain("Plugin tools that declare plan-safe actions are available for inspection");
    expect(prompt).toContain("Bash is available under the active permission policy");
  });

  it("composes Goal instructions asking for a contract, not steps", () => {
    const prompt = composeModeSystemPrompt("goal", "base instructions");

    expect(prompt).toContain("base instructions");
    expect(prompt).toContain(GOAL_MODE_SYSTEM_PROMPT);
    expect(prompt).toContain("SubmitGoal");
    expect(prompt).toContain("acceptance criteria");
    expect(prompt).toContain("boundaries");
    expect(prompt).toContain("Do not enumerate implementation steps");
    expect(prompt).toContain("host writes a new .pi/goal artifact");
    expect(prompt).toContain("follow the same one-SubmitGoal rule");
    expect(prompt).toContain("pursue it autonomously");
    expect(prompt).toContain("Do not use Write, Edit");
    expect(prompt).toContain("Do not create, overwrite, delete, or otherwise mutate workspace files in Goal mode");
    // Goal mode negotiates outcomes; the Plan contract must not leak into it.
    expect(prompt).not.toContain("SubmitPlan");
    expect(prompt).not.toContain(PLAN_MODE_SYSTEM_PROMPT);
  });

  it("keeps Agent composition separate from Plan composition", () => {
    const prompt = composeModeSystemPrompt("agent", "base instructions");

    expect(prompt).toContain("operating in Agent mode");
    expect(prompt).not.toContain("Do not use Write, Edit");
    expect(prompt).not.toContain("SubmitGoal");
  });
});
