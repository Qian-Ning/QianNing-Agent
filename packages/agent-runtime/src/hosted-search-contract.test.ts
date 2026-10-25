import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";

import { createHostedSearchCapture } from "./pi-ai-hosted-search/capture.js";
import { applyHostedSearchReplay } from "./pi-ai-hosted-search/payload.js";

/**
 * Contract tests for the hosted web search module.
 *
 * pi-ai 1.4.0 has no hosted-search support: its adapters neither attach the
 * provider's server tool, keep the blocks a response carries, nor replay them
 * on a later turn. `pi-ai-hosted-search` does all three through the public
 * hooks, and these tests pin that contract — capture from raw provider events,
 * replay onto the request body, and the request parameters that make a provider
 * actually run a search — without hitting a real provider.
 */

type AnyRecord = Record<string, unknown>;

describe("hosted search: responses stream capture", () => {
  it("captures a web_search_call as a hostedSearch content block", () => {
    const capture = createHostedSearchCapture();
    capture.observe(
      { type: "response.output_item.added", output_index: 1, item: { type: "web_search_call", id: "ws_1", status: "in_progress", action: { type: "search", query: "pi-desktop release notes" } } },
      "openai-responses",
    );
    capture.observe(
      { type: "response.web_search_call.completed", output_index: 1, item: { type: "web_search_call", id: "ws_1", status: "completed", action: { type: "search", query: "pi-desktop release notes" } } },
      "openai-responses",
    );
    capture.observe(
      { type: "response.output_item.done", output_index: 1, item: { type: "web_search_call", id: "ws_1", status: "completed", action: { type: "search", query: "pi-desktop release notes" } } },
      "openai-responses",
    );

    expect(capture.blocks).toHaveLength(1);
    const entry = capture.blocks[0]!;
    expect(entry.index).toBe(1);
    expect(entry.block).toMatchObject({
      type: "hostedSearch",
      phase: "web_search_call",
      blockId: "ws_1",
      status: "completed",
    });
    expect((entry.block as { wire?: AnyRecord }).wire?.action).toEqual({
      type: "search",
      query: "pi-desktop release notes",
    });
  });

  it("ignores malformed annotations and unknown web_search_call shapes", () => {
    const capture = createHostedSearchCapture();
    for (const event of [
      // Missing url: dropped rather than crashing the turn.
      { type: "response.output_text.annotation.added", output_index: 0, annotation: { type: "url_citation", title: "no url" } },
      { type: "response.output_text.annotation.added", output_index: 0, annotation: { type: "something_else", url: "https://example.com" } },
      // No item payload: nothing to slot, and no error.
      { type: "response.web_search_call.completed", output_index: 3 },
      // A call without an id cannot round-trip, so it is not captured.
      { type: "response.output_item.added", output_index: 4, item: { type: "web_search_call", status: "in_progress" } },
      // Not a search item at all.
      { type: "response.output_item.done", output_index: 5, item: { type: "message", id: "msg_1" } },
      // A valid citation survives.
      { type: "response.output_text.annotation.added", output_index: 0, annotation: { type: "url_citation", url: "https://example.com/doc", title: "Doc" } },
    ]) {
      capture.observe(event, "openai-responses");
    }

    expect(capture.blocks).toHaveLength(0);
    expect(capture.citations).toEqual([{ url: "https://example.com/doc", title: "Doc" }]);
  });
});

describe("hosted search: responses replay", () => {
  it("replays a hostedSearch block as a web_search_call output item", async () => {
    const { streamSimple } = await import("@earendil-works/pi-ai/api/openai-responses");
    const model = {
      id: "gpt-test", api: "openai-responses", provider: "openai",
      reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000, maxTokens: 8_192, baseUrl: "http://localhost/v1",
    };
    const messages = [
      { role: "user" as const, content: "search for the release notes", timestamp: 1 },
      {
        role: "assistant" as const,
        content: [
          { type: "text", text: "Found it." },
          {
            type: "hostedSearch" as const,
            phase: "web_search_call" as const,
            blockId: "ws_1",
            status: "completed",
            wire: {
              type: "web_search_call",
              id: "ws_1",
              status: "completed",
              action: { type: "search", query: "pi-desktop release notes" },
            },
          },
        ],
        api: "openai-responses", provider: "openai", model: "gpt-test",
        timestamp: 2, stopReason: "stop" as const,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      },
    ];

    let sent: AnyRecord | undefined;
    const sse =
      "event: response.completed\n" +
      'data: {"type":"response.completed","response":{"id":"r1","status":"completed","output":[],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n\n';
    const stream = streamSimple(model as never, { messages } as never, {
      apiKey: "offline",
      onPayload: (payload: unknown) => {
        const filled = applyHostedSearchReplay(payload, messages as never, {
          id: "gpt-test", api: "openai-responses", provider: "openai",
        });
        expect(filled.diagnostic).toBeUndefined();
        sent = filled.payload as AnyRecord;
        return filled.payload;
      },
      fetch: (async () =>
        new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })) as never,
    } as never);

    expect((await stream.result()).stopReason).toBe("stop");

    const items = (sent?.input ?? []) as AnyRecord[];
    const searchItem = items.find((item) => item.type === "web_search_call");
    expect(searchItem).toBeDefined();
    expect(searchItem?.id).toBe("ws_1");
    expect(searchItem?.status).toBe("completed");
    expect((searchItem?.action as AnyRecord)?.query).toBe("pi-desktop release notes");
  });
});

