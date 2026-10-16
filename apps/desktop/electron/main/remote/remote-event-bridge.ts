/**
 * Event bridge: translate a paired host's RACP event stream into the local
 * renderer IPC events already consumed for a local session. The renderer
 * cannot tell the difference (spec §3.4); only the namespaced session id and
 * the `source: "remote"` badge distinguish a remote row.
 *
 * The bridge is pure translation: it forwards to an injected `emit(channel,
 * payload)` and calls an optional `onLifecycle` for host-scope `session.*`
 * kinds. It never touches the router, the connection, or persistence — the
 * connection layer (Stage 3) drives subscription and unsubscription.
 */
import { IPC } from "@pi-desktop/shared";
import type {
  AgentEvent,
  AgentEventEnvelope,
  AskToolRequest,
  PlanningStateEvent,
  RacpApprovalRequest,
  RacpEventEnvelope,
  RacpInputRequest,
  ToolPermissionRequest,
} from "@pi-desktop/shared";
import { makeRemoteApprovalRequestId, makeRemoteSessionId } from "./backend-router.js";

/** A minimal shape of the session field carried by host-scope session events.
 * Both the RACP `RacpSession` and the host's smaller `SessionSummary` extend
 * this — no field beyond these five is read by lifecycle handlers. */
export type RemoteEventSessionRef = {
  id: string;
  title?: string;
  createdAt?: string;
  updatedAt?: string;
};

export type RemoteLifecycleEvent =
  | { readonly kind: "session.created"; readonly hostSessionId: string; readonly remoteSessionId: string; readonly session: RemoteEventSessionRef }
  | { readonly kind: "session.changed"; readonly hostSessionId: string; readonly remoteSessionId: string; readonly session: RemoteEventSessionRef }
  | { readonly kind: "session.archived"; readonly hostSessionId: string; readonly remoteSessionId: string; readonly session?: RemoteEventSessionRef };

export type RemoteEventBridgeOptions = {
  /** Renderer-visible id prefix component. Fixed for one host. */
  hostKey: string;
  /** Dispatch a local IPC event to the renderer. */
  emit: (channel: string, payload: unknown) => void;
  /** Lifecycle callback for host-scope `session.*` kinds; drives the router. */
  onLifecycle?: (event: RemoteLifecycleEvent) => void;
  /**
   * Whether a renderer-visible session id is still registered on this
   * connection. Terminal kinds are *connection-local* and never enter the
   * replay log (spec §5.3), so a chunk that arrives for a session the router
   * has already released (a session switch, or a host disconnect racing an
   * in-flight frame) has no live surface to reach and is dropped rather than
   * delivered to a stale id. Absent means "no registration view" and every
   * terminal event is forwarded, which is what a bridge-only fixture wants.
   */
  isSessionActive?: (remoteSessionId: string) => boolean;
  /**
   * A `resync.required` event the Host raised (spec §8): the cursor the
   * desktop holds for that stream is invalid — the epoch changed or the replay
   * window evicted it — so the connection layer must refresh its state from a
   * snapshot instead of expecting the missing events. Carries the host session
   * id for a session-scope event; `null` for the host-scope stream, which has
   * no snapshot and is refreshed by re-listing sessions. Absent means the
   * event is dropped, which is the pre-Stage-3b behaviour a bridge-only
   * fixture keeps.
   */
  onResyncRequired?: (hostSessionId: string | null) => void;
  /** Optional structured warning log; defaults to a no-op. */
  log?: (level: "warn", message: string, data?: unknown) => void;
};

export interface RemoteEventBridge {
  /** Handle one RACP envelope. Unknown kinds are dropped. */
  handle(envelope: RacpEventEnvelope): void;
}

const APPROVAL_KIND = { tool: "tool", plan: "plan", goal: "goal" } as const;

