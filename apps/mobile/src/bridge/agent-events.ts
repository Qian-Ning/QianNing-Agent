/**
 * The phone host speaks in items; the desktop interface speaks in agent events.
 *
 * `LocalAgentHost` emits `{ sessionId, turnId, kind, payload }` (ADR 0335).
 * The desktop renderer subscribes to `pi-desktop/agent/event/message` and expects
 * `{ sessionId, turnId, ts, event: AgentEvent }`, where `AgentEvent` is the pi
 * runtime's own vocabulary (`message_start`, `message_update`, `message_end`, …).
 *
 * This file is that translation and nothing else: pure, no I/O, so the shapes can
 * be checked without a phone in hand. A kind it does not know is dropped instead
 * of being invented into something plausible.
 */

export type LocalEvent = {
  sessionId: string;
  turnId?: string;
  kind: string;
  payload?: unknown;
};

export type DesktopEnvelope = {
  sessionId: string;
  turnId?: string;
  ts: number;
  event: Record<string, unknown>;
};

type ItemPayload = {
  itemType?: string;
  itemId?: string;
  event?: {
    deltaText?: string;
    deltaThinking?: string;
    message?: {
      role?: string;
      content?: Array<{ type?: string; text?: string }>;
    };
  };
};

/** The visible text of an item's message, in the order the model produced it. */
export function messageText(payload: ItemPayload | undefined): string {
  const content = payload?.event?.message?.content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (part?.type === "text" ? (part.text ?? "") : "")).join("");
}

export function messageRole(payload: ItemPayload | undefined): string {
  return payload?.event?.message?.role ?? "assistant";
}

/**
 * One local event in, zero or more desktop envelopes out.
 *
 * `now` is injected so tests do not depend on the wall clock; the bridge passes
 * `Date.now`.
 */
export function toDesktopEvents(local: LocalEvent, now: number): DesktopEnvelope[] {
  const payload = local.payload as ItemPayload | undefined;
  const base = { sessionId: local.sessionId, turnId: local.turnId, ts: now };
  const make = (event: Record<string, unknown>): DesktopEnvelope => ({ ...base, event });

  switch (local.kind) {
    case "permission.requested": {
      // The renderer's PermissionCard is driven by this event; without the
      // translation a gated tool would wait for an answer nobody could give.
      const request = (payload as { request?: unknown } | undefined)?.request;
      return request ? [make({ type: "tool_permission_request", request })] : [];
    }

    case "turn.started":
      return [make({ type: "agent_start" }), make({ type: "turn_start" })];

    case "item.started":
      // A tool row is a different shape; only messages are translated for now.
      if (payload?.itemType !== "message" || !payload.itemId) return [];
      if (messageRole(payload) !== "assistant") return [];
      return [
        make({
          type: "message_start",
          message: {
            id: payload.itemId,
            role: "assistant",
            content: "",
            createdAt: new Date(now).toISOString(),
            status: "streaming",
          },
        }),
      ];

    case "item.delta": {
      if (payload?.itemType !== "message" || !payload.itemId) return [];
      if (!payload.event?.deltaText && !payload.event?.deltaThinking) return [];
      return [
        make({
          type: "message_update",
          message: {
            id: payload.itemId,
            role: "assistant",
            content: "",
            createdAt: new Date(now).toISOString(),
          },
          deltaText: payload.event.deltaText ?? "",
          deltaThinking: payload.event.deltaThinking ?? "",
          stream: "delta",
        }),
      ];
    }

    case "item.completed": {
      if (payload?.itemType !== "message" || !payload.itemId) return [];
      const role = messageRole(payload);
      if (role !== "assistant") return [];
      return [
        make({
          type: "message_end",
          message: {
            id: payload.itemId,
            role: "assistant",
            content: messageText(payload),
            createdAt: new Date(now).toISOString(),
            status: "complete",
          },
        }),
      ];
    }

    case "turn.completed":
      return [make({ type: "turn_end" }), make({ type: "agent_end", messageIds: [] })];

    case "turn.failed": {
      const message = (local.payload as { message?: string } | undefined)?.message ?? "the turn failed";
      return [
        make({ type: "error", error: { code: "AGENT_TURN_FAILED", message } }),
        make({ type: "turn_end" }),
      ];
    }

    default:
      return [];
  }
}
