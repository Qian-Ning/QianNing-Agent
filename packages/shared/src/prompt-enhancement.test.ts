import { describe, expect, it } from "vitest";
import {
  PROMPT_ENHANCEMENT_DEFAULT_SYSTEM_PROMPT,
  PROMPT_ENHANCEMENT_DEFAULT_USER_TEMPLATE,
  PROMPT_ENHANCEMENT_DRAFT_VARIABLE,
  renderPromptEnhancementUserPrompt,
} from "./prompt-enhancement.js";

describe("prompt-enhancement defaults", () => {
  it("opens with exactly one wrapping tag pair around the draft", () => {
    const template = PROMPT_ENHANCEMENT_DEFAULT_USER_TEMPLATE;
    expect(template).toContain(PROMPT_ENHANCEMENT_DRAFT_VARIABLE);
    expect(template).toMatch(/^<draft>\n\{\{draft\}\}\n<\/draft>/);
    expect(template.match(/<\/draft>/g)).toHaveLength(1);
  });
  it("carries the contract the old single-line prompt lacked", () => {
    const system = PROMPT_ENHANCEMENT_DEFAULT_SYSTEM_PROMPT;
    // Language following without meta notes.
    expect(system).toContain("same language as the draft");
    expect(system).toContain("no language labels or meta notes");
    // Proper-noun protection: the largest missing constraint before this change.
    expect(system).toContain("proper nouns");
    expect(system).toContain("reproduce them exactly as written");
    // Length brake and the explicit do-not list.
    expect(system).toContain("twice the draft's length");
    expect(system).not.toContain("800 characters");
    expect(system).toContain("DO NOT:");
    expect(system).toContain("Answer, execute, or fulfil the draft's request");
    // Output contract.
    expect(system).toContain("wrapping quotation marks");
    expect(system).toContain("Never end with an unfinished list");
  });

  it("keeps few-shot coverage for Chinese, English, and mixed input", () => {
    const template = PROMPT_ENHANCEMENT_DEFAULT_USER_TEMPLATE;
    expect(template).toContain("帮我看看这段代码");
    expect(template).toContain("fix the login bug");
    expect(template).toContain("这个函数有点慢，can you make it faster");
    // The meta-note failure mode is explicit, without an `Enhanced:` prefix
    // the model would copy into the Composer.
    expect(template).toContain("Never emit");
    expect(template).not.toContain("Enhanced:");
    expect(template).toContain("<example-draft>");
  });
});

describe("renderPromptEnhancementUserPrompt", () => {
  it("wraps the draft in the default template's tags", () => {
    const content = renderPromptEnhancementUserPrompt("  clear this up  ");
    expect(content).toContain("<draft>\n  clear this up  \n</draft>");
    expect(content).not.toContain(PROMPT_ENHANCEMENT_DRAFT_VARIABLE);
  });

  it("inserts a draft containing replacement-pattern sequences literally", () => {
    // `$&`, `$'`, `` $` `` and `$1` are String.replace patterns; a string
    // replacement would expand them here and corrupt the draft.
    const draft = "keep $& and $' and $1 and $` literally";
    const content = renderPromptEnhancementUserPrompt(draft);
    expect(content).toContain(draft);
  });

  it("substitutes every occurrence of the variable", () => {
    const content = renderPromptEnhancementUserPrompt("X");
    expect(content.split(PROMPT_ENHANCEMENT_DRAFT_VARIABLE)).toHaveLength(1);
    expect(content).toContain("X");
  });
});
