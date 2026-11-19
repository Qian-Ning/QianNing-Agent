import { describe, expect, it, vi } from "vitest";
import { createModels, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { compact, generateSummaryWithUsage } from "./pi-runtime-compaction-summary.js";
import type { CompactionPreparation } from "./pi-runtime-types.js";

const model: Model<"openai-completions"> = {
  id: "fixture", name: "Fixture", api: "openai-completions", provider: "fixture",
  baseUrl: "https://fixture.invalid/v1", reasoning: false, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000, maxTokens: 4096,
};
const usage = {
  input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
function answer(text: string): AssistantMessage {
  return { role: "assistant", api: "openai-completions", provider: "fixture", model: "fixture",
    content: [{ type: "text", text }], stopReason: "stop", timestamp: 1, usage };
}
function user(text: string): AgentMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp: 1 };
}
function preparation(): CompactionPreparation {
  return { messagesToSummarize: [user("Preserve the investigation history.")],
    turnPrefixMessages: [], retainedTail: [user("Continue here.")], isSplitTurn: false,
    tokensBefore: 1000, fileOps: { read: new Set(["read.ts"]), written: new Set(["new.ts"]), edited: new Set(["edit.ts"]) },
    settings: { enabled: true, reserveTokens: 2048, keepRecentTokens: 1000 } };
}
const looping = "This summary repeats the same sentence without preserving any new details. ".repeat(12);

describe("compaction summary quality", () => {
  it("rejects repetition from the main compaction path without mutating its input", async () => {
    const models = createModels();
    vi.spyOn(models, "completeSimple").mockResolvedValue(answer(looping));
    const input = preparation();
    const snapshot = structuredClone(input);
    const result = await compact(input, models, model, undefined, undefined, undefined, undefined, undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("summarization_failed");
      expect(result.error.message).toContain("repeated itself");
    }
    expect(input).toEqual(snapshot);
  });
  it.each([0, 1])("rejects repetition in split-turn summary part %i", async (loopingPart) => {
    const models = createModels();
    const response = vi.spyOn(models, "completeSimple");
    for (let part = 0; part < 2; part += 1) {
      response.mockResolvedValueOnce(answer(part === loopingPart ? looping : "The investigation identified a port collision."));
    }
    const input = preparation();
    input.isSplitTurn = true;
    input.turnPrefixMessages = [user("Check the current turn as well.")];
    const snapshot = structuredClone(input);
    const result = await compact(input, models, model, undefined, undefined, undefined, undefined, undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("summarization_failed");
    expect(input).toEqual(snapshot);
  });

  it("retains valid summary text, file operations, usage and the active tail", async () => {
    const models = createModels();
    vi.spyOn(models, "completeSimple").mockResolvedValue(answer("The port was held by an older process."));
    const input = preparation();
    input.fileOps.read.add("server.ts");
    const result = await compact(input, models, model, undefined, undefined, undefined, undefined, undefined);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.summary).toContain("The port was held by an older process.");
      expect(result.value.summary).toContain("server.ts");
      expect(result.value.usage).toEqual(usage);
      expect(result.value.retainedTail).toBe(input.retainedTail);
    }
  });

  it("also refuses a looping standalone summary", async () => {
    const models = createModels();
    vi.spyOn(models, "completeSimple").mockResolvedValue(answer(looping));
    const result = await generateSummaryWithUsage([user("Summarize.")], models, model, 2048,
      undefined, undefined, undefined, undefined, undefined, undefined);
    expect(result.ok).toBe(false);
  });

  it.each(["aborted", "error"] as const)("preserves the provider's %s outcome", async (stopReason) => {
    const models = createModels();
    vi.spyOn(models, "completeSimple").mockResolvedValue({ ...answer(""), stopReason, errorMessage: "fixture failure" });
    const result = await compact(preparation(), models, model, undefined, undefined, undefined, undefined, undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(stopReason === "aborted" ? "aborted" : "summarization_failed");
  });

  it("preserves a thrown provider error without modifying history or file sets", async () => {
    const models = createModels();
    vi.spyOn(models, "completeSimple").mockRejectedValue(new Error("fixture transport failed"));
    const input = preparation();
    const snapshot = structuredClone(input);
    const result = await compact(input, models, model, undefined, undefined, undefined, undefined, undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("summarization_failed");
      expect(result.error.message).toContain("fixture transport failed");
    }
    expect(input).toEqual(snapshot);
  });

  it("preserves cancellation through the actual AbortSignal passed to the provider", async () => {
    const models = createModels();
    const controller = new AbortController();
    vi.spyOn(models, "completeSimple").mockImplementation(async (_model, _context, options) => {
      expect(options?.signal).toBe(controller.signal);
      return new Promise<AssistantMessage>((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(new Error("fixture aborted")), { once: true });
        controller.abort();
      });
    });
    const input = preparation();
    const snapshot = structuredClone(input);
    const result = await compact(input, models, model, undefined, undefined, undefined, undefined, controller.signal);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("aborted");
    expect(input).toEqual(snapshot);
  });

  it("joins valid split-turn summaries and adds both usage reports", async () => {
    const models = createModels();
    vi.spyOn(models, "completeSimple")
      .mockResolvedValueOnce(answer("Older investigation history."))
      .mockResolvedValueOnce(answer("The active turn checked the port owner."));
    const input = preparation();
    input.isSplitTurn = true;
    input.turnPrefixMessages = [user("Continue this active turn.")];
    const snapshot = structuredClone(input);
    const result = await compact(input, models, model, undefined, undefined, undefined, undefined, undefined);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.summary).toContain("Older investigation history.");
      expect(result.value.summary).toContain("**Turn Context (split turn):**");
      expect(result.value.summary).toContain("The active turn checked the port owner.");
      expect(result.value.usage).toMatchObject({ input: 20, output: 10, totalTokens: 30 });
      expect(result.value.retainedTail).toBe(input.retainedTail);
      expect(result.value.details).toEqual({readFiles:["read.ts"],modifiedFiles:["edit.ts","new.ts"]});
    }
    expect(input).toEqual(snapshot);
  });

});
