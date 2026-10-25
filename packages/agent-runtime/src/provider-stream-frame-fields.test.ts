import { describe, expect, it } from "vitest";
import type { AssistantMessageEventStream, Model } from "@earendil-works/pi-ai";
import { stream as streamAnthropic } from "@earendil-works/pi-ai/api/anthropic-messages";
import { stream as streamOpenAIResponses } from "@earendil-works/pi-ai/api/openai-responses";

// A gateway that re-serializes provider events with `omitempty` (Go) or drops
// `undefined` (JS) sends a delta event whose string field is simply absent
// instead of `""`. Issue #883: reading `.length` off that missing field threw a
// bare TypeError, and the runtime reported it as a retriable provider failure
// that then reproduced on every later turn of the session.
//
// pi-ai 1.4.0 no longer ships the frame encoder where the original throw lived,
// so these tests now assert the guarantee that matters to a session: an omitted
// delta field must not fail the stream. The delta event may still be emitted,
// but the settled text must not become the literal "undefined".
//
// Adapter-level hardening for thinking and partial-json deltas lives in
// `patches/@earendil-works__pi-ai@1.4.0.patch`; this file guards the decode path
// those deltas travel through.

const context = {
  messages: [
    { role: "system", content: "", timestamp: 1 },
    { role: "user", content: "hi", timestamp: 1 },
  ],
};

const anthropicModel: Model<"anthropic-messages"> = {
  id: "claude-test",
  name: "Claude Test",
  api: "anthropic-messages",
  provider: "acme",
  baseUrl: "https://api.acme.test",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200000,
  maxTokens: 8192,
};

const responsesModel: Model<"openai-responses"> = {
  id: "responses-test",
  name: "Responses Test",
  api: "openai-responses",
  provider: "acme",
  baseUrl: "https://api.acme.test/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 4096,
};

function sse<T extends { type: string }>(events: readonly T[]): string {
  return events
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
}

function fetchReturning(body: string): typeof fetch {
  return (async () =>
    new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    })) as unknown as typeof fetch;
}

type Outcome = {
  error: Error | undefined;
  eventTypes: string[];
  settled: string;
};

/** Decode the stub body and record what the stream emitted before it settled. */
async function drive(stream: AssistantMessageEventStream): Promise<Outcome> {
  const eventTypes: string[] = [];
  try {
    for await (const event of stream) eventTypes.push(event.type);
    const message = await stream.result();
    const settled = message.content
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("");
    return { error: undefined, eventTypes, settled };
  } catch (error) {
    return { error: error as Error, eventTypes, settled: "" };
  }
}

const anthropic = <T extends { type: string }>(events: readonly T[]) =>
  drive(
    streamAnthropic(anthropicModel, context as never, {
      apiKey: "test",
      fetch: fetchReturning(sse(events)),
    }),
  );

const responses = <T extends { type: string }>(events: readonly T[]) =>
  drive(
    streamOpenAIResponses(responsesModel, context as never, {
      apiKey: "test",
      fetch: fetchReturning(sse(events)),
    }),
  );

const anthropicHead = [
  {
    type: "message_start",
    message: {
      id: "msg_1",
      role: "assistant",
      model: "claude-test",
      usage: { input_tokens: 5, output_tokens: 0 },
    },
  },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
];

const anthropicTail = [
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
  { type: "message_stop" },
];

const responsesHead = [
  { type: "response.created", sequence_number: 0, response: { id: "resp_1" } },
  {
    type: "response.output_item.added",
    sequence_number: 1,
    output_index: 0,
    item: {
      id: "item_1",
      type: "message",
      role: "assistant",
      content: [],
      status: "in_progress",
    },
  },
];

const responsesCompleted = {
  type: "response.completed",
  sequence_number: 3,
  response: {
    object: "response",
    id: "resp_1",
    created_at: 1,
    model: "responses-test",
    output: [
      {
        id: "item_1",
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "hi" }],
        status: "completed",
      },
    ],
    status: "completed",
    usage: {
      input_tokens: 5,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 2,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 7,
    },
  },
  output_index: 0,
};

describe("provider stream deltas with an omitted empty string field (issue #883)", () => {
  describe("Anthropic Messages", () => {
    it("streams a text delta whose field is present", async () => {
      const outcome = await anthropic([
        ...anthropicHead,
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
        ...anthropicTail,
      ]);

      expect(outcome.error).toBeUndefined();
      expect(outcome.settled).toBe("hi");
    });

    it("survives a text delta whose field the upstream omitted", async () => {
      const outcome = await anthropic([
        ...anthropicHead,
        { type: "content_block_delta", index: 0, delta: { type: "text_delta" } },
        ...anthropicTail,
      ]);

      // The regression was a TypeError escaping the decode loop. Whatever the
      // decoder decides to do with the empty delta, it must not fail the turn.
      expect(outcome.error).toBeUndefined();
      expect(outcome.eventTypes).toContain("text_delta");
      // The dropped field can only have been the empty string, so the settled
      // text stays empty instead of becoming the literal "undefined".
      expect(outcome.settled).toBe("");
    });

    it("survives a thinking delta whose field the upstream omitted", async () => {
      const outcome = await anthropic([
        anthropicHead[0],
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "thinking", thinking: "" },
        },
        { type: "content_block_delta", index: 0, delta: { type: "thinking_delta" } },
        ...anthropicTail,
      ]);

      expect(outcome.error).toBeUndefined();
      expect(outcome.eventTypes).toContain("thinking_delta");
    });

    it("survives an input_json delta whose field the upstream omitted", async () => {
      const outcome = await anthropic([
        anthropicHead[0],
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "tool_1", name: "read" },
        },
        { type: "content_block_delta", index: 0, delta: { type: "input_json_delta" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 1 } },
        { type: "message_stop" },
      ]);

      expect(outcome.error).toBeUndefined();
      expect(outcome.eventTypes).toContain("toolcall_delta");
    });
  });

  describe("OpenAI Responses", () => {
    it("streams a text delta whose field is present", async () => {
      const outcome = await responses([
        ...responsesHead,
        {
          type: "response.output_text.delta",
          sequence_number: 2,
          output_index: 0,
          content_index: 0,
          delta: "hi",
        },
        responsesCompleted,
      ]);

      expect(outcome.error).toBeUndefined();
      expect(outcome.settled).toBe("hi");
    });

    it("survives a text delta whose field the upstream omitted", async () => {
      const outcome = await responses([
        ...responsesHead,
        {
          type: "response.output_text.delta",
          sequence_number: 2,
          output_index: 0,
          content_index: 0,
        },
        responsesCompleted,
      ]);

      expect(outcome.error).toBeUndefined();
      expect(outcome.eventTypes).toContain("text_delta");
    });
  });
});
