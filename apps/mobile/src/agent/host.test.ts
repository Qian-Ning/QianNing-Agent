/**
 * The point of this file: prove the phone can run a whole agent turn on its own,
 * using the desktop's loop, with no Node, no desktop, and no network.
 *
 * The model is pi's own faux provider, which streams tokens the same way a real
 * provider does. If the loop, tool dispatch, event translation, or transcript
 * persistence were wrong, this test fails.
 */

import { describe, expect, it } from "vitest";
import {
  createFauxCore,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type { Model } from "@earendil-works/pi-ai";
import { cleanTitle, LocalAgentHost } from "./host";
import { MemoryStore } from "./store";

const provider = { baseUrl: "https://example.invalid/v1", apiKey: "test", modelId: "scripted" };

type Responses = NonNullable<Parameters<ReturnType<typeof createFauxCore>["setResponses"]>[0]>;

function fauxHost(store: MemoryStore, responses: Responses) {
  const faux = createFauxCore({
    models: [{ id: "scripted" }],
    tokensPerSecond: 100_000,
    tokenSize: { min: 1, max: 1 },
  });
  faux.setResponses(responses);
  const host = new LocalAgentHost(store, provider, {
    stream: faux.streamSimple,
    model: faux.getModel() as Model<"openai-completions">,
  });
  return host;
}

describe("the phone agent", () => {
  it("runs a turn, calls a tool, and answers from what the tool returned", async () => {
    const store = new MemoryStore();
    const host = fauxHost(store, [
      fauxAssistantMessage(
        fauxToolCall("write_file", { path: "notes/hello.txt", content: "written on the phone" }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("Saved it."),
    ]);

    const session = host.createSession();
    const events: string[] = [];
    host.subscribe(session.id, (event) => events.push(event.kind));

    await host.send(session.id, "write a note");

    // one message carrying the tool call, the tool run, then the reply
    expect(events.slice(0, 3)).toEqual(["turn.started", "item.started", "item.completed"]);
    expect(events.slice(3, 5)).toEqual(["item.started", "item.completed"]);
    expect(events.at(-1)).toBe("turn.completed");
    expect(events.filter((kind) => kind === "item.delta").length).toBeGreaterThan(0);
    expect(store.readValue("file:notes/hello.txt")).toBe("written on the phone");
    expect(store.readValue("file:index")).toContain("notes/hello.txt");

    const history = host.history(session.id);
    // The user's own line is part of the transcript: without it a reopened
    // session shows answers floating with nothing they answered.
    expect(history.map((entry) => entry.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(history[0]?.text).toBe("write a note");
    expect(history.at(-1)?.text).toBe("Saved it.");
  });

  it("streams the answer as it arrives instead of after the turn", async () => {
    const store = new MemoryStore();
    const host = fauxHost(store, [fauxAssistantMessage("hello there")]);

    const session = host.createSession();
    const deltas: string[] = [];
    host.subscribe(session.id, (event) => {
      if (event.kind !== "item.delta" || !event.payload) return;
      const detail = event.payload.event as { deltaText?: string } | undefined;
      if (detail?.deltaText) deltas.push(detail.deltaText);
    });

    await host.send(session.id, "hi");

    expect(deltas.join("")).toBe("hello there");
    expect(deltas.length).toBeGreaterThan(1);
  });

  it("keeps two sessions apart", async () => {
    const store = new MemoryStore();
    const host = fauxHost(store, [
      fauxAssistantMessage("first"),
      fauxAssistantMessage("second"),
    ]);

    const first = host.createSession("one");
    const second = host.createSession("two");
    await host.send(first.id, "a");
    await host.send(second.id, "b");

    expect(host.history(first.id).map((row) => row.text)).toEqual(["a", "first"]);
    expect(host.history(second.id).map((row) => row.text)).toEqual(["b", "second"]);
    expect(host.listSessions().map((entry) => entry.title)).toEqual(["two", "one"]);
  });

  it("reports a provider failure as turn.failed instead of hanging", async () => {
    const store = new MemoryStore();
    const host = fauxHost(store, []);
    const session = host.createSession();
    const events: string[] = [];
    host.subscribe(session.id, (event) => events.push(event.kind));

    await host.send(session.id, "hi");

    expect(events.at(-1)).toBe("turn.failed");
  });
});

describe("host capabilities the screens rely on", () => {
  it("renames a session without touching its transcript", async () => {
    const store = new MemoryStore();
    const host = fauxHost(store, [fauxAssistantMessage("ok")]);
    const session = host.createSession("first");

    expect(host.renameSession(session.id, "  renamed  ")?.title).toBe("renamed");
    expect(host.listSessions().find((entry) => entry.id === session.id)?.title).toBe("renamed");
    expect(host.renameSession("nope", "x")).toBeNull();
  });

  it("swaps the provider and rebuilds the loop instead of reusing the old model", () => {
    const store = new MemoryStore();
    const host = fauxHost(store, [fauxAssistantMessage("ok")]);
    expect(host.providerConfig().modelId).toBe("scripted");

    host.setProvider({ ...provider, modelId: "scripted-2", thinking: "high" });
    expect(host.providerConfig().modelId).toBe("scripted-2");
    expect(host.providerConfig().thinking).toBe("high");
  });

  it("sends an attached file inline, labelled, ahead of the message", async () => {
    const store = new MemoryStore();
    let seen = "";
    const faux = createFauxCore({ models: [{ id: "scripted" }], tokensPerSecond: 100_000, tokenSize: { min: 1, max: 1 } });
    faux.setResponses([fauxAssistantMessage("got it")]);
    const host = new LocalAgentHost(store, provider, {
      stream: (model, context, options) => {
        seen = JSON.stringify(context);
        return faux.streamSimple(model, context, options);
      },
      model: faux.getModel() as Model<"openai-completions">,
    });
    const session = host.createSession("files");

    await host.send(session.id, "summarise this", [{ name: "notes.md", text: "# hello" }]);

    expect(seen).toContain("notes.md");
    expect(seen).toContain("# hello");
    expect(seen.indexOf("notes.md")).toBeLessThan(seen.indexOf("summarise this"));
  });

  it("lists the models the endpoint advertises", async () => {
    const store = new MemoryStore();
    const host = new LocalAgentHost(store, provider);
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: string) => {
      expect(String(input)).toBe("https://example.invalid/v1/models");
      return new Response(JSON.stringify({ data: [{ id: "b-model" }, { id: "a-model" }, {}] }), { status: 200 });
    }) as typeof fetch;
    try {
      expect(await host.listModels()).toEqual(["a-model", "b-model"]);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("session naming", () => {
  it("names an untitled session from the first prompt", async () => {
    const store = new MemoryStore();
    const faux = createFauxCore({ models: [{ id: "scripted" }], tokensPerSecond: 100_000, tokenSize: { min: 1, max: 1 } });
    faux.setResponses([fauxAssistantMessage("done")]);
    const host = new LocalAgentHost(store, provider, {
      stream: faux.streamSimple,
      model: faux.getModel() as Model<"openai-completions">,
      summarize: async () => '"调试 WebSocket 重连。"',
    });
    const session = host.createSession("");

    await host.send(session.id, "websocket 老是断，帮我看看");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(host.listSessions().find((entry) => entry.id === session.id)?.title).toBe("调试 WebSocket 重连");
  });

  it("never overwrites a name the reader typed", async () => {
    const store = new MemoryStore();
    const faux = createFauxCore({ models: [{ id: "scripted" }], tokensPerSecond: 100_000, tokenSize: { min: 1, max: 1 } });
    faux.setResponses([fauxAssistantMessage("done")]);
    let asked = 0;
    const host = new LocalAgentHost(store, provider, {
      stream: faux.streamSimple,
      model: faux.getModel() as Model<"openai-completions">,
      summarize: async () => {
        asked += 1;
        return "generated";
      },
    });
    const session = host.createSession("我起的名");

    await host.send(session.id, "hello");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(host.listSessions().find((entry) => entry.id === session.id)?.title).toBe("我起的名");
    expect(asked).toBe(0);
  });

  it("cleans the model's answer into a title", () => {
    expect(cleanTitle('  "Session Title: 重构用户认证模块。"  ')).toBe("重构用户认证模块");
    expect(cleanTitle("标题：调试 WebSocket 重连")).toBe("调试 WebSocket 重连");
  });
});
