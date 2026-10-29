import { describe, expect, it } from "vitest";
import {
  COMPACTION_THRESHOLD,
  DEFAULT_CONTEXT_WINDOW,
  KEEP_RECENT_MESSAGES,
  compactableText,
  compactMessages,
  shouldCompact,
  summaryMessage,
} from "./compaction";
import { LocalAgentHost } from "./host";
import { MemoryStore } from "./store";

const provider = { baseUrl: "https://example.invalid/v1", apiKey: "test", modelId: "scripted" };

describe("when a conversation needs compacting", () => {
  it("waits until the window is nearly full", () => {
    expect(shouldCompact(0)).toBe(false);
    expect(shouldCompact(DEFAULT_CONTEXT_WINDOW * (COMPACTION_THRESHOLD - 0.05))).toBe(false);
    expect(shouldCompact(DEFAULT_CONTEXT_WINDOW * COMPACTION_THRESHOLD)).toBe(true);
    expect(shouldCompact(DEFAULT_CONTEXT_WINDOW * 0.95)).toBe(true);
  });

  it("survives a nonsense window", () => {
    expect(shouldCompact(120_000, 0)).toBe(true);
    expect(shouldCompact(120_000, Number.NaN)).toBe(true);
    expect(shouldCompact(Number.NaN)).toBe(false);
  });
});

describe("the summary input", () => {
  it("labels speakers and keeps every message that has text", () => {
    const text = compactableText([
      { role: "user", content: "把项目挪到 D 盘" },
      { role: "assistant", content: [{ type: "text", text: "已经改好了。" }] },
      { role: "tool", content: "" },
    ]);
    expect(text).toBe("USER: 把项目挪到 D 盘\n\nASSISTANT: 已经改好了。");
  });

  it("shortens a single enormous message instead of dropping it", () => {
    const long = "a".repeat(4_000);
    const text = compactableText([{ role: "user", content: long }]);
    expect(text.length).toBeLessThan(1_400);
    expect(text.endsWith("…")).toBe(true);
  });
});

describe("the compacted transcript", () => {
  it("keeps the recent tail verbatim and puts one summary in front", () => {
    const messages = Array.from({ length: 20 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `message ${index}`,
    }));
    const { messages: next, dropped } = compactMessages(messages, "原来在修手机端设置页。");
    expect(dropped).toBe(20 - KEEP_RECENT_MESSAGES);
    expect(next).toHaveLength(KEEP_RECENT_MESSAGES + 1);
    expect(next[0].role).toBe("user");
    expect(String(next[0].content)).toContain("原来在修手机端设置页。");
    expect(String(next[0].content)).toContain(`${dropped} messages compacted`);
    expect(next.at(-1)).toEqual(messages.at(-1));
  });

  it("leaves a short conversation alone", () => {
    const messages = [{ role: "user", content: "hi" }];
    expect(compactMessages(messages, "x")).toEqual({ messages, dropped: 0 });
  });

  it("marks the summary as coming from the user's side of the log", () => {
    expect(summaryMessage("  summary  ", 3)).toMatchObject({
      role: "user",
      content: "[Earlier conversation — 3 messages compacted]\nsummary",
    });
  });
});

describe("compacting through the host", () => {
  function seed(store: MemoryStore, count: number) {
    store.writeSession({
      id: "s1",
      title: "长会话",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    });
    const messages = Array.from({ length: count }, (_, index) => ({
      itemId: `m${index}`,
      role: index % 2 === 0 ? "user" : "assistant",
      text: `turn ${index}`,
      status: "complete",
      createdAt: new Date(index).toISOString(),
    }));
    store.writeMessages("s1", messages);
    store.writeValue(
      "transcript:s1",
      JSON.stringify(
        messages.map((message) => ({
          id: message.itemId,
          role: message.role,
          content: message.text,
          timestamp: Date.parse(message.createdAt),
        })),
      ),
    );
  }

  it("rewrites the model transcript and counts the pass", async () => {
    const store = new MemoryStore();
    seed(store, 14);
    const host = new LocalAgentHost(store, provider, {
      stream: (() => {
        throw new Error("no stream should be needed");
      }) as never,
      compact: async () => "用户要修手机端设置页，已经改完返回层级。",
    });

    const result = await host.compact("s1");
    expect(result.compacted).toBe(true);
    expect(result.dropped).toBeGreaterThan(0);
    expect(result.count).toBe(1);

    const transcript = JSON.parse(store.readValue("transcript:s1") ?? "[]") as Array<{
      role: string;
      content: string;
    }>;
    expect(transcript).toHaveLength(KEEP_RECENT_MESSAGES + 1);
    expect(transcript[0].content).toContain("用户要修手机端设置页");

    expect(host.compactionRecord("s1")).toMatchObject({ count: 1 });
  });

  it("does nothing to a conversation with little in it", async () => {
    const store = new MemoryStore();
    seed(store, 4);
    const host = new LocalAgentHost(store, provider, {
      stream: (() => {
        throw new Error("no stream should be needed");
      }) as never,
      compact: async () => "unused",
    });
    await expect(host.compact("s1")).resolves.toMatchObject({ compacted: false, dropped: 0, count: 0 });
  });

  it("keeps the transcript intact when the summary call fails", async () => {
    const store = new MemoryStore();
    seed(store, 14);
    const before = store.readValue("transcript:s1");
    const host = new LocalAgentHost(store, provider, {
      stream: (() => {
        throw new Error("no stream should be needed");
      }) as never,
      compact: async () => {
        throw new Error("provider down");
      },
    });
    await expect(host.compact("s1")).rejects.toThrow("provider down");
    expect(store.readValue("transcript:s1")).toBe(before);
    expect(host.compactionRecord("s1").count).toBe(0);
  });
});
