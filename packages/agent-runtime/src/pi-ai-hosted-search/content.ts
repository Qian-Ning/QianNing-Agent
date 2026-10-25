/**
 * Hosted web search content: validation, normalization, and wire projection.
 *
 * This logic used to live inside pi-ai as a patch, because the adapters were
 * the only place that saw the provider's `server_tool_use` /
 * `web_search_tool_result` blocks and the only place that could put them back
 * on the wire. pi-ai offers two observation hooks, so both halves now live
 * here instead:
 *
 *   capture.ts  reads raw provider events through `onProviderStreamEvent`
 *   payload.ts  rebuilds the request through `onPayload`
 *
 * Keeping the types and the projection in this package means the persisted
 * shape, the replay shape, and the validation rules have one owner that does
 * not move when the kernel does.
 *
 * Nothing here copies search results or credentials into messages or logs: the
 * validation failures carry a fixed phase string and keep the original value on
 * `cause`, matching the reader in `local-request-errors.ts`.
 */

/** A JSON value, matching the kernel's `JsonValue` so blocks stay assignable. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** A JSON object, matching the kernel's `JsonObject`. */
export type JsonObject = { [key: string]: JsonValue };

/**
 * One provider search block, as it travels in a model context.
 *
 * A discriminated union rather than one flat record: each phase carries
 * different required fields, and the adapters that consume this type narrow on
 * `phase`. `blockId` is required because a block without a provider id cannot be
 * replayed — the provider matches the result to the call by that id.
 *
 * The shape matches the kernel's `HostedSearchContent` field for field, so a
 * block built here can be handed to pi-ai without a cast. `inputJson` and `index`
 * are this package's own streaming scratch and are removed before a block is
 * stored.
 */
export type HostedSearchContent =
  | HostedSearchServerToolUse
  | HostedSearchToolResult
  | HostedSearchCall;

export type HostedSearchServerToolUse = {
  type: "hostedSearch";
  phase: "server_tool_use";
  blockId: string;
  /** The server tool name, e.g. `web_search`. */
  name: string;
  /** The parsed tool input. */
  input: JsonObject;
  /** The raw streaming JSON, while the input is still arriving. */
  inputJson?: string;
  /** Set while streaming, dropped when the block closes. */
  index?: number;
};

export type HostedSearchToolResult = {
  type: "hostedSearch";
  phase: "web_search_tool_result";
  blockId: string;
  /** Whether the provider reported a failed search. */
  isError?: boolean;
  /** The provider block, kept verbatim for replay. */
  wire: JsonObject;
  index?: number;
};

export type HostedSearchCall = {
  type: "hostedSearch";
  phase: "web_search_call";
  blockId: string;
  /** The provider's status string. */
  status?: string;
  /** The provider item, kept verbatim for replay. */
  wire?: JsonObject;
  index?: number;
};

export type HostedSearchPhase = HostedSearchContent["phase"];

export type HostedSearchReplayOptions = {
  /** The target adapter; a block only replays on the API that produced it. */
  api: string;
  /** False when the transcript crossed models, which invalidates provider-side blocks. */
  isSameModel?: boolean;
};

/**
 * Fixed descriptions only. A validation failure must be diagnosable without
 * echoing the value that failed — that value is model context, and on a bad
 * turn it can contain prompt or credential material.
 */
export const LOCAL_REQUEST_MESSAGES = {
  "context-validation": "Local request context validation failed",
  "context-estimation": "Local request context estimation failed",
  "request-preparation": "Local request preparation failed",
} as const;

export type LocalRequestErrorPhase = keyof typeof LOCAL_REQUEST_MESSAGES;

/**
 * Marks a failure as ours rather than the provider's. The explicit code is what
 * makes the error identifiable across packages and realms; wording and
 * constructor names are never used to infer origin.
 */
export class LocalRequestError extends Error {
  readonly code = "LOCAL_REQUEST_ERROR" as const;

  readonly phase: LocalRequestErrorPhase;

