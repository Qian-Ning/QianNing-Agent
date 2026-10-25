import { describe, expect, it } from "vitest";
import {
  LocalRequestError,
  hostedSearchReplayProjection,
  localRequestErrorDetails,
  normalizeHostedSearchContent,
  prepareLocalRequest,
  validateHostedSearchMessages,
} from "./content.js";
import { createHostedSearchCapture, mergeCapturedContent } from "./capture.js";
import { applyHostedSearchReplay } from "./payload.js";

const anthropicModel = {
  id: "claude-test",
  api: "anthropic-messages",
  provider: "anthropic",
};

const responsesModel = {
  id: "gpt-test",
  api: "openai-responses",
  provider: "openai",
};

describe("hosted search content normalization", () => {
  it("keeps a server_tool_use block and defaults its input", () => {
    const block = normalizeHostedSearchContent({
      type: "hostedSearch",
      phase: "server_tool_use",
      blockId: "srvtoolu_1",
      name: "web_search",
    });
    expect(block).toMatchObject({
      blockId: "srvtoolu_1",
      phase: "server_tool_use",
      input: {},
    });
  });

  it("recovers an id the gateway stripped, from the wire payload", () => {
    const block = normalizeHostedSearchContent({
      type: "hostedSearch",
      phase: "web_search_tool_result",
      wire: {
        type: "web_search_tool_result",
        tool_use_id: "srvtoolu_9",
        content: [],
      },
    });
    expect(block).toMatchObject({
      blockId: "srvtoolu_9",
      phase: "web_search_tool_result",
      isError: false,
    });
  });

  it("derives isError from the wire type rather than trusting the field", () => {
    const block = normalizeHostedSearchContent({
      type: "hostedSearch",
      phase: "web_search_tool_result",
      blockId: "srvtoolu_1",
      wire: { type: "web_search_tool_result_error", content: [] },
    });
    expect(block).toMatchObject({ phase: "web_search_tool_result", isError: true });
  });

  it("refuses a block with no usable id, naming only a fixed phase", () => {
    const attempt = () =>
      normalizeHostedSearchContent({ type: "hostedSearch", phase: "server_tool_use", name: "web_search" });
    expect(attempt).toThrow(LocalRequestError);
    const details = localRequestErrorDetails(
      prepareLocalRequestCatching(attempt),
    );
    expect(details?.phase).toBe("context-validation");
    // The message never echoes the offending value.
    expect(details?.message).not.toContain("web_search");
  });

  it("refuses non-finite numbers and unknown phases", () => {
    expect(() =>
      normalizeHostedSearchContent({
        type: "hostedSearch",
        phase: "server_tool_use",
        blockId: "x",
        name: "web_search",
        input: { depth: Number.POSITIVE_INFINITY },
      }),
    ).toThrow(LocalRequestError);
    expect(() =>
      normalizeHostedSearchContent({ type: "hostedSearch", phase: "nope", blockId: "x" }),
    ).toThrow(LocalRequestError);
  });
});

function prepareLocalRequestCatching(fn: () => unknown): unknown {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error;
  }
}

describe("hosted search replay projection", () => {
  it("projects both halves of an Anthropic pair back to provider shape", () => {
    expect(
      hostedSearchReplayProjection(
        {
          type: "hostedSearch",
          phase: "server_tool_use",
          blockId: "srvtoolu_1",
          name: "web_search",
          input: { query: "hello" },
        },
        { api: "anthropic-messages" },
      ),
    ).toEqual({
      type: "server_tool_use",
      id: "srvtoolu_1",
      name: "web_search",
      input: { query: "hello" },
    });

    expect(
      hostedSearchReplayProjection(
        {
          type: "hostedSearch",
          phase: "web_search_tool_result",
          blockId: "srvtoolu_1",
          wire: {
            type: "web_search_tool_result",
            tool_use_id: "srvtoolu_1",
            content: [{ type: "web_search_result", url: "https://example.com" }],
          },
        },
        { api: "anthropic-messages" },
      ),
    ).toEqual({
      type: "web_search_tool_result",
      tool_use_id: "srvtoolu_1",
      content: [{ type: "web_search_result", url: "https://example.com" }],
    });
  });

  it("never replays an Anthropic block onto a Responses endpoint, or the reverse", () => {
    const anthropicBlock = {
      type: "hostedSearch",
      phase: "server_tool_use",
      blockId: "srvtoolu_1",
      name: "web_search",
      input: {},
    };
    expect(hostedSearchReplayProjection(anthropicBlock, { api: "openai-responses" })).toBeUndefined();

    const responsesBlock = {
      type: "hostedSearch",
      phase: "web_search_call",
      blockId: "ws_1",
      wire: { type: "web_search_call", id: "ws_1", status: "completed" },
    };
    expect(
      hostedSearchReplayProjection(responsesBlock, { api: "anthropic-messages" }),
    ).toBeUndefined();
  });

  it("withholds a Responses search call when the model changed", () => {
    const block = {
      type: "hostedSearch",
      phase: "web_search_call",
      blockId: "ws_1",
      wire: { type: "web_search_call", id: "ws_1", status: "completed" },
    };
    expect(
      hostedSearchReplayProjection(block, { api: "openai-responses", isSameModel: false }),
    ).toBeUndefined();
    expect(
      hostedSearchReplayProjection(block, { api: "openai-responses", isSameModel: true }),
    ).toBeDefined();
  });
});