describe("hosted search: request params", () => {
  async function captureParams(model: AnyRecord, options: AnyRecord = {}): Promise<AnyRecord> {
    const { streamSimple } = await import("@earendil-works/pi-ai/api/openai-responses");
    const resolved = {
      id: "kimi-k2.8",
      api: "openai-responses",
      provider: "self",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 8_192,
      baseUrl: "http://localhost/v1",
      ...model,
    };
    let payload: AnyRecord | undefined;
    const sse =
      "event: response.completed\n" +
      'data: {"type":"response.completed","response":{"id":"r1","status":"completed","output":[],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n\n';
    const stream = streamSimple(resolved as never, { messages: [] } as never, {
      apiKey: "offline",
      onPayload: (params: unknown) => {
        const filled = applyHostedSearchReplay(params, [], {
          id: resolved.id, api: resolved.api, provider: resolved.provider,
          ...((resolved as { webSearch?: boolean }).webSearch === true ? { webSearch: true } : {}),
        });
        payload = filled.payload as AnyRecord;
        return filled.payload;
      },
      fetch: (async () =>
        new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })) as never,
      ...options,
    } as never);
    const result = await stream.result();
    expect(result.stopReason).toBe("stop");
    expect(payload).toBeDefined();
    return payload!;
  }

  it("attaches the search tool and asks for action sources", async () => {
    const params = await captureParams({ webSearch: true });
    expect(params.tools).toEqual([{ type: "web_search" }]);
    expect(params.include).toEqual(["web_search_call.action.sources"]);
  });

  it("merges the sources include with the reasoning include", async () => {
    // Any explicit effort arms the reasoning branch, which assigns
    // `params.include` outright — the merge must survive that.
    const params = await captureParams(
      { webSearch: true, thinkingLevelMap: { high: "high" } },
      { reasoning: "high" },
    );
    expect(params.include).toEqual(
      expect.arrayContaining([
        "reasoning.encrypted_content",
        "web_search_call.action.sources",
      ]),
    );
    expect((params.reasoning as AnyRecord)?.effort).toBe("high");
  });

  it("leaves the request untouched when the model does not opt in", async () => {
    const params = await captureParams({ webSearch: false }, { reasoning: "high" });
    expect(params.tools).toBeUndefined();
    expect(params.include).toEqual(["reasoning.encrypted_content"]);
  });
});

describe("hosted search: Codex request params", () => {
  async function captureCodexParams(webSearch: boolean): Promise<AnyRecord> {
    const { stream: streamCodex } = await import("@earendil-works/pi-ai/api/openai-codex-responses");
    const resolved = {
      id: "gpt-codex-test",
      api: "openai-codex-responses",
      provider: "openai-codex",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 8_192,
      baseUrl: "http://127.0.0.1:43123",
      webSearch,
    };
    const authPayload = Buffer.from(JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_account_id: "offline-test-account" },
    })).toString("base64");
    let payload: AnyRecord | undefined;
    let fetches = 0;
    const stream = streamCodex(resolved as never, { messages: [] } as never, {
      apiKey: `e30.${authPayload}.offline-signature`,
      transport: "sse",
      onPayload: (body: unknown) => {
        const filled = applyHostedSearchReplay(body, [], {
          id: resolved.id, api: resolved.api, provider: resolved.provider,
          ...(webSearch ? { webSearch: true } : {}),
        });
        payload = filled.payload as AnyRecord;
        throw new Error("stop after offline payload capture");
      },
      fetch: async () => {
        fetches += 1;
        throw new Error("the payload test must not make a request");
      },
    } as never);
    expect((await stream.result()).stopReason).toBe("error");
    expect(fetches).toBe(0);
    expect(payload).toBeDefined();
    return payload!;
  }

  it("attaches hosted search to Codex Responses only when enabled", async () => {
    const enabled = await captureCodexParams(true);
    expect(enabled.tools).toEqual([{ type: "web_search" }]);
    expect(enabled.include).toEqual([
      "reasoning.encrypted_content",
      "web_search_call.action.sources",
    ]);
    expect(enabled.tool_choice).toBe("auto");

    const disabled = await captureCodexParams(false);
    expect(disabled.tools).toBeUndefined();
    expect(disabled.include).toEqual(["reasoning.encrypted_content"]);
  });
});
