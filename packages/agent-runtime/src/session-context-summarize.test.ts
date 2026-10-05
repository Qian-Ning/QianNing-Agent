import { describe, expect, it } from "vitest";
import {
  cleanSummarizedContext,
  sessionContextSummarizeContext,
  SESSION_CONTEXT_SUMMARIZE_SYSTEM_PROMPT,
} from "./session-context-summarize.js";

describe("cleanSummarizedContext", () => {
  it("trims surrounding whitespace", () => {
    expect(cleanSummarizedContext("  \n  Goal: ship the feature.\n  ")).toBe(
      "Goal: ship the feature.",
    );
  });

  it("unwraps a single outer markdown code fence", () => {
    const raw = "```md\nGoal: refactor auth.\nNext: write tests.\n```";
    expect(cleanSummarizedContext(raw)).toBe(
      "Goal: refactor auth.\nNext: write tests.",
    );
  });

  it("unwraps a bare fence with no language tag", () => {
    const raw = "```\n进度：已完成登录模块。\n```";
    expect(cleanSummarizedContext(raw)).toBe("进度：已完成登录模块。");
  });

  it("keeps inner fenced code blocks intact", () => {
    // Only the outermost full-wrap fence is stripped; embedded snippets stay.
    const raw = "Current diff:\n```ts\nconst a = 1;\n```\nNext: run it.";
    expect(cleanSummarizedContext(raw)).toBe(raw);
  });
});

describe("sessionContextSummarizeContext", () => {
  it("embeds the transcript under a handoff instruction", () => {
    const ctx = sessionContextSummarizeContext("User: hi\n\nAssistant: hello");
    expect(ctx.systemPrompt).toBe(SESSION_CONTEXT_SUMMARIZE_SYSTEM_PROMPT);
    expect(ctx.messages).toHaveLength(1);
    expect(ctx.messages[0]?.role).toBe("user");
    expect(ctx.messages[0]?.content).toContain("Conversation to summarize:");
    expect(ctx.messages[0]?.content).toContain("User: hi");
  });

  it("instructs the model to write forward-carried context, not a reply", () => {
    expect(SESSION_CONTEXT_SUMMARIZE_SYSTEM_PROMPT).toContain(
      "primary language of the conversation",
    );
    expect(SESSION_CONTEXT_SUMMARIZE_SYSTEM_PROMPT).toContain(
      "context to carry forward",
    );
  });

  it("caps an oversized transcript before sending it to the model", () => {
    const huge = "x".repeat(50000);
    const ctx = sessionContextSummarizeContext(huge);
    // The embedded transcript is bounded well under the raw input length.
    expect(ctx.messages[0]?.content.length).toBeLessThanOrEqual(32000 + 64);
  });
});
