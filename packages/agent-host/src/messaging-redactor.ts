import type { RacpCursor, RacpEventEnvelope, RacpEventKind } from "@pi-desktop/shared";

import type { RacpError } from "./errors.js";
import type { SubscriptionSink } from "./event-log.js";
import type { HostRpcPort } from "./ports.js";

/**
 * The event kinds the outbound messaging integration forwards (ADR 0205 D375
 * item 9, rollout R3 §2): the two terminal turn outcomes and the two
 * host-owned requests a user may need to answer. Any other kind is summarised
 * nowhere and enqueued nowhere.
 */
export const FORWARDED_EVENT_KINDS: readonly RacpEventKind[] = [
  "turn.completed",
  "turn.failed",
  "approval.requested",
  "input.requested",
];

/**
 * The redacted summary of one forwarded event — structure and metadata only.
 *
 * It carries the envelope's identity (which event, which scope, which session
 * and turn, which epoch and sequence the event sits at) plus the terminal
 * status the kind denotes, the agent name, and when it occurred. It has no
 * member for message text, tool arguments, tool results, or file contents, and
 * none is ever copied from the envelope's payload: the payload is never read.
 */
export type MessageDeliverySummary = {
  eventId: string;
  kind: RacpEventKind;
  scope: "session" | "host";
  sessionId?: string;
  turnId?: string;
  epoch: string;
  sequence?: number;
  revision: number;
  status?: string;
  agentName?: string;
  occurredAt: string;
};

/** Whether the integration forwards this event kind. */
export function isForwardedKind(kind: RacpEventKind): boolean {
  return FORWARDED_EVENT_KINDS.includes(kind);
}

/**
 * The terminal status a terminal turn kind denotes, read from the kind alone so
 * no payload field has to be consulted.
 */
function statusForKind(kind: RacpEventKind): string | undefined {
  if (kind === "turn.completed") return "completed";
  if (kind === "turn.failed") return "failed";
  return undefined;
}

/**
 * Project one envelope onto its redacted summary, or `null` for a kind the
 * integration does not forward.
 *
 * Only the envelope's own structure and metadata are read. `envelope.payload`
 * is never touched, so no transcript text can cross this boundary.
 */
export function summarizeEvent(envelope: RacpEventEnvelope): MessageDeliverySummary | null {
  if (!isForwardedKind(envelope.kind)) return null;
  const status = statusForKind(envelope.kind);
  return {
    eventId: envelope.eventId,
    kind: envelope.kind,
    scope: envelope.scope,
    ...(envelope.sessionId !== undefined ? { sessionId: envelope.sessionId } : {}),
    ...(envelope.turnId !== undefined ? { turnId: envelope.turnId } : {}),
    epoch: envelope.epoch,
    ...(envelope.sequence !== undefined ? { sequence: envelope.sequence } : {}),
    revision: envelope.revision,
    ...(status !== undefined ? { status } : {}),
    ...(envelope.agentName !== undefined ? { agentName: envelope.agentName } : {}),
    occurredAt: envelope.occurredAt,
  };
}

/** The RPC verb the Host uses to hand a redacted summary to the ledger. */
export const MESSAGING_ENQUEUE_METHOD = "messaging.enqueue";

/**
 * The Host-side redactor: a subscriber on the module's own event surface.
 *
 * It implements the real [`SubscriptionSink`] contract, so the Host subscribes
 * it exactly like any other subscriber (`AgentHost.subscribe`), and the module
 * fans its events out to it. For each forwarded event it builds the redacted
 * summary and hands it to the durable delivery ledger over the existing stdio
 * NDJSON JSON-RPC channel, one `messaging.enqueue` call per delivery — the only
 * way anything enqueues. The retry, backoff and terminal behaviour of that
 * delivery belongs to the ledger on the far side of the call; this class keeps
 * no delivery state of its own.
 *
 * `deliver` returns `void` because the surface is fire-and-forget: the hand-off
 * is fired asynchronously and a failure to hand off is reported through
 * `onError` rather than swallowed, never thrown back into the publish loop.
 *
 * Forward API: the concrete outbound channel whose registration in host-core
 * makes an enqueue succeed, and the Host wiring that starts this subscription,
 * land with the channel milestone. The Host already reads the forwarded-kind
 * set ([`FORWARDED_EVENT_KINDS`]) so it can publish those kinds on the host-scope
 * surface, but the [`MessagingRedactor`] subscription itself is reached by its
 * tests only until the channel lands; drop this note when the Host subscribes it
 * (removal condition).
 */
export class MessagingRedactor implements SubscriptionSink {
  constructor(
    private readonly port: HostRpcPort,
    private readonly channel: string,
    private readonly onError: (error: unknown, envelope: RacpEventEnvelope) => void = () => {},
  ) {}

  /** One event from the surface, as the surface's `deliver` receives it. */
  deliver(envelope: RacpEventEnvelope): void {
    const summary = summarizeEvent(envelope);
    if (!summary) return;
    void this.port
      .call(MESSAGING_ENQUEUE_METHOD, { channel: this.channel, payload: summary })
      .catch((error: unknown) => this.onError(error, envelope));
  }

  /**
   * The surface closed the subscription. The redactor holds no buffer, socket,
   * or listener that survives a close, so there is nothing to release.
   */
  close(_error: RacpError, _lastSafeCursor: RacpCursor): void {}
}