/**
 * Kinds the outbound messaging integration forwards. They ride the session
 * stream AND, because that integration subscribes at host scope, the host
 * stream too. This bridge consumes them from the session stream alone
 * ({@link handleSessionScope}), so the host-scope copy must be dropped here:
 * it carries no session, and a session-bearing one would otherwise fall
 * through to the `session.archived` branch and unregister a live session.
 */
const HOST_SCOPE_FORWARDED_KINDS: ReadonlySet<string> = new Set([
  "turn.completed",
  "turn.failed",
  "approval.requested",
  "input.requested",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function extractSessionRef(payload: unknown): RemoteEventSessionRef | undefined {
  if (!isRecord(payload)) return undefined;
  const session = payload.session;
  if (!isRecord(session) || typeof session.id !== "string") return undefined;
  return {
    id: session.id,
    ...(typeof session.title === "string" ? { title: session.title } : {}),
    ...(typeof session.createdAt === "string" ? { createdAt: session.createdAt } : {}),
    ...(typeof session.updatedAt === "string" ? { updatedAt: session.updatedAt } : {}),
  };
}

function extractAgentEvent(payload: unknown): AgentEvent | undefined {
  if (!isRecord(payload)) return undefined;
  const event = payload.event;
  if (!isRecord(event) || typeof event.type !== "string") return undefined;
  return event as unknown as AgentEvent;
}

function extractApprovalRequest(payload: unknown): RacpApprovalRequest | undefined {
  if (!isRecord(payload)) return undefined;
  // The RACP schema publishes the approval request as the payload's own body,
  // not nested under `.approval`. Both agent-host emit sites and the fixture
  // in packages/racp use that shape.
  if (typeof payload.id !== "string" || typeof payload.kind !== "string") return undefined;
  return payload as unknown as RacpApprovalRequest;
}

function extractInputRequest(payload: unknown): RacpInputRequest | undefined {
  if (!isRecord(payload)) return undefined;
  if (typeof payload.id !== "string" || !Array.isArray(payload.questions)) return undefined;
  return payload as unknown as RacpInputRequest;
}

/** A `terminal.output` chunk: one base64 slice of the pty's byte stream. */
export type RemoteTerminalOutput = {
  readonly kind: "output";
  readonly terminalId: string;
  readonly data: string;
};

/** A `terminal.changed` transition; the Host currently emits `state: "exited"`. */
export type RemoteTerminalChanged = {
  readonly kind: "changed";
  readonly terminalId: string;
  readonly state: string;
  readonly code: number | null;
};

export type RemoteTerminalEvent = RemoteTerminalOutput | RemoteTerminalChanged;

/**
 * Read one terminal envelope payload. `terminal.output` carries
 * `{ terminalId, data }` with the data already base64 (operations.ts
 * `terminalEvent`); `terminal.changed` carries `{ terminalId, state, code }`.
 * Both are session-scoped and connection-local — they never enter the replay
 * log — so there are no cursor fields to translate. A payload that is not one
 * of those two shapes is dropped, exactly as an unknown kind is.
 */
export function extractTerminalEvent(
  kind: "terminal.output" | "terminal.changed",
  payload: unknown,
): RemoteTerminalEvent | null {
  if (!isRecord(payload) || typeof payload.terminalId !== "string") return null;
  if (kind === "terminal.output") {
    return typeof payload.data === "string"
      ? { kind: "output", terminalId: payload.terminalId, data: payload.data }
      : null;
  }
  return {
    kind: "changed",
    terminalId: payload.terminalId,
    state: typeof payload.state === "string" ? payload.state : "exited",
    code: typeof payload.code === "number" ? payload.code : null,
  };
}

function toToolPermissionRequest(
  remoteSessionId: string,
  approval: RacpApprovalRequest,
): ToolPermissionRequest {
  return {
    // Stateless approval id encoding — see backend-router.ts.
    requestId: makeRemoteApprovalRequestId(remoteSessionId, approval.id),
    sessionId: remoteSessionId,
    // RACP approvals do not carry a toolCallId back; the permission card does
    // not display it and only the resolution path needs the requestId.
    toolCallId: "",
    toolName: approval.toolName ?? "",
    argsPreview: null,
    risk: approval.risk ?? "medium",
    reason: approval.summary,
    ...(approval.agentName ? { agentName: approval.agentName } : {}),
    ...(approval.parentToolCallId ? { parentToolCallId: approval.parentToolCallId } : {}),
  };
}

function toAskToolRequest(
  remoteSessionId: string,
  input: RacpInputRequest,
): AskToolRequest {
  return {
    requestId: input.id,
    sessionId: remoteSessionId,
    // Ask-tool needs a toolCallId to attach the answer to; the RACP schema
    // supplies it as `parentToolCallId` when the input came from a subagent,
    // and leaves it undefined for the top-level agent.
    toolCallId: input.parentToolCallId ?? "",
    questions: input.questions.map((question) => ({
      question: question.question,
      options: question.options,
      multiSelect: question.multiSelect,
    })),
  };
}

function toPlanningStateAgentEvent(
  planning: PlanningStateEvent,
): AgentEvent {
  const { sessionId: _hostSessionId, ...rest } = planning;
  return { type: "planning_state", ...rest };
}

export function createRemoteEventBridge(options: RemoteEventBridgeOptions): RemoteEventBridge {
  const { hostKey, emit, onLifecycle, isSessionActive, onResyncRequired } = options;
  const log = options.log ?? (() => undefined);
  const remoteIdOf = (hostSessionId: string) => makeRemoteSessionId(hostKey, hostSessionId);
  const emitAgentEvent = (
    envelope: RacpEventEnvelope,
    remoteSessionId: string,
    event: AgentEvent,
  ): void => {
    const local: AgentEventEnvelope = {
      sessionId: remoteSessionId,
      ...(envelope.turnId ? { turnId: envelope.turnId } : {}),
      ts: Date.parse(envelope.occurredAt) || Date.now(),
      event,
      ...(envelope.parentToolCallId ? { parentToolCallId: envelope.parentToolCallId } : {}),
      ...(envelope.agentName ? { agentName: envelope.agentName } : {}),
    };
    emit(IPC.event.agentMessage, local);
  };

  const handleHostSession = (envelope: RacpEventEnvelope): void => {
    // Forwarded kinds also appear on the host stream but belong to the session
    // stream; ignore them here rather than warn or misroute them.
    if (HOST_SCOPE_FORWARDED_KINDS.has(envelope.kind)) return;
    // `resync.required` on the host stream carries no session: the host-scope
    // cursor is invalid for every session at once, and the connection refreshes
    // the whole host by re-listing rather than from a session snapshot.
    if (envelope.kind === "resync.required") {
      onResyncRequired?.(null);
      return;
    }
    const session = extractSessionRef(envelope.payload);
    if (!session) {
      log("warn", `host-scope ${envelope.kind} carried no session`, envelope);
      return;
    }
    const remoteSessionId = remoteIdOf(session.id);
    if (envelope.kind === "session.created") {
      onLifecycle?.({ kind: "session.created", hostSessionId: session.id, remoteSessionId, session });
      emit(IPC.event.sessionsChanged, {
        reason: "remote.session.created",
        selectSessionId: remoteSessionId,
      });
      return;
    }
    if (envelope.kind === "session.changed") {
      onLifecycle?.({ kind: "session.changed", hostSessionId: session.id, remoteSessionId, session });
      emit(IPC.event.sessionsChanged, { reason: "remote.session.changed" });
      return;
    }
    // "session.archived": pass through to the lifecycle handler for router
    // cleanup, then refresh the renderer's session list.
    onLifecycle?.({ kind: "session.archived", hostSessionId: session.id, remoteSessionId, session });
    emit(IPC.event.sessionsChanged, { reason: "remote.session.archived" });
  };

  const handleSessionScope = (envelope: RacpEventEnvelope): void => {
    if (typeof envelope.sessionId !== "string") return;
    const remoteSessionId = remoteIdOf(envelope.sessionId);
    switch (envelope.kind) {
      case "item.started":
      case "item.delta":
      case "item.completed":
      case "tool.progress":
      case "turn.queued":
      case "turn.started":
      case "turn.completed":
      case "turn.interrupted":
      case "turn.failed":
      case "turn.canceled":
      case "turn.activity": {
        const event = extractAgentEvent(envelope.payload);
        if (!event) return;
        emitAgentEvent(envelope, remoteSessionId, event);
        return;
      }
      case "session.changed": {
        // Two shapes ride this kind (agent-host):
        //   1. `{ event: PlanningStateEvent }` — surface as a local planning
        //      event so the plan card behaves the same as local.
        //   2. `{ sessionId, status, planningState }` — a periodic status
        //      refresh; the desktop derives its own status from turn events, so
        //      drop it and let the eventual snapshot refresh cover it.
        const payload = envelope.payload;
        if (isRecord(payload) && isRecord(payload.event) && payload.event.state !== undefined) {
          const planning = payload.event as unknown as PlanningStateEvent;
          emitAgentEvent(
            envelope,
            remoteSessionId,
            toPlanningStateAgentEvent(planning),
          );
        }
        return;
      }
      case "approval.requested": {
        const approval = extractApprovalRequest(envelope.payload);
        if (!approval) return;
        // Plan / goal approvals ride the following `planning_state` event; the
        // renderer's plan card is driven by that, not by a synthetic tool card.
        if (approval.kind !== APPROVAL_KIND.tool) return;
        emitAgentEvent(envelope, remoteSessionId, {
          type: "tool_permission_request",
          request: toToolPermissionRequest(remoteSessionId, approval),
        });
        return;
      }
      case "input.requested": {
        const input = extractInputRequest(envelope.payload);
        if (!input) return;
        emitAgentEvent(envelope, remoteSessionId, {
          type: "asktool_request",
          request: toAskToolRequest(remoteSessionId, input),
        });
        return;
      }
      case "terminal.output":
      case "terminal.changed": {
        // Terminal kinds are connection-local (spec §5.3): they stream to
        // whichever connection attached, keyed by the remote session id, and
        // never enter the replay log. A chunk for a session the router already
        // released has no live surface and is dropped so a session switch can
        // never paint one session's shell into another.
        if (isSessionActive && !isSessionActive(remoteSessionId)) {
          log("warn", `${envelope.kind} arrived for an unregistered session`, {
            remoteSessionId,
            terminalId: isRecord(envelope.payload) ? envelope.payload.terminalId : undefined,
          });
          return;
        }
        const terminal = extractTerminalEvent(envelope.kind, envelope.payload);
        if (!terminal) return;
        if (terminal.kind === "output") {
          emit(IPC.event.terminalOutput, {
            sessionId: remoteSessionId,
            terminalId: terminal.terminalId,
            data: terminal.data,
          });
          return;
        }
        emit(IPC.event.terminalChanged, {
          sessionId: remoteSessionId,
          terminalId: terminal.terminalId,
          state: terminal.state,
          code: terminal.code,
        });
        return;
      }
      case "approval.resolved":
      case "input.resolved":
        // Approvals settle through the renderer's own resolve call; the plan
        // and status changes come as `session.changed` payloads.
        return;
      case "resync.required": {
        // The Host raised this (spec §8): the cursor for this session's stream
        // is invalid, so the connection must refresh from a snapshot rather
        // than wait for events that will never be replayed.
        onResyncRequired?.(
          typeof envelope.sessionId === "string" ? envelope.sessionId : null,
        );
        return;
      }
      default:
        return;
    }
  };

  return {
    handle(envelope) {
      try {
        if (envelope.scope === "host") return handleHostSession(envelope);
        if (envelope.scope === "session") return handleSessionScope(envelope);
      } catch (error) {
        log("warn", `remote event bridge failed on ${envelope.kind}`, error);
      }
    },
  };
}
