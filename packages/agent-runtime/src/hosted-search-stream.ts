/**
 * Hosted web search as a provider-model decorator.
 *
 * pi-ai 1.4.0 has no hosted-search support: its adapters neither attach the
 * provider's server tool, keep the search blocks a response carries, nor replay
 * them on a later turn. `pi-ai-hosted-search` restores all three through the
 * public hooks, and this module installs them on a `Models` registry so every
 * consumer — the session runtime, one-shot completion, and subagents — gets the
 * same behaviour from the adapter call it already makes.
 *
 * Doing it here rather than in the session runtime matters: three of the four
 * call sites never touch the runtime's stream loop, and a search turn that went
 * through them would otherwise lose its grounding silently.
 */
import type { Api, AssistantMessage, AssistantMessageEventStream, Model, Models } from "@earendil-works/pi-ai";
import { createHostedSearchCapture, mergeCapturedContent } from "./pi-ai-hosted-search/capture.js";
import { applyHostedSearchReplay, type ReplayModel } from "./pi-ai-hosted-search/payload.js";

/** The subset of a context this decorator reads. */
type ContextLike = { messages?: readonly unknown[] };

function replayModelFor(model: Model<Api>): ReplayModel {
  const webSearch = (model as { webSearch?: boolean }).webSearch;
  return {
    id: model.id,
    api: model.api,
    provider: model.provider,
    ...(webSearch === true ? { webSearch: true } : {}),
  };
}

/**
 * Return a stream that behaves like the original, but hands the settled message
 * back with the search blocks the adapter dropped put in their place.
 *
 * `result()` can be awaited without draining the stream first, so the merge
 * happens there rather than on an iterator's return. A proxy keeps every other
 * member of the stream — including anything the agent loop uses — intact.
 */
function withCapturedBlocks(
  stream: AssistantMessageEventStream,
  capture: ReturnType<typeof createHostedSearchCapture>,
): AssistantMessageEventStream {
  return new Proxy(stream, {
    get(target, property, receiver) {
      if (property === "result") {
        return async () => {
          const message = (await target.result()) as AssistantMessage;
          if (!capture.sawSearch) return message;
          message.content = mergeCapturedContent(message.content, capture.blocks) as AssistantMessage["content"];
          if (capture.citations.length > 0) {
            (message as AssistantMessage & { hostedSearchCitations?: unknown }).hostedSearchCitations =
              capture.citations;
          }
          return message;
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/**
 * Install hosted search on a registry.
 *
 * The wrapper composes with any hooks the caller already set, so an extension's
 * `before_provider_request` still observes the body that is actually sent.
 */
export function installHostedSearch(models: Models): void {
  const streamSimple = models.streamSimple.bind(models);
  models.streamSimple = ((model: Model<Api>, context: ContextLike, options: Record<string, unknown> = {}) => {
    const capture = createHostedSearchCapture();
    const messages = (context.messages ?? []) as Parameters<typeof applyHostedSearchReplay>[1];
    const replayModel = replayModelFor(model);
    const previousPayload = options.onPayload as
      | ((payload: unknown, payloadModel: Model<Api>) => unknown)
      | undefined;
    const previousProviderEvent = options.onProviderStreamEvent as
      | ((data: unknown, providerModel: Model<Api>) => unknown)
      | undefined;

    const stream = streamSimple(model, context as never, {
      ...options,
      onPayload: async (payload: unknown, payloadModel: Model<Api>) => {
        const replaced = previousPayload ? await previousPayload(payload, payloadModel) : undefined;
        return applyHostedSearchReplay(replaced ?? payload, messages, replayModel).payload;
      },
      onProviderStreamEvent: async (data: unknown, providerModel: Model<Api>) => {
        capture.observe(data, replayModel.api);
        await previousProviderEvent?.(data, providerModel);
      },
    } as never);

    return withCapturedBlocks(stream, capture);
  }) as typeof models.streamSimple;
}
