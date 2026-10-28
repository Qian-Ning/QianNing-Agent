import { describe, expect, it } from "vitest";
import { createFauxCore, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import type { Model } from "@earendil-works/pi-ai";
import { HeadlessRunner, parseJob } from "./headless";
import { MemoryStore } from "./store";
import type { ProviderConfig } from "./host";

const provider: ProviderConfig = { baseUrl: "https://example.invalid/v1", apiKey: "test", modelId: "scripted" };

function fauxRunner(store: MemoryStore, answers: string[]) {
  const faux = createFauxCore({
    models: [{ id: "scripted" }],
    tokensPerSecond: 100_000,
    tokenSize: { min: 1, max: 1 },
  });
  faux.setResponses(answers.map((text) => fauxAssistantMessage(text)));
  return new HeadlessRunner(store, provider, {
    stream: faux.streamSimple,
    model: faux.getModel() as Model<"openai-completions">,
  });
}

describe("parseJob", () => {
  it("accepts a complete job", () => {
    const job = parseJob(JSON.stringify({ provider, prompt: "跑一下" }));
    expect(job.prompt).toBe("跑一下");
    expect(job.provider.modelId).toBe("scripted");
  });

  it("refuses what a Service must never send", () => {
    expect(() => parseJob("not json")).toThrow("not valid JSON");
    expect(() => parseJob(JSON.stringify({ provider }))).toThrow("prompt is required");
    expect(() => parseJob(JSON.stringify({ prompt: "x" }))).toThrow("baseUrl");
    expect(() => parseJob(JSON.stringify({ provider: { baseUrl: "u", apiKey: "k" }, prompt: "x" }))).toThrow("modelId");
  });
});

describe("HeadlessRunner", () => {
  it("runs a turn with no window and reports completion", async () => {
    const store = new MemoryStore();
    const runner = fauxRunner(store, ["好的，记下了。"]);
    const emitted: string[] = [];

    const result = await runner.run({ provider, prompt: "继续", title: "夜间任务" }, (event) => emitted.push(event.kind));

    expect(result.ok).toBe(true);
    expect(emitted[0]).toBe("session");
    expect(emitted.at(-1)).toBe("done");
    // The transcript lands in the same store the WebView reads on next launch.
    expect(store.listSessions().some((s) => s.id === result.sessionId)).toBe(true);
    expect(store.readMessages(result.sessionId).length).toBeGreaterThan(0);
  });

  it("continues the session the Service hands it", async () => {
    const store = new MemoryStore();
    const runner = fauxRunner(store, ["第一轮回答", "第二轮回答"]);
    const first = await runner.run({ provider, prompt: "第一轮" });
    const second = await runner.run({ provider, prompt: "第二轮", sessionId: first.sessionId });

    expect(first.ok && second.ok).toBe(true);
    expect(second.sessionId).toBe(first.sessionId);
    expect(store.listSessions()).toHaveLength(1);
  });
});
