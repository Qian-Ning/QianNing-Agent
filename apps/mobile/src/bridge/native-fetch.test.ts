import { describe, expect, it, vi } from "vitest";
import { completionToSse, installNativeChatFetch, primeChatTransport } from "./native-fetch";

const CHAT_URL = "https://api.example.com/v1/chat/completions";

function sseLines(text: string): Record<string, unknown>[] {
  return text
    .split("\n\n")
    .map((block) => block.trim())
    .filter((block) => block.startsWith("data: ") && block !== "data: [DONE]")
    .map((block) => JSON.parse(block.slice(6)) as Record<string, unknown>);
}

describe("completionToSse", () => {
  it("emits the assistant text as a delta, then the finish reason and [DONE]", () => {
    const sse = completionToSse({
      id: "chatcmpl-1",
      created: 1700000000,
      model: "agnes-2.5-pro-alpha",
      choices: [{ message: { role: "assistant", content: "你好" }, finish_reason: "stop" }],
    });

    const chunks = sseLines(sse);
    expect(chunks).toHaveLength(2);
    const first = chunks[0].choices as Record<string, unknown>[];
    expect((first[0].delta as Record<string, unknown>).content).toBe("你好");
    const last = chunks[1].choices as Record<string, unknown>[];
    expect(last[0].finish_reason).toBe("stop");
    expect(sse.endsWith("data: [DONE]\n\n")).toBe(true);
  });

  it("streams each tool call with its index and arguments", () => {
    const sse = completionToSse({
      id: "chatcmpl-2",
      choices: [{
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "call_a", type: "function", function: { name: "read_file", arguments: "{\"path\":\"a\"}" } },
            { id: "call_b", type: "function", function: { name: "list_dir", arguments: "{}" } },
          ],
        },
        finish_reason: "tool_calls",
      }],
    });

    const chunks = sseLines(sse);
    const deltas = chunks
      .flatMap((chunk) => chunk.choices as Record<string, unknown>[])
      .map((choice) => choice.delta as Record<string, unknown>)
      .filter((delta) => Array.isArray(delta.tool_calls))
      .map((delta) => (delta.tool_calls as Record<string, unknown>[])[0]);

    expect(deltas).toHaveLength(2);
    expect(deltas[0]).toMatchObject({ index: 0, id: "call_a" });
    expect((deltas[0].function as Record<string, unknown>).name).toBe("read_file");
    expect(deltas[1]).toMatchObject({ index: 1, id: "call_b" });
  });

  it("carries usage on its own chunk when the provider reports it", () => {
    const sse = completionToSse({
      id: "chatcmpl-3",
      choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
    });

    const chunks = sseLines(sse);
    const usageChunk = chunks.find((chunk) => chunk.usage);
    expect(usageChunk?.usage).toMatchObject({ total_tokens: 15 });
    expect((usageChunk?.choices as unknown[]).length).toBe(0);
  });
});

describe("installNativeChatFetch", () => {
  const completion = {
    id: "chatcmpl-4",
    choices: [{ message: { role: "assistant", content: "答" }, finish_reason: "stop" }],
  };

  it("streams through the WebView's own fetch once the origin allows it", async () => {
    const streamed: RequestInit[] = [];
    const calls: string[] = [];
    const fakeWindow = {
      // Capacitor keeps the pre-patch fetch here; it can read cross-origin
      // responses when the endpoint sends CORS headers, and it streams.
      CapacitorWebFetch: vi.fn(async (url: string, init?: RequestInit) => {
        calls.push(url);
        if (!init?.body) return new Response("{}", { status: 200 });
        streamed.push(init);
        return new Response('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n', {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }),
      fetch: vi.fn(async (_url: string, _init?: RequestInit) => new Response("{}", { status: 200 })),
    };

    const origin = "https://stream.example.com/v1";
    const ok = await primeChatTransport(fakeWindow as unknown as Window, `${origin}/models`, {});
    expect(ok).toBe(true);
    installNativeChatFetch(fakeWindow as unknown as Window);

    const response = await fakeWindow.fetch(`${origin}/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ model: "m", messages: [], stream: true }),
    });

    // The request goes out untouched: still streaming, no rewrite.
    expect(JSON.parse(String(streamed[0].body)).stream).toBe(true);
    expect(await response.text()).toContain("[DONE]");
    expect(fakeWindow.fetch).toBeTypeOf("function");
    expect(calls[0]).toContain("/models");
  });

  it("falls back to the buffered path when the origin cannot be read", async () => {
    const seen: RequestInit[] = [];
    const fakeWindow = {
      CapacitorWebFetch: vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
      fetch: vi.fn(async (_url: string, init: RequestInit) => {
        seen.push(init);
        return new Response(JSON.stringify(completion), { status: 200 });
      }),
    };

    const origin = "https://cors-blocked.example.com/v1";
    const ok = await primeChatTransport(fakeWindow as unknown as Window, `${origin}/models`, {});
    expect(ok).toBe(false);
    installNativeChatFetch(fakeWindow as unknown as Window);

    const response = await fakeWindow.fetch(`${origin}/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ model: "m", messages: [], stream: true }),
    });

    expect(JSON.parse(String(seen[0].body)).stream).toBe(false);
    expect(await response.text()).toContain('"content":"答"');
  });

  it("asks the native transport for a non-streamed body and answers with SSE", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fakeWindow = {
      fetch: vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
        return new Response(JSON.stringify(completion), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    };

    const restore = installNativeChatFetch(fakeWindow as unknown as Window);
    const response = await fakeWindow.fetch(CHAT_URL, {
      method: "POST",
      body: JSON.stringify({ model: "m", messages: [], stream: true, stream_options: { include_usage: true } }),
    });

    expect(calls[0].body.stream).toBe(false);
    expect("stream_options" in calls[0].body).toBe(false);
    expect(response.headers.get("Content-Type")).toBe("text/event-stream");
    const text = await response.text();
    expect(text).toContain('"content":"答"');
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
    restore();
  });

  it("leaves non-chat requests untouched", async () => {
    const seen: RequestInit[] = [];
    const fakeWindow = {
      fetch: vi.fn(async (_url: string, init: RequestInit) => {
        seen.push(init);
        return new Response("{}", { status: 200 });
      }),
    };

    installNativeChatFetch(fakeWindow as unknown as Window);
    await fakeWindow.fetch("https://api.example.com/v1/models", {
      method: "GET",
      headers: { Authorization: "Bearer x" },
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toHaveProperty("body");
  });

  it("passes an error response straight through", async () => {
    const fakeWindow = {
      fetch: vi.fn(async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify({ error: { message: "bad key" } }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        })),
    };

    installNativeChatFetch(fakeWindow as unknown as Window);
    const response = await fakeWindow.fetch(CHAT_URL, {
      method: "POST",
      body: JSON.stringify({ stream: true }),
    });

    expect(response.status).toBe(401);
    expect(await response.text()).toContain("bad key");
  });
});
