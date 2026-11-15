import { describe, expect, it } from "vitest";

import {
  composePersonaParts,
  resolveSystemPromptMode,
  SYSTEM_PROMPT_MODES,
} from "./system-prompt-mode.js";

const DEFAULT_PARTS = ["You are the built-in persona.", "## Safety\nNever print a secret."];

describe("resolveSystemPromptMode", () => {
  it("defaults to replace so a stored value that predates the setting keeps today's behaviour", () => {
    expect(resolveSystemPromptMode(undefined)).toBe("replace");
    expect(resolveSystemPromptMode(null)).toBe("replace");
    expect(resolveSystemPromptMode("")).toBe("replace");
    expect(resolveSystemPromptMode("strict")).toBe("replace");
  });

  it("accepts append and nothing else", () => {
    expect(resolveSystemPromptMode("append")).toBe("append");
    expect(SYSTEM_PROMPT_MODES).toEqual(["replace", "append"]);
  });
});

describe("composePersonaParts", () => {
  it("replace sends the custom prompt instead of the built-in persona", () => {
    expect(
      composePersonaParts({ persona: "Be terse.", mode: "replace", defaultParts: DEFAULT_PARTS }),
    ).toEqual(["Be terse."]);
  });

  it("append keeps the built-in persona and adds the custom one after it", () => {
    expect(
      composePersonaParts({ persona: "Be terse.", mode: "append", defaultParts: DEFAULT_PARTS }),
    ).toEqual(["You are the built-in persona.", "Be terse."]);
  });

  it("without a custom prompt both modes send the built-in persona", () => {
    for (const mode of SYSTEM_PROMPT_MODES) {
      expect(composePersonaParts({ persona: undefined, mode, defaultParts: DEFAULT_PARTS })).toEqual([
        "You are the built-in persona.",
      ]);
    }
  });

  it("a whitespace-only prompt counts as no prompt, never as an empty persona", () => {
    for (const mode of SYSTEM_PROMPT_MODES) {
      expect(composePersonaParts({ persona: "   \n ", mode, defaultParts: DEFAULT_PARTS })).toEqual([
        "You are the built-in persona.",
      ]);
    }
  });

  it("never returns the operational rules, so they cannot be replaced or dropped here", () => {
    for (const mode of SYSTEM_PROMPT_MODES) {
      const parts = composePersonaParts({ persona: "Be terse.", mode, defaultParts: DEFAULT_PARTS });
      expect(parts).not.toContain(DEFAULT_PARTS[1]);
    }
  });
});