describe("context validation", () => {
  it("accepts the block types this package owns", () => {
    expect(() =>
      validateHostedSearchMessages([
        {
          role: "assistant",
          content: [
            { type: "text", text: "hi" },
            { type: "thinking", thinking: "hmm" },
            { type: "toolCall", id: "t1", name: "read", arguments: {} },
            { type: "hostedSearch", phase: "server_tool_use", blockId: "b1", name: "web_search", input: {} },
          ],
        },
      ]),
    ).not.toThrow();
  });

  it("rejects a block type it does not own instead of passing it through", () => {
    expect(() =>
      validateHostedSearchMessages([{ role: "assistant", content: [{ type: "mystery" }] }]),
    ).toThrow(LocalRequestError);
  });

  it("ignores non-assistant messages", () => {
    expect(() =>
      validateHostedSearchMessages([{ role: "user", content: [{ type: "mystery" }] }]),
    ).not.toThrow();
  });
});

describe("provider stream capture", () => {
  it("captures an Anthropic pair and accumulates the streamed query", () => {
    const capture = createHostedSearchCapture();
    const api = "anthropic-messages";
    capture.observe({ type: "message_start", message: { id: "m1" } }, api);
    capture.observe(
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: {} },
      },
      api,
    );
    capture.observe(
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"query"' } },
      api,
    );
    capture.observe(
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: ': "hello connections"}' } },
      api,
    );
    capture.observe({ type: "content_block_stop", index: 0 }, api);
    capture.observe(
      {
        type: "content_block_start",
        index: 1,
        content_block: {
          type: "web_search_tool_result",
          tool_use_id: "srvtoolu_1",
          content: [{ type: "web_search_result", url: "https://example.com", encrypted_content: "abc" }],
        },
      },
      api,
    );
    capture.observe({ type: "content_block_stop", index: 1 }, api);

    expect(capture.sawSearch).toBe(true);
    expect(capture.blocks.map((entry) => entry.index)).toEqual([0, 1]);
    const [use, result] = capture.blocks;
    expect(use?.block).toMatchObject({
      phase: "server_tool_use",
      input: { query: "hello connections" },
    });
    // Streaming scratch is deleted once the block closes, not merely blanked.
    expect(use?.block).not.toHaveProperty("inputJson");
    expect(use?.block).not.toHaveProperty("index");
    expect(result?.block).toMatchObject({
      phase: "web_search_tool_result",
      isError: false,
    });
  });

  it("captures a Responses search call and its status transitions", () => {
    const capture = createHostedSearchCapture();
    const api = "openai-responses";
    capture.observe(
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "web_search_call", id: "ws_1", status: "in_progress" },
      },
      api,
    );
    capture.observe(
      { type: "response.web_search_call.completed", output_index: 0, item: { type: "web_search_call", id: "ws_1", status: "completed" } },
      api,
    );

    expect(capture.blocks).toHaveLength(1);
    expect(capture.blocks[0]?.block).toMatchObject({ phase: "web_search_call", status: "completed", blockId: "ws_1" });
  });

  it("collects URL citations but not document citations", () => {
    const capture = createHostedSearchCapture();
    const api = "anthropic-messages";
    capture.observe(
      { type: "content_block_delta", index: 2, delta: { type: "citations_delta", citation: { type: "web_search_result_location", url: "https://a.example", title: "A" } } },
      api,
    );
    capture.observe(
      { type: "content_block_delta", index: 2, delta: { type: "citations_delta", citation: { type: "page_location" } } },
      api,
    );
    expect(capture.citations).toEqual([{ url: "https://a.example", title: "A" }]);
  });
});

