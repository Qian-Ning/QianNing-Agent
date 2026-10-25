import { describe, expect, it } from "vitest";
import { normalizeContext, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/api/anthropic-messages";
import {
  hostedSearchReplayProjection,
  normalizeHostedSearchContent,
  type HostedSearchContent,
} from "./pi-ai-hosted-search/content.js";
import { createHostedSearchCapture, mergeCapturedContent } from "./pi-ai-hosted-search/capture.js";
import { applyHostedSearchReplay } from "./pi-ai-hosted-search/payload.js";

const model: Model<"anthropic-messages"> = {
  id: "offline-anthropic", name: "Offline", api: "anthropic-messages", provider: "anthropic",
  baseUrl: "http://127.0.0.1", reasoning: false, input: ["text"],
  contextWindow: 100_000, maxTokens: 1024, webSearch: true,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const request: HostedSearchContent = {
  type: "hostedSearch", phase: "server_tool_use", blockId: "search-1",
  name: "web_search", input: { query: "offline fixture" },
};
function message(result: HostedSearchContent): AssistantMessage {
  return {
    role: "assistant",
    // A text block keeps the turn on the wire. An assistant message made only
    // of search blocks is dropped by the adapter, and an assistant turn that
    // has no text is not a shape a provider ever produces.
    content: [{ type: "text", text: "Searching." }, request, result],
    api: model.api, provider: model.provider,
    model: model.id, timestamp: 2, stopReason: "stop",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
}
const sse = (events: readonly Record<string, unknown>[]): string =>
  events.map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join("");

// Both representations are already supported by the replay; neither result is
// an ordinary tool call and neither is allowed to acquire fake fields.
const results: Extract<HostedSearchContent, { phase: "web_search_tool_result" }>[] = [
  {
    type: "hostedSearch", phase: "web_search_tool_result", blockId: "search-1", isError: true,
    wire: { type: "web_search_tool_result_error", tool_use_id: "search-1",
      content: { type: "web_search_tool_result_error", error_code: "max_uses_exceeded" } },
  },
  {
    type: "hostedSearch", phase: "web_search_tool_result", blockId: "search-1",
    wire: { type: "web_search_tool_result", tool_use_id: "search-1",
      content: { type: "web_search_tool_result_error", error_code: "unavailable" } },
  },
];

describe("typed Anthropic search error results", () => {
  for (const result of results) {
    it(`replays ${result.wire?.type} without tool fields`, async () => {
      const before = JSON.stringify(result);
      const normalized = normalizeHostedSearchContent(result);
      expect(normalized).not.toHaveProperty("name");
      expect(normalized).not.toHaveProperty("arguments");
      const projection = hostedSearchReplayProjection(result, { api: model.api });
      expect(projection).toEqual(result.wire);

      const assistant = message(result);
      const messages = [assistant];
      const capture = createHostedSearchCapture();
      let sent: { messages?: { content?: { type?: string }[] }[] } | undefined;

      const stream = streamSimple(model, normalizeContext({ messages }), {
        apiKey: "offline", maxRetries: 0,
        onPayload: (payload) => {
          const filled = applyHostedSearchReplay(payload, messages, {
            id: model.id, api: model.api, provider: model.provider,
          });
          expect(filled.diagnostic).toBeUndefined();
          sent = filled.payload as typeof sent;
          return filled.payload;
        },
        onProviderStreamEvent: (event) => capture.observe(event, model.api),
        fetch: async () => new Response(sse([
          { type: "message_start", message: { id: "response-1", model: model.id, usage: { input_tokens: 1, output_tokens: 0 } } },
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          { type: "content_block_stop", index: 0 },
          { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
          { type: "message_stop" },
        ]), { headers: { "content-type": "text/event-stream" } }),
      });

      const output = await stream.result();
      expect(output.stopReason).toBe("stop");
      expect(output.errorDetails).toBeUndefined();

      // The replayed body carries the native blocks, and nothing from our own
      // block shape leaks onto the wire.
      expect(sent?.messages?.[0]?.content?.map((block) => block.type)).toEqual([
        "text",
        "server_tool_use",
        result.wire?.type,
      ]);
      expect(JSON.stringify(sent)).not.toMatch(/hostedSearch|blockId|isError/);
      expect(JSON.stringify(result)).toBe(before);
    });
  }
});

it("keeps only URL-bearing search citations from the raw stream", async () => {
  const valid = { type: "web_search_result_location", url: "https://example.invalid/source", title: "Source", cited_text: "result" };
  const citations = [
    { type: "char_location", document_index: 0, start_char_index: 0, end_char_index: 1 },
    { type: "web_search_result_location", title: "missing URL" },
    { type: "web_search_result_location", url: 123 },
    { type: "web_search_result_location", url: "", title: "empty URL" },
    valid,
  ];
  const capture = createHostedSearchCapture();
  const stream = streamSimple(model, normalizeContext({ messages: [{ role: "user", content: "offline citations", timestamp: 1 }] }), {
    apiKey: "offline", maxRetries: 0,
    onProviderStreamEvent: (event) => capture.observe(event, model.api),
    fetch: async () => new Response(sse([
      { type: "message_start", message: { id: "citation-response", model: model.id, usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      ...citations.map((citation) => ({ type: "content_block_delta", index: 0, delta: { type: "citations_delta", citation } })),
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ]), { headers: { "content-type": "text/event-stream" } }),
  });
  for await (const _event of stream) { /* Drain the real adapter stream. */ }
  const output = await stream.result();
  expect(output.stopReason).toBe("stop");
  expect(capture.citations).toEqual([{ url: valid.url, title: valid.title }]);

  // The merge is a no-op for a turn that carried no search blocks.
  expect(mergeCapturedContent(output.content, capture.blocks)).toEqual(output.content);
});