  constructor(phase: LocalRequestErrorPhase, options?: ErrorOptions) {
    super(LOCAL_REQUEST_MESSAGES[phase], options);
    this.name = "LocalRequestError";
    this.phase = phase;
  }
}

export type LocalRequestErrorDetails = {
  code: "LOCAL_REQUEST_ERROR";
  phase: LocalRequestErrorPhase;
  message: string;
  causeName?: string;
};

/** Read our own marker back off an error, accepting nothing but code plus phase. */
export function localRequestErrorDetails(
  error: unknown,
): LocalRequestErrorDetails | undefined {
  if (
    !error ||
    typeof error !== "object" ||
    (error as { code?: unknown }).code !== "LOCAL_REQUEST_ERROR" ||
    !Object.hasOwn(LOCAL_REQUEST_MESSAGES, (error as { phase?: unknown }).phase as string)
  ) {
    return undefined;
  }
  const { phase, cause, causeName } = error as {
    phase: LocalRequestErrorPhase;
    cause?: unknown;
    causeName?: unknown;
  };
  return {
    code: "LOCAL_REQUEST_ERROR",
    phase,
    message: LOCAL_REQUEST_MESSAGES[phase],
    ...(cause instanceof Error
      ? { causeName: cause.name }
      : typeof causeName === "string"
        ? { causeName }
        : {}),
  };
}

/** Re-wrap an arbitrary throw as ours, unless it already is. */
export function asLocalRequestError(
  error: unknown,
  phase: LocalRequestErrorPhase,
): unknown {
  return localRequestErrorDetails(error) ? error : new LocalRequestError(phase, { cause: error });
}

