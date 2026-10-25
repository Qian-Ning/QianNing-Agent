/**
 * Put captured search blocks back on the wire before a request is sent.
 *
 * Two jobs, both of which used to be patch hunks inside pi-ai's adapters:
 *
 *   1. attach the provider's server-side search tool when the model opts in
 *   2. replay each stored search block as the provider block it came from
 *
 * pi-ai's `onPayload` hook hands over the finished request body, so the tools
 * and the replayed blocks can be added without touching adapter code.
 *
 * ## Why replay has to be planned rather than patched in place
 *
 * The adapter drops block types it does not know, and a message left with no
 * blocks at all is dropped with them. By the time `onPayload` runs, the wire
 * body no longer shows where those blocks belonged, so this module computes the
 * insertion plan from the model context and then *checks the plan against the
 * body it actually received*. Objects in the body are matched by identity, so a
 * plan that does not line up means the adapter behaved in a way this module does
 * not model.
 *
 * When that happens the replay is skipped for the whole request and a
 * diagnostic is returned. That is deliberate: losing the search context makes a
 * follow-up turn less grounded, while guessing at a mismatched position would
 * put the provider's encrypted search payload in the wrong turn, which the
 * provider rejects or, worse, accepts with the wrong meaning. The caller
 * reports the diagnostic; nothing is logged from inside here, because a search
 * block can carry the user's query.
 */
import type { HostedSearchContent } from "./content.js";
import { validateHostedSearchMessages } from "./content.js";
import { hostedSearchReplayProjection } from "./content.js";

/** The subset of a model record this module needs. */
export type ReplayModel = {
  id: string;
  api: string;
  provider: string;
  /** Set by the catalog when the model can drive the provider's own search. */
  webSearch?: boolean;
};

type ContextBlock = { type?: unknown; [key: string]: unknown };

type ContextMessage = {
  role?: unknown;
  content?: unknown;
  api?: unknown;
  provider?: unknown;
  model?: unknown;
};

export type ReplayDiagnostic = {
  reason: "plan-mismatch";
  /** Context assistant messages that were expected to survive conversion. */
  expected: number;
  /** Assistant messages the request body actually carried. */
  actual: number;
};

