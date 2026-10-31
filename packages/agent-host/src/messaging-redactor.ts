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
 * The kinds a process card is built from (ADR 0340): the turn opening, so the
 * card can exist while the work is still running, and a tool step, so it can
 * say what the agent is doing. These are forwarded only when the card is
 * enabled for the channel — an install that never asked for a card is not
 * charged for one, and no payload field is read on its behalf.
 */
export const CARD_EVENT_KINDS: readonly RacpEventKind[] = ["turn.started", "tool.progress"];

/**
 * How much of a card's note survives the boundary. The note is the only field
 * on the card that can carry words a user wrote, so it is cut at the source
 * rather than trusted to be short.
 */
export const CARD_NOTE_LIMIT = 120;

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
  // The three card fields (ADR 0340). They are the only values on a summary
  // that come from an envelope payload, they are read one key at a time, and
  // each is cut to CARD_NOTE_LIMIT before it can cross the boundary.
  phase?: string;
  tool?: string;
  note?: string;
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
  if (kind === "turn.started") return "running";
  return undefined;
}

/** Whether this kind is forwarded at all, with the card switched on or off. */
export function isForwardedKindFor(kind: RacpEventKind, cards: boolean): boolean {
  if (isForwardedKind(kind)) return true;
  return cards && CARD_EVENT_KINDS.includes(kind);
}

/**
 * One card field, read from a payload key and cut to length.
 *
 * Only a string counts. Anything else — a number, an object, a tool result
 * blob — is dropped rather than stringified, because stringifying is how a
 * payload leaks wholesale.
 */
type CardFields = Pick<MessageDeliverySummary, "phase" | "tool" | "note">;

function cardField(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  if (trimmed.length <= CARD_NOTE_LIMIT) return trimmed;
  return `${trimmed.slice(0, CARD_NOTE_LIMIT - 1)}…`;
}

/**
 * Project one envelope onto its redacted summary, or `null` for a kind the
 * integration does not forward.
 *
 * Only the envelope's own structure and metadata are read. `envelope.payload`
 * is never touched, so no transcript text can cross this boundary.
 */
export function summarizeEvent(
  envelope: RacpEventEnvelope,
  options: { cards?: boolean } = {},
): MessageDeliverySummary | null {
  const cards = options.cards === true;
  if (!isForwardedKindFor(envelope.kind, cards)) return null;
  const status = statusForKind(envelope.kind);
  const card = cards && CARD_EVENT_KINDS.includes(envelope.kind) ? cardFields(envelope) : {};
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
    ...card,
    ...(envelope.agentName !== undefined ? { agentName: envelope.agentName } : {}),
    occurredAt: envelope.occurredAt,
  };
}

/**
 * The card fields of one event, or nothing.
 *
 * This is the one place a payload is consulted, and it stays narrow on purpose:
 * three named keys, strings only, each cut to length. Tool arguments, tool
 * results, and message text are not among the keys and cannot arrive by
 * accident.
 */
function cardFields(envelope: RacpEventEnvelope): CardFields {
  const payload: unknown = envelope.payload;
  if (typeof payload !== "object" || payload === null) return {};
  const source = payload as Record<string, unknown>;
  const phase = cardField(source["phase"]);
  const tool = cardField(source["tool"]);
  const note = cardField(source["note"]);
  return {
    ...(phase !== undefined ? { phase } : {}),
    ...(tool !== undefined ? { tool } : {}),
    ...(note !== undefined ? { note } : {}),
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
 * The Host subscribes it: both composition roots start the subscription
 * (`createMessagingOutboundRelay` in `@pi-desktop/host-runtime`, called from
 * the desktop main process and from the headless `pi-host` entry point), gated
 * on the channel's own settings record and released at shutdown.
 */
export class MessagingRedactor implements SubscriptionSink {
  constructor(
    private readonly port: HostRpcPort,
    private readonly channel: string,
    private readonly onError: (error: unknown, envelope: RacpEventEnvelope) => void = () => {},
    /** Whether this channel shows a process card (ADR 0340). Off by default. */
    private readonly cards: boolean = false,
    /**
     * Where a card event goes when this channel has a card for it. Returning
     * `true` means the card took it; `false` — no card open for that turn —
     * leaves the event to be delivered the way it always has.
     */
    private readonly card: { absorb(summary: MessageDeliverySummary): boolean } | null = null,
  ) {}

  /** One event from the surface, as the surface's `deliver` receives it. */
  deliver(envelope: RacpEventEnvelope): void {
    const summary = summarizeEvent(envelope, { cards: this.cards });
    if (!summary) return;
    if (this.card?.absorb(summary) === true) return;
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