describe("merging captured blocks back into adapter output", () => {
  it("returns the adapter output untouched when nothing was captured", () => {
    const surviving = [{ type: "text", text: "hi" }];
    expect(mergeCapturedContent(surviving, [])).toBe(surviving);
  });

  it("restores a block between two text blocks, in provider order", () => {
    const capture = createHostedSearchCapture();
    const api = "anthropic-messages";
    capture.observe({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, api);
    capture.observe(
      { type: "content_block_start", index: 1, content_block: { type: "server_tool_use", id: "b1", name: "web_search", input: {} } },
      api,
    );
    capture.observe({ type: "content_block_stop", index: 1 }, api);
    capture.observe({ type: "content_block_start", index: 2, content_block: { type: "text", text: "" } }, api);

    // The adapter kept only the two text blocks.
    const surviving = [
      { type: "text", text: "before" },
      { type: "text", text: "after" },
    ];
    const merged = mergeCapturedContent(surviving, capture.blocks);
    expect(merged.map((block) => block.type)).toEqual(["text", "hostedSearch", "text"]);
    expect((merged[1] as { blockId?: string }).blockId).toBe("b1");
  });

  it("keeps a trailing survivor that sits past the last captured slot", () => {
    const capture = createHostedSearchCapture();
    capture.observe(
      { type: "content_block_start", index: 0, content_block: { type: "server_tool_use", id: "b1", name: "web_search", input: {} } },
      "anthropic-messages",
    );
    capture.observe({ type: "content_block_stop", index: 0 }, "anthropic-messages");
    const merged = mergeCapturedContent(
      [{ type: "text", text: "answer" }],
      capture.blocks,
    );
    expect(merged.map((block) => block.type)).toEqual(["hostedSearch", "text"]);
  });
});

describe("replay payload", () => {
  const storedAssistant = (blocks: unknown[], extra: unknown[] = []) => ({
    role: "assistant",
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-test",
    content: [...extra, ...blocks],
  });

  it("attaches the Anthropic server tool when the model opts in", () => {
    const result = applyHostedSearchReplay(
      { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] },
      [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      { ...anthropicModel, webSearch: true },
    );
    expect(result.replayed).toBe(0);
    expect(result.payload).toMatchObject({
      tools: [{ type: "web_search_20250305", name: "web_search" }],
    });
  });

  it("leaves the body alone when the model did not opt in and nothing replays", () => {
    const payload = { messages: [{ role: "user", content: [] }] };
    const result = applyHostedSearchReplay(payload, [{ role: "user", content: [] }], anthropicModel);
    expect(result.payload).toBe(payload);
  });

  it("replays a stored pair onto the assistant message that carried it", () => {
    const context = [
      { role: "user", content: [{ type: "text", text: "search" }] },
      storedAssistant(
        [
          { type: "hostedSearch", phase: "server_tool_use", blockId: "b1", name: "web_search", input: { query: "q" } },
          { type: "hostedSearch", phase: "web_search_tool_result", blockId: "b1", wire: { type: "web_search_tool_result", tool_use_id: "b1", content: [] } },
        ],
        [{ type: "text", text: "searching" }],
      ),
      { role: "user", content: [{ type: "text", text: "follow up" }] },
    ];
    // The adapter kept the text block and dropped the search blocks.
    const payload = {
      messages: [
        { role: "user", content: [{ type: "text", text: "search" }] },
        { role: "assistant", content: [{ type: "text", text: "searching" }] },
        { role: "user", content: [{ type: "text", text: "follow up" }] },
      ],
    };
    const result = applyHostedSearchReplay(payload, context, anthropicModel);
    expect(result.diagnostic).toBeUndefined();
    expect(result.replayed).toBe(2);
    const assistant = (result.payload as { messages: { role: string; content: unknown[] }[] }).messages[1];
    expect(assistant?.content.map((block) => (block as { type: string }).type)).toEqual([
      "text",
      "server_tool_use",
      "web_search_tool_result",
    ]);
  });

  it("skips replay entirely when the request body does not match the plan", () => {
    const context = [
      storedAssistant([
        { type: "hostedSearch", phase: "server_tool_use", blockId: "b1", name: "web_search", input: {} },
      ], [{ type: "text", text: "x" }]),
    ];
    // A body the plan does not predict: no assistant message at all.
    const payload = { messages: [{ role: "user", content: [] }] };
    const result = applyHostedSearchReplay(payload, context, anthropicModel);
    expect(result.diagnostic).toEqual({ reason: "plan-mismatch", expected: 1, actual: 0 });
    expect(result.replayed).toBe(0);
    expect(result.payload).toBe(payload);
  });

  it("attaches the Responses tool and its sources include", () => {
    const result = applyHostedSearchReplay(
      { messages: [] },
      [],
      { ...responsesModel, webSearch: true },
    );
    expect(result.payload).toMatchObject({
      tools: [{ type: "web_search" }],
      include: ["web_search_call.action.sources"],
    });
  });
});