/** Run a preparation step, attributing any throw to a local phase. */
export function prepareLocalRequest<T>(
  phase: LocalRequestErrorPhase,
  prepare: () => T,
): T {
  try {
    return prepare();
  } catch (error) {
    throw asLocalRequestError(error, phase);
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function requireValid(valid: unknown): asserts valid {
  if (!valid) throw new LocalRequestError("context-validation");
}

/**
 * Reject anything JSON cannot carry: non-finite numbers, cycles, and objects
 * with a prototype that a serializer would treat as a class instance. A provider
 * block is replayed verbatim, so a value that would not survive JSON has no
 * business in the context in the first place.
 */
function validateJson(value: unknown, ancestors = new Set<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    requireValid(Number.isFinite(value));
    return;
  }
  requireValid(typeof value === "object" && !ancestors.has(value as object));
  const obj = value as object;
  requireValid(
    Array.isArray(obj) ||
      Object.getPrototypeOf(obj) === Object.prototype ||
      Object.getPrototypeOf(obj) === null,
  );
  ancestors.add(obj);
  for (const entry of Object.values(obj)) validateJson(entry, ancestors);
  ancestors.delete(obj);
}

/**
 * Validate and normalize a persisted or captured search block without
 * manufacturing tool-call fields it never had.
 *
 * A legacy record may predate an id (a gateway dropped it) or carry a shape the
 * provider has since changed; the checks below are the boundary that decides
 * whether such a record is still replayable.
 */
export function normalizeHostedSearchContent(value: unknown): HostedSearchContent {
  return prepareLocalRequest("context-validation", () => {
    const block = record(value);
    requireValid(block && block.type === "hostedSearch");
    const wire = block.wire;
    requireValid(wire == null || record(wire));
    const wireRecord = record(wire);
    const blockId =
      (nonempty(block.blockId) ? block.blockId : undefined) ??
      (nonempty(wireRecord?.id) ? wireRecord.id : undefined) ??
      (nonempty(wireRecord?.tool_use_id) ? wireRecord.tool_use_id : undefined);
    requireValid(nonempty(blockId));

    switch (block.phase) {
      case "server_tool_use": {
        requireValid(nonempty(block.name));
        const input = block.input ?? {};
        requireValid(record(input) !== undefined);
        validateJson(input);
        return {
          type: "hostedSearch",
          phase: "server_tool_use",
          blockId,
          name: block.name,
          input: input as JsonObject,
        };
      }
      case "web_search_tool_result": {
        requireValid(wireRecord !== undefined);
        requireValid(
          wireRecord.type === undefined ||
            wireRecord.type === "web_search_tool_result" ||
            wireRecord.type === "web_search_tool_result_error",
        );
        requireValid(wireRecord.tool_use_id === undefined || nonempty(wireRecord.tool_use_id));
        requireValid(wireRecord.content !== undefined);
        requireValid(block.isError === undefined || typeof block.isError === "boolean");
        validateJson(wire);
        return {
          type: "hostedSearch",
          phase: "web_search_tool_result",
          blockId,
          isError:
            (block.isError as boolean | undefined) ??
            wireRecord.type === "web_search_tool_result_error",
          wire: wireRecord as JsonObject,
        };
      }
      case "web_search_call": {
        if (wireRecord != null) {
          requireValid(wireRecord.type === "web_search_call" && nonempty(wireRecord.id));
          validateJson(wireRecord);
        }
        requireValid(block.status === undefined || typeof block.status === "string");
        return {
          type: "hostedSearch",
          phase: "web_search_call",
          blockId,
          ...(typeof block.status === "string" ? { status: block.status } : {}),
          ...(wireRecord !== undefined ? { wire: wireRecord as JsonObject } : {}),
        };
      }
      default:
        throw new LocalRequestError("context-validation");
    }
  });
}

/**
 * The exact provider block to replay, or undefined when this target does not
 * replay it.
 *
 * One projection serves both estimation and replay, so a search round is never
 * counted twice as wire data plus display summary. Without a target API the
 * projection stays conservative; with one it preserves the adapter's own model
 * boundary, which is why a block produced by Anthropic never replays onto a
 * Responses endpoint.
 */
export function hostedSearchReplayProjection(
  value: unknown,
  options?: HostedSearchReplayOptions,
): Record<string, unknown> | undefined {
  const block = normalizeHostedSearchContent(value);
  const api =
    options?.api ??
    (block.phase === "web_search_call" ? "openai-responses" : "anthropic-messages");

  if (block.phase === "web_search_call") {
    if (
      (api !== "openai-responses" &&
        api !== "azure-openai-responses" &&
        api !== "openai-codex-responses") ||
      options?.isSameModel === false
    ) {
      return undefined;
    }
    const wire = record(block.wire);
    return { ...(wire ?? { type: "web_search_call", id: block.blockId, status: "completed" }) };
  }

  if (api !== "anthropic-messages") return undefined;

  if (block.phase === "server_tool_use") {
    return {
      type: "server_tool_use",
      id: block.blockId,
      name: block.name,
      input: block.input,
    };
  }

  const wire = record(block.wire) ?? {};
  const { type: _type, ...rest } = wire;
  return {
    type: block.isError ? "web_search_tool_result_error" : "web_search_tool_result",
    tool_use_id: block.blockId,
    ...rest,
  };
}

/** An assistant content block as the model context carries it. */
type ContextBlock = { type?: unknown; [key: string]: unknown };

type ContextMessage = {
  role?: unknown;
  content?: unknown;
};

/**
 * Walk a context and validate every block on paths this package owns.
 *
 * Runs before a request is prepared, so a corrupt transcript fails as one clear
 * local error instead of as a provider 400 partway through a paid call. Blocks
 * of other types are checked only for the shape their own adapter requires.
 */
export function validateHostedSearchMessages(
  messages: readonly ContextMessage[],
): void {
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    requireValid(Array.isArray(message.content));
    for (const raw of message.content as ContextBlock[]) {
      requireValid(record(raw) !== undefined);
      switch (raw.type) {
        case "hostedSearch":
          normalizeHostedSearchContent(raw);
          break;
        case "text":
          requireValid(typeof raw.text === "string");
          break;
        case "thinking":
          requireValid(typeof raw.thinking === "string");
          break;
        case "toolCall":
          requireValid(nonempty(raw.name) && nonempty(raw.id) && record(raw.arguments));
          validateJson(raw.arguments);
          break;
        default:
          throw new LocalRequestError("context-validation");
      }
    }
  }
}