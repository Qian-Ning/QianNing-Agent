/**
 * Puts the originals back into a provider response.
 *
 * The reply arrives as a stream of snapshots: a `text_delta` carries the
 * increment, and every event also carries the message accumulated so far. Both
 * need rewriting — an increment can split a token across two events, while a
 * snapshot is always complete text and can be replaced outright.
 *
 * Tool-call arguments are skipped at the delta level on purpose: the increment
 * is raw JSON text, and a restored secret could contain a quote that breaks the
 * document. The parsed arguments are restored once, at `toolcall_end`.
 */
import type {
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Model,
  ToolCall,
} from "@earendil-works/pi-ai";
import { RestoreWindow } from "./restore-window.js";
import type { MappingStore } from "./store.js";
import { restoreText, restoreValue } from "./walk.js";

function restoreMessage(message: AssistantMessage, store: MappingStore): AssistantMessage {
  const content = message.content.map((block) => {
    if (block.type === "text") return { ...block, text: restoreText(block.text, store) };
    if (block.type === "thinking") return { ...block, thinking: restoreText(block.thinking, store) };
    if (block.type === "toolCall") {
      return { ...block, arguments: restoreValue(block.arguments, store) as ToolCall["arguments"] };
    }
    return block;
  });
  return { ...message, content };
}

type DeltaEvent = Extract<AssistantMessageEvent, { delta: string }>;

function restoreDelta(
  event: DeltaEvent,
  store: MappingStore,
  windows: Map<string, RestoreWindow>,
): AssistantMessageEvent {
  const key = `${event.type}:${event.contentIndex}`;
  let window = windows.get(key);
  if (!window) {
    window = new RestoreWindow(store);
    windows.set(key, window);
  }
  return { ...event, delta: window.push(event.delta), partial: restoreMessage(event.partial, store) };
}

function restoreEvent(
  event: AssistantMessageEvent,
  store: MappingStore,
  windows: Map<string, RestoreWindow>,
): AssistantMessageEvent {
  switch (event.type) {
    case "text_delta":
    case "thinking_delta":
      return restoreDelta(event, store, windows);
    case "text_end":
    case "thinking_end":
      windows.delete(`${event.type.replace("_end", "_delta")}:${event.contentIndex}`);
      return { ...event, content: restoreText(event.content, store), partial: restoreMessage(event.partial, store) };
    case "toolcall_end":
      return {
        ...event,
        toolCall: { ...event.toolCall, arguments: restoreValue(event.toolCall.arguments, store) as ToolCall["arguments"] },
        partial: restoreMessage(event.partial, store),
      };
    case "done":
      return { ...event, message: restoreMessage(event.message, store) };
    case "error":
      return { ...event, error: restoreMessage(event.error, store) };
    default:
      return { ...event, partial: restoreMessage(event.partial, store) };
  }
}

async function* restoreEvents(
  stream: AsyncIterable<AssistantMessageEvent>,
  store: MappingStore,
): AsyncGenerator<AssistantMessageEvent> {
  const windows = new Map<string, RestoreWindow>();
  for await (const event of stream) yield restoreEvent(event, store, windows);
}

/**
 * A view of one response stream with the placeholders replaced.
 *
 * Everything else about the stream — `result()`, completion, error propagation —
 * is forwarded to the original, so the agent loop sees a normal stream.
 */
export function restoreStream(stream: AssistantMessageEventStream, store: MappingStore): AssistantMessageEventStream {
  return new Proxy(stream, {
    get(target, property) {
      if (property === Symbol.asyncIterator) return () => restoreEvents(target, store);
      if (property === "result") return async () => restoreMessage((await target.result()) as AssistantMessage, store);
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** Restore a settled message; exported for callers that hold one without a stream. */
export { restoreMessage };

/** Payload type kept narrow so the installer can type its `onPayload` hook. */
export type PayloadHook = (payload: unknown, model: Model<never>) => unknown | Promise<unknown>;
