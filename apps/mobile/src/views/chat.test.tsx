// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { ChatView } from "./chat";
import { RacpClient } from "../lib/racp";
import { createTranslator } from "../lib/i18n";

const t = createTranslator("en");

function sse(frames: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const frame of frames) controller.enqueue(encoder.encode("data: " + frame + "\n\n"));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function envelope(kind: string, payload: unknown, turnId = "turn-1"): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    method: "session/event",
    params: { sessionId: "s1", turnId, kind, payload, revision: 4 },
  });
}

/**
 * The client must paint a turn while it is being written, not after. This is the
 * behaviour the old page lacked: it re-fetched history instead of applying
 * `item.delta`, so text appeared all at once at the end.
 */
describe("chat streaming", () => {
  it("appends deltas into one growing bubble", async () => {
    const history = { items: [] };
    const frames = [
      JSON.stringify({ subscriptionId: "sub_1" }),
      envelope("item.started", {
        itemType: "message",
        itemId: "a1",
        event: { type: "message_start", message: { role: "assistant", content: "", status: "streaming" } },
      }),
      envelope("item.delta", {
        itemType: "message",
        itemId: "a1",
        event: { type: "message_update", stream: "delta", deltaText: "收" },
      }),
      envelope("item.delta", {
        itemType: "message",
        itemId: "a1",
        event: { type: "message_update", stream: "delta", deltaText: "到" },
      }),
      envelope("item.completed", {
        itemType: "message",
        itemId: "a1",
        event: { type: "message_end", message: { role: "assistant", content: "收到", status: "complete" } },
      }),
      envelope("turn.completed", {}, "turn-1"),
    ];

    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(url + " " + (init?.method ?? "GET"));
      if (url.includes("/history")) {
        return new Response(JSON.stringify({ result: history }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/events")) return sse(frames);
      return new Response(JSON.stringify({ result: {} }), { status: 200 });
    }) as typeof fetch;

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const client = new RacpClient({ base: "https://host", token: "tok" });

    await act(async () => {
      root.render(<ChatView client={client} sessionId="s1" title="T" t={t} configured canDiff modelLabel="agnes-3.0-flash" onRequestSetup={() => {}} onOpenDrawer={() => {}} />);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });

    expect(container.textContent).toContain("收到");
    // One history read for the initial paint; deltas must not trigger refetches.
    expect(calls.filter((call) => call.includes("/history")).length).toBe(1);

    root.unmount();
  });

  it("shows a tool call as its own row", async () => {
    const frames = [
      envelope("item.started", {
        itemType: "tool",
        itemId: "t1",
        tool: { name: "read_file", input: { path: "a.ts" } },
      }),
    ];

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/history")) {
        return new Response(JSON.stringify({ result: { items: [] } }), { status: 200 });
      }
      return sse(frames);
    }) as typeof fetch;

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const client = new RacpClient({ base: "https://host", token: "tok" });

    await act(async () => {
      root.render(<ChatView client={client} sessionId="s1" title="T" t={t} configured canDiff modelLabel="agnes-3.0-flash" onRequestSetup={() => {}} onOpenDrawer={() => {}} />);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });

    expect(container.textContent).toContain("read_file");
    root.unmount();
  });
});
