/**
 * Capture hosted-search blocks out of a provider stream.
 *
 * pi-ai's adapters do not know `server_tool_use`, `web_search_tool_result`, or
 * `web_search_call`, so they drop those blocks while keeping everything else in
 * provider order. `onProviderStreamEvent` sees each raw provider event before
 * that filtering, which is enough to rebuild the blocks ourselves — but not
 * enough to place them, because the adapter's own content array no longer has
 * the gaps.
 *
 * So a block is captured together with the provider's content index, and
 * `mergeCapturedContent` later walks that index space: a captured block takes
 * its slot, and the surviving blocks fill the slots that are left, in order.
 * That reconstruction is exact because the adapter never reorders what it keeps.
 *
 * Only block shape and status are retained. Search results live in the wire
 * payload, which is replayed verbatim and never logged.
 */
import type {
  HostedSearchCall,
  HostedSearchContent,
  JsonObject,
} from "./content.js";

/**
 * Provider events arrive as parsed JSON, so the cast is a restatement of what
 * the wire already guarantees, not a widening of it.
 */
const asJsonObject = (value: Record<string, unknown>): JsonObject => value as JsonObject;

/** One captured block plus the provider slot it belongs in. */
export type CapturedBlock = {
  /** Provider content index (`event.index` / `event.output_index`). */
  index: number;
  block: HostedSearchContent;
};

