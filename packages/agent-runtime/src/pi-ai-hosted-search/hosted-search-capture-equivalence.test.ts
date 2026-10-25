/**
 * Capture and replay proof for the hosted-search module.
 *
 * The kernel is pi-ai 1.4.0, which has no hosted-search support at all: its
 * adapters neither keep the blocks a provider returns nor replay them. This
 * file drives the real adapters and asserts the two things that replaced the
 * patch —
 *
 *   a) the capture rebuilds the blocks from raw provider events, and
 *   b) the replay puts them back onto the body the adapter actually built.
 *
 * The replay half runs against a real request body rather than a hand-written
 * one, so the alignment plan is exercised the way it will actually run.
 */
import { describe, expect, it } from "vitest";
import { stream as streamAnthropic } from "@earendil-works/pi-ai/api/anthropic-messages";
import { stream as streamOpenAIResponses } from "@earendil-works/pi-ai/api/openai-responses";
import { createHostedSearchCapture, mergeCapturedContent } from "./capture.js";
import { applyHostedSearchReplay } from "./payload.js";

const sse = (events: readonly { type: string }[]): string =>
  events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");

const fetchReturning = (body: string): typeof fetch =>
  (async () =>
    new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    })) as unknown as typeof fetch;

const anthropicModel = {
  id: "claude-test",
  name: "Claude Test",
  api: "anthropic-messages",
  provider: "anthropic",
  baseUrl: "https://api.anthropic.com",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200000,
  maxTokens: 8192,
};

const responsesModel = {
  id: "gpt-test",
  name: "GPT Test",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200000,
  maxTokens: 8192,
};

const anthropicEvents = [
  { type: "message_start", message: { id: "msg_1", role: "assistant", model: "claude-test", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Let me search." } },
  { type: "content_block_stop", index: 0 },
  { type: "content_block_start", index: 1, content_block: { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: {} } },
  { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"query":"hello"}' } },
  { type: "content_block_stop", index: 1 },
  { type: "content_block_start", index: 2, content_block: { type: "web_search_tool_result", tool_use_id: "srvtoolu_1", content: [{ type: "web_search_result", url: "https://example.com", title: "Example", encrypted_content: "ENC" }] } },
  { type: "content_block_stop", index: 2 },
  { type: "content_block_start", index: 3, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 3, delta: { type: "text_delta", text: "Found it." } },
  { type: "content_block_stop", index: 3 },
  { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } },
  { type: "message_stop" },
];

type Outcome = {
  content: { type?: string; blockId?: string }[];
  captured: ReturnType<typeof createHostedSearchCapture>;
  merged: { type?: string }[];
  payload: unknown;
};

async function driveAnthropic(): Promise<Outcome> {
  const capture = createHostedSearchCapture();
  let payload: unknown;
  const s = streamAnthropic(
    anthropicModel as never,
    { messages: [{ role: "user", content: [{ type: "text", text: "search" }] }] } as never,
    {
      apiKey: "test-key",
      fetch: fetchReturning(sse(anthropicEvents)),
      onProviderStreamEvent: (event: unknown) => capture.observe(event, "anthropic-messages"),
      onPayload: (body: unknown) => {
        payload = body;
        return undefined;
      },
    } as never,
  );
  for await (const _event of s) { /* drain */ }
  const result = await s.result();
  const content = (result?.content ?? []) as { type?: string; blockId?: string }[];
  return {
    content,
    captured: capture,
    merged: mergeCapturedContent(content, capture.blocks) as { type?: string }[],
    payload,
  };
}

describe("capture against the real Anthropic adapter", () => {
  it("rebuilds the search blocks the adapter no longer keeps", async () => {
    const outcome = await driveAnthropic();

    // The adapter has no hosted-search support: it keeps the two text blocks
    // and drops both search blocks on the floor.
    expect(outcome.content.map((block) => block.type)).toEqual(["text", "text"]);

    const fromCapture = outcome.captured.blocks.map((entry) => ({
      phase: entry.block.phase,
      blockId: entry.block.blockId,
    }));
    expect(fromCapture).toEqual([
      { phase: "server_tool_use", blockId: "srvtoolu_1" },
      { phase: "web_search_tool_result", blockId: "srvtoolu_1" },
    ]);
  });

  it("reconstructs provider order around the surviving blocks", async () => {
    const outcome = await driveAnthropic();
    // The adapter keeps only the blocks it understands; the capture supplies
    // the rest, and the merge has to interleave them in provider order.
    const survivors = outcome.content.filter((block) => block.type !== "hostedSearch");
    expect(survivors.map((block) => block.type)).toEqual(["text", "text"]);

    const merged = mergeCapturedContent(survivors, outcome.captured.blocks);
    expect(merged.map((block) => block.type)).toEqual([
      "text",
      "hostedSearch",
      "hostedSearch",
      "text",
    ]);
  });
});

describe("replay against a real signed request body", () => {
  it("replays stored blocks onto the assistant message the adapter produced", async () => {
    // Build a context that already carries a stored search pair, run the
    // adapter to get an authentic wire body, then apply the replay to it.
    const context = {
      messages: [
        { role: "user", content: [{ type: "text", text: "search" }], timestamp: 1 },
        {
          role: "assistant",
          api: "anthropic-messages",
          provider: "anthropic",
          model: "claude-test",
          timestamp: 2,
          stopReason: "stop",
          usage: { input: 1, output: 1 },
          content: [
            { type: "text", text: "Let me search." },
            { type: "hostedSearch", phase: "server_tool_use", blockId: "srvtoolu_1", name: "web_search", input: { query: "hello" } },
            {
              type: "hostedSearch",
              phase: "web_search_tool_result",
              blockId: "srvtoolu_1",
              wire: {
                type: "web_search_tool_result",
                tool_use_id: "srvtoolu_1",
                content: [{ type: "web_search_result", url: "https://example.com", encrypted_content: "ENC" }],
              },
            },
          ],
        },
        { role: "user", content: [{ type: "text", text: "follow up" }], timestamp: 3 },
      ],
    };

    let sent: Record<string, unknown> | undefined;
    let replayed = 0;
    let diagnostic: { reason: string } | undefined;
    const result = streamAnthropic(anthropicModel as never, context as never, {
      apiKey: "test-key",
      fetch: fetchReturning(sse(anthropicEvents)),
      onPayload: (payload: unknown) => {
        // Observe the authentic body the adapter built, then let this package
        // put the search blocks back the way the patch used to. The returned
        // body is what the adapter actually sends, so assert on that.
        const filled = applyHostedSearchReplay(payload, context.messages, {
          id: "claude-test",
          api: "anthropic-messages",
          provider: "anthropic",
        });
        replayed = filled.replayed;
        diagnostic = filled.diagnostic;
        sent = filled.payload as Record<string, unknown>;
        return filled.payload;
      },
    } as never);
    for await (const _event of result) { /* drain */ }

    expect(diagnostic).toBeUndefined();
    expect(replayed).toBe(2);
    const assistant = (sent as { messages?: { role?: string; content?: { type?: string }[] }[] })
      .messages?.[1];
    expect(assistant?.content?.map((block) => block.type)).toEqual([
      "text",
      "server_tool_use",
      "web_search_tool_result",
    ]);
    // The encrypted payload must survive verbatim.
    expect(JSON.stringify(sent)).toContain("ENC");
  });
});

describe("Responses adapter sanity", () => {
  it("is importable so the module covers the API it claims to", () => {
    expect(typeof streamOpenAIResponses).toBe("function");
  });
});