export type ApplyReplayResult = {
  /** The request body to send; unchanged when nothing needed adding. */
  payload: unknown;
  diagnostic?: ReplayDiagnostic;
  /** How many blocks were replayed, for tests and diagnostics. */
  replayed: number;
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Whether the adapter keeps at least one block of this message.
 *
 * Mirrors the adapter's own filter: text and tool calls always survive, thinking
 * survives only when it is replayable for the target model (same model, or
 * carrying a signature / redaction, or having visible text). Anything else is
 * dropped, and an assistant message left with nothing is dropped as a whole.
 */
function assistantMessageSurvives(message: ContextMessage, model: ReplayModel): boolean {
  if (message.role !== "assistant") return true;
  if (!Array.isArray(message.content)) return false;

  const isSameModel =
    message.provider === model.provider &&
    message.api === model.api &&
    message.model === model.id;

  for (const raw of message.content as ContextBlock[]) {
    switch (raw.type) {
      case "text":
      case "toolCall":
        return true;
      case "thinking": {
        if (isSameModel) return true;
        if (raw.redacted === true) return true;
        if (typeof raw.thinkingSignature === "string" && raw.thinkingSignature.length > 0) return true;
        if (typeof raw.thinking === "string" && raw.thinking.trim() !== "") return true;
        break;
      }
      default:
        break;
    }
  }
  return false;
}

/** The search blocks stored on an assistant message, in order. */
function hostedSearchBlocks(message: ContextMessage): HostedSearchContent[] {
  if (message.role !== "assistant" || !Array.isArray(message.content)) return [];
  const blocks: HostedSearchContent[] = [];
  for (const raw of message.content as ContextBlock[]) {
    if (raw.type === "hostedSearch") blocks.push(raw as unknown as HostedSearchContent);
  }
  return blocks;
}

/**
 * Attach the provider's server-side search tool.
 *
 * The tool definition is provider-specific and is a bare tagged object: it never
 * passes through the adapter's own tool conversion, because the provider owns
 * the tool and the client never executes it.
 */
function attachSearchTool(
  payload: Record<string, unknown>,
  model: ReplayModel,
): { payload: Record<string, unknown>; changed: boolean } {
  if (model.webSearch !== true) return { payload, changed: false };

  const usesResponses =
    model.api === "openai-responses" ||
    model.api === "azure-openai-responses" ||
    model.api === "openai-codex-responses";

  const tool = usesResponses
    ? { type: "web_search" }
    : model.api === "anthropic-messages"
      ? { type: "web_search_20250305", name: "web_search" }
      : undefined;
  if (!tool) return { payload, changed: false };

  const tools = Array.isArray(payload.tools) ? payload.tools : [];
  const next: Record<string, unknown> = {
    ...payload,
    tools: [...tools, tool],
  };

  if (usesResponses) {
    // Search sources are opt-in, and share the include array with reasoning metadata.
    const include = Array.isArray(payload.include) ? payload.include : [];
    next.include = [...new Set([...include, "web_search_call.action.sources"])];
  }
  return { payload: next, changed: true };
}

/**
 * Add replayed search blocks to the request body.
 *
 * `messages` is the model context the request was built from. Assistant
 * messages that survive conversion are expected to appear in the body in the
 * same order; the plan is rejected outright when that does not hold.
 */
export function applyHostedSearchReplay(
  payload: unknown,
  messages: readonly ContextMessage[],
  model: ReplayModel,
): ApplyReplayResult {
  // A corrupt transcript must fail as one clear local error before the request
  // is built, not as a provider 400 partway through a paid call.
  validateHostedSearchMessages(messages);

  const body = record(payload);
  if (!body) return { payload, replayed: 0 };

  const withTool = attachSearchTool(body, model);
  const target = withTool.payload;

  // Which context messages carry search blocks, and which of those the adapter
  // is expected to keep.
  const wanted = messages
    .map((message, index) => ({
      index,
      blocks: hostedSearchBlocks(message),
      survives: assistantMessageSurvives(message, model),
    }))
    .filter((entry) => entry.blocks.length > 0);

  if (wanted.length === 0) {
    return {
      payload: withTool.changed ? target : payload,
      replayed: 0,
    };
  }

  // Anthropic sends `messages` with content blocks; the Responses APIs send an
  // `input` item list where a search call is its own item. Both are replayed,
  // but the block lands in a different place: appended to the assistant
  // message's content for one, inserted as a sibling item for the other.
  const wireKey = Array.isArray(target.messages)
    ? "messages"
    : Array.isArray(target.input)
      ? "input"
      : undefined;
  if (!wireKey) {
    // Nothing to patch and nothing to learn from; leave the request alone.
    return {
      payload: withTool.changed ? target : payload,
      replayed: 0,
      diagnostic: { reason: "plan-mismatch", expected: wanted.length, actual: 0 },
    };
  }
  const wire = (wireKey === "messages" ? target.messages : target.input) as unknown[];

  // Walk the body's assistant turns in order against the context's, counting
  // only those the plan expects to have survived.
  const assistantPositions: number[] = [];
  for (let i = 0; i < wire.length; i += 1) {
    const item = record(wire[i]);
    if (!item) continue;
    const isAssistantTurn =
      wireKey === "messages" ? item.role === "assistant" : item.type === "message" && item.role === "assistant";
    if (isAssistantTurn) assistantPositions.push(i);
  }

  const expected = messages
    .filter((message) => message.role === "assistant" && assistantMessageSurvives(message, model))
    .length;

  if (assistantPositions.length !== expected) {
    return {
      payload: withTool.changed ? target : payload,
      replayed: 0,
      diagnostic: {
        reason: "plan-mismatch",
        expected,
        actual: assistantPositions.length,
      },
    };
  }

  // Map each context assistant message onto its position in the body.
  let cursor = 0;
  const positionByContextIndex = new Map<number, number>();
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i]!;
    if (message.role !== "assistant") continue;
    if (!assistantMessageSurvives(message, model)) continue;
    const position = assistantPositions[cursor];
    if (position === undefined) break;
    positionByContextIndex.set(i, position);
    cursor += 1;
  }

  const projectedByPosition = new Map<number, Record<string, unknown>[]>();
  let replayed = 0;

  for (const entry of wanted) {
    const position = positionByContextIndex.get(entry.index);
    if (position === undefined) {
      // The adapter dropped this message, so there is no slot to extend. Leave it
      // out of the plan: an assistant message cannot be created from search
      // blocks alone, because the provider expects the turn that produced them.
      continue;
    }
    const projected = entry.blocks
      .map((block) =>
        hostedSearchReplayProjection(block, {
          api: model.api,
          // A provider's search payload is bound to the model that produced it;
          // replaying it after a model switch would send a token the new model
          // never issued.
          isSameModel:
            messages[entry.index]!.provider === model.provider &&
            messages[entry.index]!.api === model.api &&
            messages[entry.index]!.model === model.id,
        }),
      )
      .filter((projection): projection is Record<string, unknown> => projection !== undefined);
    if (projected.length === 0) continue;
    projectedByPosition.set(position, projected);
    replayed += projected.length;
  }

  if (replayed === 0 && !withTool.changed) {
    return { payload, replayed: 0 };
  }

  const nextWire: unknown[] = [];
  for (let i = 0; i < wire.length; i += 1) {
    const item = wire[i];
    const projected = projectedByPosition.get(i);
    if (!projected) {
      nextWire.push(item);
      continue;
    }
    if (wireKey === "input") {
      // A Responses search call is a sibling of the message that produced it.
      nextWire.push(item, ...projected);
      continue;
    }
    const message = record(item);
    const content = Array.isArray(message?.content) ? (message.content as unknown[]) : [];
    nextWire.push({ ...message, content: [...content, ...projected] });
  }

  return {
    payload: { ...target, [wireKey]: nextWire },
    replayed,
  };
}