export type HostedSearchCapture = {
  /** Blocks in provider order, each tagged with its provider content index. */
  blocks: CapturedBlock[];
  /** URL citations the provider attached while text streamed. */
  citations: { url: string; title?: string }[];
  /** True once anything search-shaped was seen, so callers can skip merging. */
  readonly sawSearch: boolean;
  /** Feed one raw provider event. Safe to call for every event. */
  observe(event: unknown, api: string): void;
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function indexOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/**
 * Parse a partially streamed JSON object.
 *
 * A search query arrives as `input_json_delta` fragments. Rendering the query
 * live is worth the attempt, but a fragment is not valid JSON until the last
 * one lands, so a failed parse keeps the previous value instead of throwing
 * mid-stream.
 */
function parseStreamingJson(text: string): unknown {
  if (text.trim() === "") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function createHostedSearchCapture(): HostedSearchCapture {
  const blocks: CapturedBlock[] = [];
  const citations: { url: string; title?: string }[] = [];
  // Streaming scratch, keyed by provider content index.
  const open = new Map<number, CapturedBlock>();

  const capture: HostedSearchCapture = {
    blocks,
    citations,
    get sawSearch() {
      return blocks.length > 0;
    },
    observe(event: unknown, api: string) {
      const e = record(event);
      if (!e || typeof e.type !== "string") return;
      if (api === "anthropic-messages") {
        observeAnthropic(e, blocks, citations, open);
      } else if (
        api === "openai-responses" ||
        api === "azure-openai-responses" ||
        api === "openai-codex-responses"
      ) {
        observeResponses(e, blocks, citations, open);
      }
    },
  };
  return capture;
}

function observeAnthropic(
  e: Record<string, unknown>,
  blocks: CapturedBlock[],
  citations: { url: string; title?: string }[],
  open: Map<number, CapturedBlock>,
): void {
  if (e.type === "content_block_start") {
    const index = indexOf(e.index);
    const contentBlock = record(e.content_block);
    if (index === undefined || !contentBlock) return;

    if (contentBlock.type === "server_tool_use") {
      // Without the provider id the result cannot be matched to the call, so
      // the block is unreplayable; capturing it would only create dead weight.
      if (typeof contentBlock.id !== "string" || contentBlock.id === "") return;
      if (typeof contentBlock.name !== "string" || contentBlock.name === "") return;
      const input = asJsonObject(record(contentBlock.input) ?? {});
      const block: HostedSearchContent = {
        type: "hostedSearch",
        phase: "server_tool_use",
        blockId: contentBlock.id,
        name: contentBlock.name,
        input,
        inputJson: "",
        index,
      };
      const entry = { index, block };
      blocks.push(entry);
      open.set(index, entry);
      return;
    }

    if (
      contentBlock.type === "web_search_tool_result" ||
      contentBlock.type === "web_search_tool_result_error"
    ) {
      if (typeof contentBlock.tool_use_id !== "string" || contentBlock.tool_use_id === "") return;
      const isError = contentBlock.type === "web_search_tool_result_error";
      const block: HostedSearchContent = {
        type: "hostedSearch",
        phase: "web_search_tool_result",
        blockId: contentBlock.tool_use_id,
        isError,
        // The raw block is the replay payload, so it is kept verbatim.
        wire: asJsonObject(contentBlock),
        index,
      };
      blocks.push({ index, block });
      open.set(index, { index, block });
    }
    return;
  }

  if (e.type === "content_block_delta") {
    const index = indexOf(e.index);
    const delta = record(e.delta);
    if (index === undefined || !delta) return;

    if (delta.type === "input_json_delta") {
      const entry = open.get(index);
      if (!entry || entry.block.phase !== "server_tool_use") return;
      const fragment = typeof delta.partial_json === "string" ? delta.partial_json : "";
      entry.block.inputJson = (entry.block.inputJson ?? "") + fragment;
      const parsed = parseStreamingJson(entry.block.inputJson);
      if (parsed != null) entry.block.input = parsed as JsonObject;
      return;
    }

    // Citations ride on the text block that follows a search result.
    if (delta.type === "citations_delta") {
      const citation = record(delta.citation);
      if (!citation) return;
      // Document citations are not hosted-search URL citations.
      if (
        nonempty(citation.url) &&
        (citation.title === undefined || typeof citation.title === "string")
      ) {
        citations.push({
          url: citation.url,
          ...(typeof citation.title === "string" ? { title: citation.title } : {}),
        });
      }
    }
    return;
  }

  if (e.type === "content_block_stop") {
    const index = indexOf(e.index);
    if (index === undefined) return;
    const entry = open.get(index);
    if (!entry) return;
    // A closed block carries no streaming scratch; the wire payload is complete.
    if (entry.block.phase === "server_tool_use") delete entry.block.inputJson;
    delete entry.block.index;
    open.delete(index);
  }
}

function observeResponses(
  e: Record<string, unknown>,
  blocks: CapturedBlock[],
  citations: { url: string; title?: string }[],
  open: Map<number, CapturedBlock>,
): void {
  // A search call arrives as an output item, then status events update it, then
  // the done item replaces the wire payload with the server's final shape.
  if (e.type === "response.output_item.added" || e.type === "response.output_item.done") {
    const index = indexOf(e.output_index);
    const item = record(e.item);
    if (index === undefined || !item || item.type !== "web_search_call") return;
    // The item id is what replay matches on; a call without one cannot round-trip.
    if (typeof item.id !== "string" || item.id === "") return;

    const existing = open.get(index);
    if (existing) {
      if (existing.block.phase !== "web_search_call") return;
      existing.block.status = typeof item.status === "string" ? item.status : existing.block.status;
      existing.block.wire = asJsonObject(item);
      if (e.type === "response.output_item.done") open.delete(index);
      return;
    }

    const block: HostedSearchCall = {
      type: "hostedSearch",
      phase: "web_search_call",
      blockId: item.id,
      status: typeof item.status === "string" ? item.status : "in_progress",
      wire: asJsonObject(item),
    };
    const entry = { index, block };
    blocks.push(entry);
    if (e.type === "response.output_item.added") open.set(index, entry);
    return;
  }

  if (typeof e.type === "string" && e.type.startsWith("response.web_search_call.")) {
    const index = indexOf(e.output_index);
    const item = record(e.item) ?? record(e.output_item);
    if (index === undefined || !item || item.type !== "web_search_call") return;
    const existing = open.get(index);
    if (!existing || existing.block.phase !== "web_search_call") return;
    existing.block.status = typeof item.status === "string" ? item.status : existing.block.status;
    existing.block.wire = asJsonObject(item);
    return;
  }

  if (e.type === "response.output_text.annotation.added") {
    const annotation = record(e.annotation);
    if (!annotation || annotation.type !== "url_citation" || !nonempty(annotation.url)) return;
    citations.push({
      url: annotation.url,
      ...(typeof annotation.title === "string" ? { title: annotation.title } : {}),
    });
  }
}

/**
 * Put captured blocks back into the adapter's content array at their provider
 * positions.
 *
 * `surviving` is what the adapter kept, in provider order. Walking the provider
 * index space and consuming `surviving` only for slots no captured block claims
 * reconstructs the original order exactly — including a message whose every
 * block was search-shaped, which the adapter drops entirely.
 *
 * Returns the input array unchanged when nothing was captured, so the common
 * case allocates nothing.
 */
export function mergeCapturedContent<T extends { type?: unknown }>(
  surviving: readonly T[],
  captured: readonly CapturedBlock[],
): (T | HostedSearchContent)[] {
  if (captured.length === 0) return surviving as T[];

  const byIndex = new Map<number, HostedSearchContent>();
  for (const entry of captured) byIndex.set(entry.index, entry.block);

  const highest = Math.max(...captured.map((entry) => entry.index));
  const merged: (T | HostedSearchContent)[] = [];
  let next = 0;
  for (let slot = 0; slot <= highest; slot += 1) {
    const capturedBlock = byIndex.get(slot);
    if (capturedBlock) {
      merged.push(capturedBlock);
      continue;
    }
    const survivor = surviving[next];
    if (survivor !== undefined) {
      merged.push(survivor);
      next += 1;
    }
  }
  // Anything the adapter produced past the last captured slot keeps its place.
  for (; next < surviving.length; next += 1) merged.push(surviving[next] as T);
  return merged;
}